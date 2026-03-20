import { readFileSync, existsSync, mkdirSync, readdirSync, writeFileSync, unlinkSync } from "fs";

const BASE_DIR = process.env.HAIFLOW_DATA_DIR ?? "/tmp/haiflow";
const PORT = Number(process.env.PORT ?? 3333);

mkdirSync(BASE_DIR, { recursive: true });

function sanitizeSession(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64) || "default";
}

type Status = "idle" | "busy" | "offline";

interface State {
  status: Status;
  since: string;
  session?: string;
  currentPrompt?: string;
  currentTaskId?: string;
  queueLength: number;
}

interface QueueItem {
  id: string;
  prompt: string;
  addedAt: string;
  source?: string;
}

function sessionPaths(session: string) {
  const dir = `${BASE_DIR}/${session}`;
  mkdirSync(`${dir}/responses`, { recursive: true });
  return {
    state: `${dir}/state.json`,
    queue: `${dir}/queue.json`,
    responses: `${dir}/responses`,
    sessionId: `${dir}/session-id`,
  };
}

function tmuxName(session: string) {
  return session;
}

function generateId(): string {
  return `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_.-]/g, "").slice(0, 128) || generateId();
}

function responseFile(session: string, id: string): string {
  const p = sessionPaths(session);
  // Route params are URL-decoded before they reach us, so encoded values like
  // "%2E%2E%2Fstate" become "../state". Reusing sanitizeId here keeps response
  // reads and writes inside the responses directory and matches trigger IDs.
  return `${p.responses}/${sanitizeId(id)}.json`;
}

function readState(session: string): State {
  const p = sessionPaths(session);
  if (!existsSync(p.state)) {
    return { status: "offline", since: new Date().toISOString(), session, queueLength: 0 };
  }
  try {
    const raw = readFileSync(p.state, "utf-8");
    const state = JSON.parse(raw);
    const queue = readQueue(session);
    return { ...state, session, queueLength: queue.length };
  } catch {
    return { status: "offline", since: new Date().toISOString(), session, queueLength: 0 };
  }
}

function writeState(session: string, state: Omit<State, "queueLength" | "session">) {
  const p = sessionPaths(session);
  writeFileSync(p.state, JSON.stringify(state, null, 2));
}

function readQueue(session: string): QueueItem[] {
  const p = sessionPaths(session);
  if (!existsSync(p.queue)) return [];
  try {
    return JSON.parse(readFileSync(p.queue, "utf-8"));
  } catch {
    return [];
  }
}

function writeQueue(session: string, queue: QueueItem[]) {
  const p = sessionPaths(session);
  writeFileSync(p.queue, JSON.stringify(queue, null, 2));
}

function getSessionId(session: string): string | null {
  const p = sessionPaths(session);
  try { return readFileSync(p.sessionId, "utf-8").trim() || null; } catch { return null; }
}

function setSessionId(session: string, id: string | null) {
  const p = sessionPaths(session);
  if (id) { writeFileSync(p.sessionId, id); }
  else { try { unlinkSync(p.sessionId); } catch {} }
}

function findSessionByClaudeId(claudeSessionId: string): string | null {
  if (!existsSync(BASE_DIR)) return null;
  for (const dir of readdirSync(BASE_DIR)) {
    const idFile = `${BASE_DIR}/${dir}/session-id`;
    try {
      const stored = readFileSync(idFile, "utf-8").trim();
      if (stored === claudeSessionId) return dir;
    } catch {}
  }
  return null;
}

function sendToTmux(session: string, prompt: string): boolean {
  const escaped = prompt.replace(/"/g, '\\"');
  const result = Bun.spawnSync(["tmux", "send-keys", "-t", tmuxName(session), escaped, "Enter"]);
  return result.exitCode === 0;
}

function isTmuxRunning(session: string): boolean {
  const result = Bun.spawnSync(["tmux", "has-session", "-t", tmuxName(session)]);
  return result.exitCode === 0;
}

function saveResponse(session: string, taskId: string, transcriptPath?: string, lastMessage?: string) {
  if (!taskId) return;
  const file = responseFile(session, taskId);

  if (transcriptPath && existsSync(transcriptPath)) {
    try {
      const lastUserLine = JSON.parse(
        Bun.spawnSync(["jq", "-s", 'to_entries | map(select(.value.type == "user")) | last | .key', transcriptPath]).stdout.toString()
      );
      const messages = JSON.parse(
        Bun.spawnSync(["jq", "-s", "--argjson", "start", String(lastUserLine ?? 0),
          '[.[$start:][] | select(.type == "assistant" and .message.role == "assistant") | .message.content[] | select(.type == "text") | .text]',
          transcriptPath]).stdout.toString()
      );
      if (Array.isArray(messages) && messages.length > 0) {
        writeFileSync(file, JSON.stringify({
          id: taskId, completed_at: new Date().toISOString(), messages,
        }, null, 2));
        return;
      }
    } catch {}
  }

  if (lastMessage) {
    writeFileSync(file, JSON.stringify({
      id: taskId, completed_at: new Date().toISOString(), messages: [lastMessage],
    }, null, 2));
  }
}

function drainQueue(session: string) {
  const state = readState(session);
  if (state.status !== "idle") return;

  const queue = readQueue(session);
  if (queue.length === 0) return;

  const next = queue.shift()!;
  writeQueue(session, queue);

  writeState(session, {
    status: "busy",
    since: new Date().toISOString(),
    currentPrompt: next.prompt,
    currentTaskId: next.id,
  });

  sendToTmux(session, next.prompt);
}

function startClaudeSession(session: string, cwd: string): { success: boolean; error?: string } {
  if (isTmuxRunning(session)) {
    return { success: false, error: `tmux session '${tmuxName(session)}' already exists` };
  }

  const result = Bun.spawnSync([
    "tmux", "new-session", "-d", "-s", tmuxName(session), "-c", cwd,
    "claude", "--dangerously-skip-permissions",
  ]);

  if (result.exitCode !== 0) {
    return { success: false, error: result.stderr.toString() };
  }

  setSessionId(session, null);
  writeState(session, { status: "idle", since: new Date().toISOString() });
  return { success: true };
}

function stopClaudeSession(session: string): { success: boolean; error?: string } {
  if (!isTmuxRunning(session)) {
    return { success: false, error: `tmux session '${tmuxName(session)}' not found` };
  }

  // Get the exact PIDs running inside the tmux panes before killing
  const paneProcs = Bun.spawnSync([
    "tmux", "list-panes", "-t", tmuxName(session), "-F", "#{pane_pid}",
  ]);
  const panePids = paneProcs.stdout.toString().trim().split("\n").filter(Boolean);

  // Kill the tmux session (sends SIGHUP to processes inside)
  Bun.spawnSync(["tmux", "kill-session", "-t", tmuxName(session)]);

  // Kill the specific pane processes if they survived the SIGHUP
  for (const pid of panePids) {
    Bun.spawnSync(["kill", "-9", pid]);
  }

  setSessionId(session, null);
  writeState(session, { status: "offline", since: new Date().toISOString() });
  return { success: true };
}

function getSessionParam(req: Request): string {
  const url = new URL(req.url);
  return sanitizeSession(url.searchParams.get("session") ?? "default");
}

function listSessions(): { session: string; status: Status; tmux: string }[] {
  if (!existsSync(BASE_DIR)) return [];
  return readdirSync(BASE_DIR)
    .filter((d) => existsSync(`${BASE_DIR}/${d}/state.json`))
    .map((d) => {
      const state = readState(d);
      return { session: d, status: state.status, tmux: tmuxName(d) };
    });
}

const server = Bun.serve({
  port: PORT,
  routes: {
    "/sessions": {
      GET: () => Response.json(listSessions()),
    },

    "/status": {
      GET: (req) => Response.json(readState(getSessionParam(req))),
    },

    "/trigger": {
      POST: async (req) => {
        const body = await req.json();
        const prompt = body.prompt as string;
        const source = body.source as string | undefined;
        const id = body.id ? sanitizeId(body.id as string) : generateId();
        const session = sanitizeSession((body.session as string) || "default");

        if (!prompt) {
          return Response.json({ error: "prompt is required" }, { status: 400 });
        }

        const state = readState(session);

        if (state.status === "offline") {
          return Response.json(
            { error: `Session '${session}' is offline. Start it with POST /session/start` },
            { status: 503 }
          );
        }

        if (state.status === "busy") {
          const queue = readQueue(session);
          queue.push({ id, prompt, addedAt: new Date().toISOString(), source });
          writeQueue(session, queue);
          return Response.json({
            id, session, queued: true, position: queue.length,
            message: "Claude is busy. Prompt added to queue.",
          });
        }

        writeState(session, {
          status: "busy",
          since: new Date().toISOString(),
          currentPrompt: prompt,
          currentTaskId: id,
        });

        const sent = sendToTmux(session, prompt);
        if (!sent) {
          return Response.json({ error: "Failed to send to tmux session" }, { status: 500 });
        }

        return Response.json({ id, session, sent: true, prompt });
      },
    },

    "/queue": {
      GET: (req) => {
        const session = getSessionParam(req);
        const queue = readQueue(session);
        return Response.json({ session, items: queue, length: queue.length });
      },
      DELETE: (req) => {
        const session = getSessionParam(req);
        writeQueue(session, []);
        return Response.json({ session, cleared: true });
      },
    },

    "/responses": {
      GET: (req) => {
        const session = getSessionParam(req);
        const p = sessionPaths(session);
        const files = readdirSync(p.responses).filter((f) => f.endsWith(".json"));
        const responses = files.map((f) => {
          try {
            const raw = readFileSync(`${p.responses}/${f}`, "utf-8");
            const data = JSON.parse(raw);
            return { id: data.id, completed_at: data.completed_at };
          } catch {
            return null;
          }
        }).filter(Boolean);
        return Response.json({ session, items: responses, length: responses.length });
      },
    },

    "/responses/:id": {
      GET: (req) => {
        const session = getSessionParam(req);
        const id = req.params.id;
        const file = responseFile(session, id);
        if (!existsSync(file)) {
          const state = readState(session);
          if (state.currentTaskId === id && state.status === "busy") {
            return Response.json({ id, session, status: "pending" }, { status: 202 });
          }
          const queue = readQueue(session);
          const queued = queue.find((q) => q.id === id);
          if (queued) {
            return Response.json({ id, session, status: "queued" }, { status: 202 });
          }
          return Response.json({ error: "Response not found" }, { status: 404 });
        }
        try {
          const raw = readFileSync(file, "utf-8");
          return Response.json(JSON.parse(raw));
        } catch {
          return Response.json({ error: "Failed to read response" }, { status: 500 });
        }
      },
    },

    "/hooks/session-start": {
      POST: async (req) => {
        const body = await req.json();
        const claudeId = body.session_id;
        let session = findSessionByClaudeId(claudeId);

        if (!session) {
          const sessions = listSessions();
          for (const s of sessions) {
            if (!getSessionId(s.session) && isTmuxRunning(s.session)) {
              session = s.session;
              break;
            }
          }
        }

        if (session) {
          setSessionId(session, claudeId);
          if (isTmuxRunning(session)) {
            writeState(session, { status: "idle", since: new Date().toISOString() });
          }
        }

        return Response.json({ ok: true, session });
      },
    },

    "/hooks/prompt": {
      POST: async (req) => {
        const body = await req.json();
        const session = findSessionByClaudeId(body.session_id);
        if (!session) return Response.json({ ok: true });

        const state = readState(session);
        writeState(session, {
          status: "busy",
          since: new Date().toISOString(),
          currentPrompt: body.prompt,
          currentTaskId: state.currentTaskId,
        });

        return Response.json({ ok: true });
      },
    },

    "/hooks/stop": {
      POST: async (req) => {
        const body = await req.json();
        const session = findSessionByClaudeId(body.session_id);
        if (!session) return Response.json({ ok: true });

        const state = readState(session);
        if (state.currentTaskId) {
          saveResponse(session, state.currentTaskId, body.transcript_path, body.last_assistant_message);
        }

        writeState(session, { status: "idle", since: new Date().toISOString() });
        drainQueue(session);

        return Response.json({ ok: true });
      },
    },

    "/hooks/session-end": {
      POST: async (req) => {
        const body = await req.json();
        const session = findSessionByClaudeId(body.session_id);
        if (!session) return Response.json({ ok: true });

        const reason = body.reason;
        if (reason === "clear" || reason === "compact") {
          return Response.json({ ok: true });
        }

        writeState(session, { status: "offline", since: new Date().toISOString() });
        return Response.json({ ok: true });
      },
    },

    "/session/start": {
      POST: async (req) => {
        const body = await req.json();
        const session = sanitizeSession((body.session as string) || "default");
        const cwd = body.cwd as string | undefined;

        if (!cwd) {
          return Response.json({ error: "cwd is required" }, { status: 400 });
        }

        const result = startClaudeSession(session, cwd);
        if (!result.success) {
          return Response.json({ error: result.error }, { status: 409 });
        }
        return Response.json({ started: true, session, tmux: tmuxName(session), cwd });
      },
    },

    "/session/stop": {
      POST: async (req) => {
        let session = "default";
        try {
          const body = await req.json();
          session = sanitizeSession((body.session as string) || "default");
        } catch {}

        const result = stopClaudeSession(session);
        if (!result.success) {
          return Response.json({ error: result.error }, { status: 404 });
        }
        return Response.json({ stopped: true, session });
      },
    },

    "/health": new Response("ok"),
  },

  fetch(req) {
    return Response.json({ error: "Not found" }, { status: 404 });
  },
});

for (const dir of readdirSync(BASE_DIR).filter((d) => existsSync(`${BASE_DIR}/${d}/state.json`))) {
  if (isTmuxRunning(dir) && getSessionId(dir)) {
    const state = readState(dir);
    if (state.status === "offline") {
      writeState(dir, { status: "idle", since: new Date().toISOString() });
    }
  }
}

console.log(`haiflow running on http://localhost:${server.port}`);
console.log(`Sessions: ${JSON.stringify(listSessions())}`);
