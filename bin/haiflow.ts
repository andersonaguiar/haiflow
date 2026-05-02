#!/usr/bin/env bun

import { existsSync } from "fs";
import { resolve, dirname } from "path";

const PORT = process.env.PORT ?? "3333";
const BASE = `http://localhost:${PORT}`;
const PACKAGE_ROOT = dirname(import.meta.dir);
const HOOKS_DIR = resolve(PACKAGE_ROOT, "hooks");
const SERVER_ENTRY = resolve(PACKAGE_ROOT, "src/index.ts");

const args = process.argv.slice(2);
const command = args[0];

function flag(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

async function api(path: string, method = "GET", body?: object) {
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json();
    if (!res.ok) {
      console.error(`Error (${res.status}):`, data.error ?? data);
      process.exit(1);
    }
    return data;
  } catch (e: any) {
    if (e.code === "ECONNREFUSED" || e.cause?.code === "ECONNREFUSED") {
      console.error(`Cannot connect to haiflow on port ${PORT}. Is the server running?`);
      console.error(`Start it with: bun run start`);
      process.exit(1);
    }
    throw e;
  }
}

async function serve() {
  if (!existsSync(SERVER_ENTRY)) {
    console.error(`Server entry not found at ${SERVER_ENTRY}`);
    console.error(`The haiflow package may be incomplete — try reinstalling.`);
    process.exit(1);
  }
  await import(SERVER_ENTRY);
}

async function setup() {
  const settingsPath = `${process.env.HOME}/.claude/settings.json`;

  let settings: any = {};
  try {
    settings = JSON.parse(await Bun.file(settingsPath).text());
  } catch {}

  if (!settings.hooks) settings.hooks = {};

  const hookMap: Record<string, string> = {
    SessionStart: `${HOOKS_DIR}/session-start.sh`,
    UserPromptSubmit: `${HOOKS_DIR}/prompt.sh`,
    Stop: `${HOOKS_DIR}/stop.sh`,
    SessionEnd: `${HOOKS_DIR}/session-end.sh`,
  };

  let installed = 0;
  for (const [event, script] of Object.entries(hookMap)) {
    if (!existsSync(script)) {
      console.error(`Hook script not found: ${script}`);
      process.exit(1);
    }

    const existing: any[] = settings.hooks[event] ?? [];
    const alreadyInstalled = existing.some((e: any) =>
      e.hooks?.some((h: any) => h.command?.includes("/haiflow/") || h.command?.includes("/hooks/"))
    );

    if (!alreadyInstalled) {
      existing.push({
        hooks: [{ type: "command", command: script }],
      });
      settings.hooks[event] = existing;
      installed++;
    }
  }

  await Bun.write(settingsPath, JSON.stringify(settings, null, 2));

  if (installed > 0) {
    console.log(`Installed ${installed} hooks into ${settingsPath}`);
  } else {
    console.log(`Hooks already installed in ${settingsPath}`);
  }
}

async function startSession() {
  const session = args[1] || "default";
  const cwd = flag("cwd");

  if (!cwd) {
    console.error("--cwd is required");
    console.error("Usage: haiflow start <session> --cwd /path/to/project");
    process.exit(1);
  }

  const data = await api("/session/start", "POST", { session, cwd });
  console.log(`Started session '${data.session}' (tmux: ${data.tmux})`);
  console.log(`Working directory: ${data.cwd}`);
  console.log(`Watch: tmux attach -t ${data.tmux} -r`);
}

async function stopSession() {
  const session = args[1] || "default";
  const data = await api("/session/stop", "POST", { session });
  console.log(`Stopped session '${data.session}'`);
}

async function trigger() {
  const prompt = args[1];
  if (!prompt) {
    console.error("Usage: haiflow trigger <prompt> [--session name] [--id task-id]");
    process.exit(1);
  }

  const session = flag("session") || "default";
  const id = flag("id");
  const source = flag("source");

  const body: any = { prompt, session };
  if (id) body.id = id;
  if (source) body.source = source;

  const data = await api("/trigger", "POST", body);

  if (data.queued) {
    console.log(`Queued (position ${data.position}): ${data.id}`);
  } else {
    console.log(`Sent: ${data.id}`);
  }
}

async function status() {
  const session = args[1] || "default";
  const data = await api(`/status?session=${session}`);
  console.log(`Session: ${data.session}`);
  console.log(`Status:  ${data.status}`);
  console.log(`Since:   ${data.since}`);
  if (data.queueLength > 0) console.log(`Queue:   ${data.queueLength} items`);
  if (data.currentPrompt) console.log(`Prompt:  ${data.currentPrompt}`);
}

async function sessions() {
  const data = await api("/sessions");
  if (data.length === 0) {
    console.log("No sessions");
    return;
  }
  for (const s of data) {
    console.log(`${s.session.padEnd(20)} ${s.status.padEnd(10)} (tmux: ${s.tmux})`);
  }
}

async function responses() {
  const id = args[1];
  const session = flag("session") || "default";

  if (id) {
    const data = await api(`/responses/${id}?session=${session}`);
    console.log(JSON.stringify(data, null, 2));
  } else {
    const data = await api(`/responses?session=${session}`);
    if (data.items.length === 0) {
      console.log("No responses");
      return;
    }
    for (const r of data.items) {
      console.log(`${r.id}  ${r.completed_at}`);
    }
  }
}

function usage() {
  console.log(`haiflow - HTTP orchestrator for Claude Code

Usage: haiflow <command> [options]

Commands:
  serve                          Run the haiflow server (this process)
  setup                          Install Claude Code hooks
  start <session> --cwd <path>   Start a Claude session
  stop [session]                 Stop a Claude session
  trigger <prompt>               Send a prompt to Claude
  status [session]               Check session status
  sessions                       List all sessions
  responses [id]                 Get responses

Options:
  --cwd <path>       Working directory (required for start)
  --session <name>   Session name (default: "default")
  --id <id>          Task ID for trigger
  --source <name>    Source label for trigger

Environment:
  PORT               Server port (default: 3333)

Examples:
  haiflow setup
  haiflow start worker --cwd /path/to/project
  haiflow trigger "explain this codebase"
  haiflow trigger "/daily-update" --session worker --id daily-001
  haiflow status worker
  haiflow sessions`);
}

switch (command) {
  case "serve":
    await serve();
    break;
  case "setup":
    await setup();
    break;
  case "start":
    await startSession();
    break;
  case "stop":
    await stopSession();
    break;
  case "trigger":
    await trigger();
    break;
  case "status":
    await status();
    break;
  case "sessions":
    await sessions();
    break;
  case "responses":
    await responses();
    break;
  default:
    usage();
    break;
}
