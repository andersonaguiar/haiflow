import { Database } from "bun:sqlite";
import { readFileSync } from "fs";

// --- Durable task ledger ---
//
// A SQLite record of what every task actually DID: the ordered tool calls,
// commands run, files changed, real diffs, token usage, model, and timing.
// Mined from the Claude Code transcript the Stop hook already passes us.
//
// The DB lives under HAIFLOW_DATA_DIR alongside the file-based session state.
// Durability across reboots depends on HAIFLOW_DATA_DIR pointing somewhere
// persistent — the default /tmp/haiflow is wiped on reboot like the rest of
// haiflow's state.

export type TaskStatus =
  | "running"
  | "completed"
  | "timed_out"
  | "cancelled"
  | "failed";

export interface TaskUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  // Sum of all four — convenient for windowed rate accounting.
  totalTokens: number;
}

export interface TaskStep {
  seq: number;
  tool: string;
  summary: string;
  isError: boolean;
  // Optional rich detail kept small enough to store comfortably.
  detail?: string;
  filePath?: string;
}

export interface TaskRow {
  id: string;
  session: string;
  prompt: string | null;
  source: string | null;
  status: TaskStatus;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
  model: string | null;
  chain: string[];
  steps: TaskStep[];
  usage: TaskUsage | null;
  saved_usd: number | null;
  files_changed: string[];
  commands_run: string[];
  error: string | null;
}

const MAX_DETAIL = 4000;
const MAX_SUMMARY = 600;

let db: Database | null = null;

export function initLedger(baseDir: string): Database {
  const handle = new Database(`${baseDir}/haiflow.db`, { create: true });
  handle.exec("PRAGMA journal_mode = WAL;");
  handle.exec("PRAGMA busy_timeout = 4000;");
  handle.run(`
    CREATE TABLE IF NOT EXISTS tasks (
      id            TEXT PRIMARY KEY,
      session       TEXT NOT NULL,
      prompt        TEXT,
      source        TEXT,
      status        TEXT NOT NULL,
      started_at    TEXT,
      finished_at   TEXT,
      duration_ms   INTEGER,
      model         TEXT,
      chain         TEXT,
      steps         TEXT,
      usage         TEXT,
      saved_usd     REAL,
      files_changed TEXT,
      commands_run  TEXT,
      error         TEXT
    )
  `);
  handle.run(`CREATE INDEX IF NOT EXISTS idx_tasks_session ON tasks(session)`);
  handle.run(`CREATE INDEX IF NOT EXISTS idx_tasks_started ON tasks(started_at)`);
  handle.run(`CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)`);
  db = handle;
  return handle;
}

export function ledgerReady(): boolean {
  return db !== null;
}

export function recordTaskStart(opts: {
  id: string;
  session: string;
  prompt?: string;
  source?: string;
  chain?: string[];
}): void {
  if (!db) return;
  try {
    db.query(`
      INSERT INTO tasks (id, session, prompt, source, status, started_at, chain)
      VALUES ($id, $session, $prompt, $source, 'running', $started, $chain)
      ON CONFLICT(id) DO UPDATE SET
        session = excluded.session,
        prompt = excluded.prompt,
        source = excluded.source,
        status = 'running',
        started_at = excluded.started_at,
        chain = excluded.chain
    `).run({
      $id: opts.id,
      $session: opts.session,
      $prompt: opts.prompt ?? null,
      $source: opts.source ?? null,
      $started: new Date().toISOString(),
      $chain: JSON.stringify(opts.chain ?? []),
    });
  } catch {
    // Ledger is best-effort — never let it break the orchestrator.
  }
}

export function recordTaskFinish(opts: {
  id: string;
  session: string;
  status: TaskStatus;
  steps?: TaskStep[];
  usage?: TaskUsage | null;
  model?: string | null;
  savedUsd?: number | null;
  filesChanged?: string[];
  commandsRun?: string[];
  error?: string | null;
}): void {
  if (!db) return;
  try {
    const existing = db
      .query(`SELECT started_at FROM tasks WHERE id = $id AND session = $session`)
      .get({ $id: opts.id, $session: opts.session }) as { started_at?: string } | null;

    const finishedAt = new Date().toISOString();
    let durationMs: number | null = null;
    if (existing?.started_at) {
      const d = Date.parse(finishedAt) - Date.parse(existing.started_at);
      if (Number.isFinite(d) && d >= 0) durationMs = d;
    }

    db.query(`
      INSERT INTO tasks (
        id, session, status, finished_at, duration_ms, model,
        steps, usage, saved_usd, files_changed, commands_run, error
      ) VALUES (
        $id, $session, $status, $finished, $duration, $model,
        $steps, $usage, $saved, $files, $commands, $error
      )
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        finished_at = excluded.finished_at,
        duration_ms = COALESCE(excluded.duration_ms, tasks.duration_ms),
        model = COALESCE(excluded.model, tasks.model),
        steps = COALESCE(excluded.steps, tasks.steps),
        usage = COALESCE(excluded.usage, tasks.usage),
        saved_usd = COALESCE(excluded.saved_usd, tasks.saved_usd),
        files_changed = COALESCE(excluded.files_changed, tasks.files_changed),
        commands_run = COALESCE(excluded.commands_run, tasks.commands_run),
        error = COALESCE(excluded.error, tasks.error)
    `).run({
      $id: opts.id,
      $session: opts.session,
      $status: opts.status,
      $finished: finishedAt,
      $duration: durationMs,
      $model: opts.model ?? null,
      $steps: opts.steps ? JSON.stringify(opts.steps) : null,
      $usage: opts.usage ? JSON.stringify(opts.usage) : null,
      $saved: opts.savedUsd ?? null,
      $files: opts.filesChanged ? JSON.stringify(opts.filesChanged) : null,
      $commands: opts.commandsRun ? JSON.stringify(opts.commandsRun) : null,
      $error: opts.error ?? null,
    });
  } catch {
    // best-effort
  }
}

