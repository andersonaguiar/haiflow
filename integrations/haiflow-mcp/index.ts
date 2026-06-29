#!/usr/bin/env bun
/**
 * haiflow MCP server — exposes haiflow's Claude Code orchestration as MCP tools
 * so any MCP-capable agent (Claude Desktop, Cursor, Cline, another Claude Code)
 * can start sessions, run prompts, and chain agents through haiflow.
 *
 * Config (env):
 *   HAIFLOW_URL      base URL of the haiflow server (default http://localhost:3333)
 *   HAIFLOW_API_KEY  bearer key (required for every endpoint except health/version)
 *
 * Transport: stdio. All diagnostics go to stderr — stdout is the MCP channel.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const BASE = (process.env.HAIFLOW_URL ?? "http://localhost:3333").replace(/\/$/, "");
const API_KEY = process.env.HAIFLOW_API_KEY ?? "";

type ApiResult = { status: number; data: any };

async function api(path: string, method = "GET", body?: object): Promise<ApiResult> {
  const headers: Record<string, string> = {};
  if (API_KEY) headers.Authorization = `Bearer ${API_KEY}`;
  if (body) headers["Content-Type"] = "application/json";
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const ct = res.headers.get("content-type") || "";
  const data = ct.includes("json") ? await res.json() : await res.text();
  return { status: res.status, data };
}

// Consume the SSE stream to its terminal event. haiflow closes the stream on
// complete/error/timeout, so reading the whole body blocks until the task ends.
async function streamUntilComplete(id: string, session: string, timeoutSec: number): Promise<any> {
  const headers: Record<string, string> = {};
  if (API_KEY) headers.Authorization = `Bearer ${API_KEY}`;
  const res = await fetch(
    `${BASE}/responses/${encodeURIComponent(id)}/stream?session=${encodeURIComponent(session)}&timeout=${timeoutSec}`,
    { headers },
  );
  const text = await res.text();
  for (const block of text.split("\n\n").reverse()) {
    const lines = block.split("\n");
    const event = lines.find((l) => l.startsWith("event: "))?.slice(7).trim();
    const dataLine = lines.find((l) => l.startsWith("data: "))?.slice(6);
    if (!event || !dataLine) continue;
    if (event === "complete") return { complete: JSON.parse(dataLine) };
    if (event === "error") return { error: JSON.parse(dataLine).error ?? "stream error" };
    if (event === "timeout") return { error: "timed out waiting for the task to complete" };
  }
  return { error: "stream ended without a result" };
}

function genId(): string {
  return `mcp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

const ok = (obj: unknown) => ({ content: [{ type: "text" as const, text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }] });
const fail = (msg: string) => ({ content: [{ type: "text" as const, text: msg }], isError: true });
const failResponse = (label: string, r: ApiResult) => fail(`${label} failed (${r.status}): ${JSON.stringify(r.data)}`);

async function guarded<T>(fn: () => Promise<T>): Promise<T | ReturnType<typeof fail>> {
  try {
    return await fn();
  } catch (err) {
    return fail(`Could not reach haiflow at ${BASE}: ${String(err)}. Is the server running and HAIFLOW_URL/HAIFLOW_API_KEY set?`);
  }
}

const server = new McpServer({ name: "haiflow", version: "0.1.0" });

// The headline tool: run a prompt and return its result. Triggers, then blocks
// on the SSE stream until the task completes. Use ephemeral for a self-contained
// one-shot (auto-start + auto-stop) against an offline session.
server.registerTool(
  "haiflow_run",
  {
    title: "Run a prompt and wait for the result",
    description:
      "Send a prompt to a haiflow session and wait for the completed response. The session must already be running, unless `ephemeral` is true (then haiflow auto-starts it from `cwd` and stops it after responding). Returns the assistant's message(s).",
    inputSchema: {
      prompt: z.string().describe("The prompt or slash command to run"),
      session: z.string().optional().describe('Session name (default "default")'),
      cwd: z.string().optional().describe("Working dir; used to auto-start when ephemeral and the session is offline"),
      ephemeral: z.boolean().optional().describe("One-shot: auto-start if offline, then stop after responding"),
      timeoutSec: z.number().optional().describe("Max seconds to wait (default 300, capped at 600)"),
    },
  },
  async ({ prompt, session = "default", cwd, ephemeral, timeoutSec = 300 }) =>
    guarded(async () => {
      const id = genId();
      const trig = await api("/trigger", "POST", { prompt, session, id, cwd, ephemeral: ephemeral || undefined });
      if (trig.status >= 400) return failResponse("trigger", trig);
      const result = await streamUntilComplete(id, session, Math.min(timeoutSec, 600));
      if (result.error) return fail(result.error);
      const messages: string[] = result.complete?.messages ?? [];
      return ok(messages.join("\n") || "(no text output)");
    }),
);

server.registerTool(
  "haiflow_start_session",
  {
    title: "Start a session",
    description: "Start a Claude Code session in a detached tmux session. Fails (409) if the session can't link its hooks.",
    inputSchema: {
      session: z.string().optional().describe('Session name (default "default")'),
      cwd: z.string().optional().describe("Working directory for Claude. Optional: when omitted, haiflow uses HAIFLOW_CWD if the server pins one, otherwise it falls back to /tmp."),
    },
  },
  async ({ session = "default", cwd }) =>
    guarded(async () => ok((await api("/session/start", "POST", { session, cwd })).data)),
);

server.registerTool(
  "haiflow_trigger",
  {
    title: "Trigger a prompt (no wait)",
    description:
      "Send a prompt without waiting for the result — returns immediately with a task id (sent or queued). Use ephemeral for one-shot lifecycle and callbackUrl for a completion webhook. Fetch the result later with haiflow_get_response.",
    inputSchema: {
      prompt: z.string(),
      session: z.string().optional(),
      id: z.string().optional().describe("Custom task id (auto-generated if omitted)"),
      cwd: z.string().optional(),
      ephemeral: z.boolean().optional(),
      callbackUrl: z.string().optional().describe("POST the result here on completion (must be enabled server-side)"),
      priority: z.number().optional(),
      dedupKey: z.string().optional(),
    },
  },
  async ({ prompt, session = "default", id, cwd, ephemeral, callbackUrl, priority, dedupKey }) =>
    guarded(async () => {
      const taskId = id ?? genId();
      const r = await api("/trigger", "POST", { prompt, session, id: taskId, cwd, ephemeral: ephemeral || undefined, callbackUrl, priority, dedupKey });
      return r.status >= 400 ? failResponse("trigger", r) : ok(r.data);
    }),
);

server.registerTool(
  "haiflow_get_response",
  {
    title: "Get a task's response",
    description: "Fetch a task result by id. 200 = done (messages included), 202 = still pending/queued, 404 = unknown id.",
    inputSchema: {
      id: z.string(),
      session: z.string().optional(),
    },
  },
  async ({ id, session = "default" }) =>
    guarded(async () => ok((await api(`/responses/${encodeURIComponent(id)}?session=${encodeURIComponent(session)}`)).data)),
);

server.registerTool(
  "haiflow_stop_session",
  {
    title: "Stop a session",
    description: "Kill a Claude tmux session.",
    inputSchema: { session: z.string().optional() },
  },
  async ({ session = "default" }) =>
    guarded(async () => ok((await api("/session/stop", "POST", { session })).data)),
);

server.registerTool(
  "haiflow_status",
  {
    title: "Session status",
    description: "Status of one session (idle/busy/offline, queue length), or all sessions when no session is given.",
    inputSchema: { session: z.string().optional() },
  },
  async ({ session }) =>
    guarded(async () => ok((await api(session ? `/status?session=${encodeURIComponent(session)}` : "/sessions")).data)),
);

server.registerTool(
  "haiflow_doctor",
  {
    title: "Health check",
    description: "Diagnose a session — catches the #1 silent failure (tmux running but hooks never linked, so responses are lost).",
    inputSchema: { session: z.string().optional() },
  },
  async ({ session }) =>
    guarded(async () => ok((await api(session ? `/doctor?session=${encodeURIComponent(session)}` : "/doctor")).data)),
);

server.registerTool(
  "haiflow_map",
  {
    title: "Map-reduce across a pool",
    description:
      "Fan a list of items across a worker pool in parallel, then optionally run a reducer once every item returns (the fan-in JOIN). The pool must be defined in pipeline.json.",
    inputSchema: {
      items: z.array(z.string()).describe("Items to map over; each fills {{item}} in mapTemplate"),
      pool: z.string().describe("Pool name from pipeline.json"),
      mapTemplate: z.string().describe("Per-item prompt. Vars: {{item}}, {{index}}, {{total}}, {{runId}}"),
      reduceSession: z.string().optional().describe("Session that runs the reducer"),
      reducePromptTemplate: z.string().optional().describe("Reducer prompt; {{results}} is the joined outputs"),
    },
  },
  async ({ items, pool, mapTemplate, reduceSession, reducePromptTemplate }) =>
    guarded(async () => {
      const reduce = reduceSession && reducePromptTemplate ? { session: reduceSession, promptTemplate: reducePromptTemplate } : undefined;
      const r = await api("/map", "POST", { items, pool, mapTemplate, reduce });
      return r.status >= 400 ? failResponse("map", r) : ok(r.data);
    }),
);

async function main() {
  await server.connect(new StdioServerTransport());
  console.error(`haiflow MCP server running on stdio → ${BASE}`);
}

main().catch((err) => {
  console.error("Fatal error starting haiflow MCP server:", err);
  process.exit(1);
});
