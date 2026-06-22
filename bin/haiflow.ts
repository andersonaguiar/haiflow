#!/usr/bin/env bun

import { existsSync, readFileSync } from "fs";
import { resolve, dirname } from "path";

const PORT = process.env.PORT ?? "3333";
const BASE = `http://localhost:${PORT}`;
const PACKAGE_ROOT = dirname(import.meta.dir);
const HOOKS_DIR = resolve(PACKAGE_ROOT, "hooks");
const SERVER_ENTRY = resolve(PACKAGE_ROOT, "src/index.ts");
const GITHUB_ENTRY = resolve(PACKAGE_ROOT, "src/github-bot.ts");

const args = process.argv.slice(2);
const command = args[0];

function flag(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

const API_KEY = process.env.HAIFLOW_API_KEY?.trim();

async function api(path: string, method = "GET", body?: object) {
  try {
    const headers: Record<string, string> = {};
    if (API_KEY) headers.Authorization = `Bearer ${API_KEY}`;
    if (body) headers["Content-Type"] = "application/json";
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers,
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

function version() {
  try {
    const pkg = JSON.parse(readFileSync(resolve(PACKAGE_ROOT, "package.json"), "utf-8"));
    console.log(pkg.version ?? "unknown");
  } catch {
    console.log("unknown");
  }
}

async function github() {
  if (!existsSync(GITHUB_ENTRY)) {
    console.error(`GitHub bridge entry not found at ${GITHUB_ENTRY}`);
    console.error(`The haiflow package may be incomplete — try reinstalling.`);
    process.exit(1);
  }
  await import(GITHUB_ENTRY);
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
    Notification: `${HOOKS_DIR}/notification.sh`,
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

async function doctor() {
  const session = args[1];
  const data = await api(session ? `/doctor?session=${session}` : "/doctor");
  const line = (s: any) => {
    const mark = s.healthy ? "✓" : "✗";
    console.log(`${mark} ${String(s.session).padEnd(18)} ${String(s.status).padEnd(8)} hooks:${s.hooksLinked ? "linked" : "MISSING"} tmux:${s.tmuxRunning ? "up" : "down"}`);
    if (s.note) console.log(`    ${s.note}`);
  };
  if (data.sessions) {
    if (data.sessions.length === 0) { console.log("No sessions"); return; }
    for (const s of data.sessions) line(s);
  } else {
    line(data);
  }
}

async function init() {
  const dir = args[1] ? resolve(args[1]) : process.cwd();
  const session = flag("session") || "default";

  if (!API_KEY) {
    console.error("HAIFLOW_API_KEY is not set. Set it (e.g. export HAIFLOW_API_KEY=$(openssl rand -hex 32))");
    console.error("and make sure the running server uses the same value.");
    process.exit(1);
  }

  console.log("1. Installing Claude Code hooks...");
  await setup();

  console.log(`2. Starting session '${session}' in ${dir}...`);
  const started = await api("/session/start", "POST", { session, cwd: dir });
  console.log(`   ✓ tmux: ${started.tmux}`);

  // Let the SessionStart hook arrive, then verify the hooks are wired.
  await new Promise((r) => setTimeout(r, 1500));
  const health = await api(`/doctor?session=${session}`);
  if (health.tmuxRunning && !health.hooksLinked) {
    console.log("   ⚠ Hooks not detected — the SessionStart hook didn't reach the server.");
    console.log("     Check ~/.claude/settings.json for the haiflow hooks, then restart the session.");
  } else {
    console.log("   ✓ Hooks linked");
  }

  console.log("3. Sending a smoke-test prompt...");
  const id = `init-smoke-${Date.now()}`;
  await api("/trigger", "POST", { prompt: "Reply with exactly the word: ready", session, id });

  const deadline = Date.now() + 45_000;
  let done = false;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    const res = await fetch(`${BASE}/responses/${id}?session=${session}`, {
      headers: API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {},
    });
    if (res.status === 200) {
      const data = await res.json();
      console.log(`   ✓ Response: ${String(data.messages?.[0] ?? "").slice(0, 80)}`);
      done = true;
      break;
    }
  }
  if (!done) {
    const h = await api(`/doctor?session=${session}`);
    if (!h.hooksLinked) console.log("   ✗ No response and hooks not linked — run `haiflow setup`, then retry.");
    else console.log(`   … No response yet. Claude may still be working; check \`haiflow responses ${id} --session ${session}\`.`);
  }

  console.log(`\nDone. Dashboard: http://localhost:${PORT}/dashboard`);
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
  github                         Run the GitHub webhook bridge (this process)
  setup                          Install Claude Code hooks
  init [dir] [--session name]    One-shot onboarding: hooks + session + smoke test
  doctor [session]               Report hook/session health (catches unwired hooks)
  start <session> --cwd <path>   Start a Claude session
  stop [session]                 Stop a Claude session
  trigger <prompt>               Send a prompt to Claude
  status [session]               Check session status
  sessions                       List all sessions
  responses [id]                 Get responses
  version                        Print the haiflow version

Options:
  --cwd <path>       Working directory (required for start)
  --session <name>   Session name (default: "default")
  --id <id>          Task ID for trigger
  --source <name>    Source label for trigger

Environment:
  PORT                        Server port (default: 3333)
  HAIFLOW_API_KEY             Bearer token (required by the server and bridges)

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
  case "github":
    await github();
    break;
  case "setup":
    await setup();
    break;
  case "init":
    await init();
    break;
  case "doctor":
    await doctor();
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
  case "version":
  case "--version":
  case "-v":
    version();
    break;
  default:
    usage();
    break;
}