function parseRow(row: any): TaskRow {
  const safe = (s: string | null, fallback: any) => {
    if (!s) return fallback;
    try { return JSON.parse(s); } catch { return fallback; }
  };
  return {
    id: row.id,
    session: row.session,
    prompt: row.prompt ?? null,
    source: row.source ?? null,
    status: row.status,
    started_at: row.started_at ?? null,
    finished_at: row.finished_at ?? null,
    duration_ms: row.duration_ms ?? null,
    model: row.model ?? null,
    chain: safe(row.chain, []),
    steps: safe(row.steps, []),
    usage: safe(row.usage, null),
    saved_usd: row.saved_usd ?? null,
    files_changed: safe(row.files_changed, []),
    commands_run: safe(row.commands_run, []),
    error: row.error ?? null,
  };
}

export function queryTasks(filter: {
  session?: string;
  status?: string;
  source?: string;
  since?: string;
  until?: string;
  limit?: number;
  offset?: number;
}): { tasks: TaskRow[]; total: number } {
  if (!db) return { tasks: [], total: 0 };
  const where: string[] = [];
  const params: Record<string, string | number> = {};
  if (filter.session) { where.push("session = $session"); params.$session = filter.session; }
  if (filter.status) { where.push("status = $status"); params.$status = filter.status; }
  if (filter.source) { where.push("source = $source"); params.$source = filter.source; }
  if (filter.since) { where.push("started_at >= $since"); params.$since = filter.since; }
  if (filter.until) { where.push("started_at <= $until"); params.$until = filter.until; }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 500);
  const offset = Math.max(filter.offset ?? 0, 0);

  try {
    const total = (db.query(`SELECT COUNT(*) as n FROM tasks ${clause}`).get(params) as { n: number }).n;
    const rows = db
      .query(`SELECT * FROM tasks ${clause} ORDER BY started_at DESC LIMIT ${limit} OFFSET ${offset}`)
      .all(params) as any[];
    return { tasks: rows.map(parseRow), total };
  } catch {
    return { tasks: [], total: 0 };
  }
}

export function getTask(id: string, session?: string): TaskRow | null {
  if (!db) return null;
  try {
    const row = session
      ? db.query(`SELECT * FROM tasks WHERE id = $id AND session = $session`).get({ $id: id, $session: session })
      : db.query(`SELECT * FROM tasks WHERE id = $id`).get({ $id: id });
    return row ? parseRow(row) : null;
  } catch {
    return null;
  }
}

// Window of token usage for rolling rate accounting (used by the budget meter).
export function usageSince(sinceIso: string, session?: string): {
  tasks: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  savedUsd: number;
} {
  const empty = { tasks: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, savedUsd: 0 };
  if (!db) return empty;
  try {
    const clause = session ? "AND session = $session" : "";
    const params: Record<string, string> = { $since: sinceIso };
    if (session) params.$session = session;
    const rows = db
      .query(`SELECT usage, saved_usd FROM tasks WHERE finished_at >= $since AND usage IS NOT NULL ${clause}`)
      .all(params) as any[];
    const acc = { ...empty };
    for (const r of rows) {
      try {
        const u = JSON.parse(r.usage) as TaskUsage;
        acc.tasks += 1;
        acc.inputTokens += u.inputTokens ?? 0;
        acc.outputTokens += u.outputTokens ?? 0;
        acc.cacheCreationTokens += u.cacheCreationTokens ?? 0;
        acc.cacheReadTokens += u.cacheReadTokens ?? 0;
        acc.totalTokens += u.totalTokens ?? 0;
        acc.savedUsd += r.saved_usd ?? 0;
      } catch {}
    }
    return acc;
  } catch {
    return empty;
  }
}

// --- Transcript mining ---

interface TranscriptEntry {
  type?: string;
  timestamp?: string;
  message?: {
    role?: string;
    model?: string;
    content?: any;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
}

export interface ExtractResult {
  steps: TaskStep[];
  usage: TaskUsage | null;
  model: string | null;
  messages: string[];
  filesChanged: string[];
  commandsRun: string[];
}

function trim(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n… (+${s.length - max} chars truncated)`;
}

function miniDiff(oldStr: string, newStr: string): string {
  const minus = (oldStr ?? "").split("\n").map((l) => `- ${l}`).join("\n");
  const plus = (newStr ?? "").split("\n").map((l) => `+ ${l}`).join("\n");
  return trim(`${minus}\n${plus}`, MAX_DETAIL);
}

function summarizeTool(name: string, input: any): { summary: string; detail?: string; filePath?: string; command?: string } {
  if (!input || typeof input !== "object") {
    return { summary: name };
  }
  switch (name) {
    case "Bash": {
      const cmd = String(input.command ?? "");
      return { summary: trim(cmd, MAX_SUMMARY), detail: input.description ? String(input.description) : undefined, command: cmd };
    }
    case "Read":
    case "NotebookEdit":
      return { summary: String(input.file_path ?? input.notebook_path ?? name), filePath: input.file_path ?? input.notebook_path };
    case "Write":
      return { summary: `write ${input.file_path ?? ""}`.trim(), filePath: input.file_path, detail: input.content ? trim(String(input.content), MAX_DETAIL) : undefined };
    case "Edit":
      return {
        summary: `edit ${input.file_path ?? ""}`.trim(),
        filePath: input.file_path,
        detail: miniDiff(input.old_string ?? "", input.new_string ?? ""),
      };
    case "MultiEdit": {
      const edits = Array.isArray(input.edits) ? input.edits : [];
      const detail = edits.map((e: any) => miniDiff(e.old_string ?? "", e.new_string ?? "")).join("\n---\n");
      return { summary: `edit ${input.file_path ?? ""} (${edits.length} edits)`.trim(), filePath: input.file_path, detail: trim(detail, MAX_DETAIL) };
    }
    default: {
      let detail: string | undefined;
      try { detail = trim(JSON.stringify(input), MAX_SUMMARY); } catch {}
      return { summary: name, detail };
    }
  }
}

// Find the index of the user entry that initiated the current task — the last
// user-role entry that is a genuine prompt (string content or a text block),
// as opposed to a tool_result that Claude Code also encodes as a user entry.
function findTaskStartIndex(entries: TranscriptEntry[]): number {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (!e || e.type !== "user") continue;
    const content = e.message?.content;
    if (typeof content === "string") return i;
    if (Array.isArray(content)) {
      const allToolResults = content.length > 0 && content.every((c: any) => c?.type === "tool_result");
      const hasText = content.some((c: any) => c?.type === "text" || typeof c === "string");
      if (!allToolResults && (hasText || content.length === 0)) return i;
    }
  }
  return 0;
}

export function extractFromTranscript(path: string): ExtractResult | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return null;
  }

  const entries: TranscriptEntry[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try { entries.push(JSON.parse(t)); } catch {}
  }
  if (entries.length === 0) return null;

  const start = findTaskStartIndex(entries);
  const window = entries.slice(start);

  // Map tool_use id -> step (in order of appearance), then attach results.
  const stepByToolId = new Map<string, TaskStep & { command?: string }>();
  const steps: (TaskStep & { command?: string })[] = [];
  const messages: string[] = [];
  const filesChanged = new Set<string>();
  const commandsRun: string[] = [];

  let model: string | null = null;
  const usage: TaskUsage = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, totalTokens: 0 };

  let seq = 0;
  for (const e of window) {
    const content = e.message?.content;

    if (e.type === "assistant") {
      if (e.message?.model) model = e.message.model;
      const u = e.message?.usage;
      if (u) {
        usage.inputTokens += u.input_tokens ?? 0;
        usage.outputTokens += u.output_tokens ?? 0;
        usage.cacheCreationTokens += u.cache_creation_input_tokens ?? 0;
        usage.cacheReadTokens += u.cache_read_input_tokens ?? 0;
      }
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type === "text" && typeof block.text === "string") {
            messages.push(block.text);
          } else if (block?.type === "tool_use") {
            const s = summarizeTool(block.name ?? "tool", block.input);
            const step: TaskStep & { command?: string } = {
              seq: seq++,
              tool: block.name ?? "tool",
              summary: s.summary,
              isError: false,
              detail: s.detail,
              filePath: s.filePath,
              command: s.command,
            };
            if (s.filePath && (block.name === "Edit" || block.name === "Write" || block.name === "MultiEdit")) {
              filesChanged.add(s.filePath);
            }
            if (s.command) commandsRun.push(s.command);
            if (block.id) stepByToolId.set(block.id, step);
            steps.push(step);
          }
        }
      }
    } else if (e.type === "user" && Array.isArray(content)) {
      for (const block of content) {
        if (block?.type === "tool_result") {
          const step = block.tool_use_id ? stepByToolId.get(block.tool_use_id) : undefined;
          if (step && block.is_error) step.isError = true;
        }
      }
    }
  }

  usage.totalTokens = usage.inputTokens + usage.outputTokens + usage.cacheCreationTokens + usage.cacheReadTokens;

  // Strip the internal `command` helper field before returning.
  const cleanSteps: TaskStep[] = steps.map(({ command, ...rest }) => rest);

  return {
    steps: cleanSteps,
    usage: usage.totalTokens > 0 || cleanSteps.length > 0 ? usage : null,
    model,
    messages,
    filesChanged: [...filesChanged],
    commandsRun,
  };
}
