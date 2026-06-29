# haiflow

**h**ooks · **ai** · **flow**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Bun](https://img.shields.io/badge/runtime-Bun-f9f1e1?logo=bun)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Claude Code](https://img.shields.io/badge/Claude-Code-cc785c?logo=anthropic)](https://docs.anthropic.com/en/docs/claude-code)
[![n8n](https://img.shields.io/badge/n8n-EA4B71?logo=n8n&logoColor=white)](https://n8n.io)
[![tmux](https://img.shields.io/badge/tmux-1BB91F?logo=tmux&logoColor=white)](https://github.com/tmux/tmux)
[![GitHub stars](https://img.shields.io/github/stars/andersonaguiar/haiflow)](https://github.com/andersonaguiar/haiflow)

Run [Claude Code](https://docs.anthropic.com/en/docs/claude-code) as a headless AI agent over HTTP — no API key costs, no SDK, just your existing Claude Code subscription.

Haiflow wraps Claude Code in tmux sessions and exposes a REST API to trigger prompts, queue work, and capture responses. Automate anything you can do in Claude Code — code generation, refactoring, bug triage, daily reports — from any HTTP client.

> **Why not the Claude API?** Claude Code includes tool use, file access, git integration, and your custom skills out of the box. Haiflow lets you automate all of that via HTTP without paying per-token API costs. Use n8n, cron, webhooks, or any automation tool to drive it.

![demo](assets/demo.gif?v=2)

```
POST /trigger ───┐
                 │        ┌────────────────┐
             ┌───▼───┐    │  tmux session  │
             │ Queue ├───>│   (claude)     │
             │ (FIFO)│    └───────┬────────┘
             └───────┘            │
                           hooks fire on
                           session events
                                  │
                          ┌───────▼────────┐
                          │    Responses   │
                          └───────┬────────┘
                                  │
GET /responses/:id <──────────────┤
                                  │
GET /responses/:id/stream <───────┘  (SSE)
```

### Agent pipeline

Chain agents together with event-driven pub/sub. Each agent subscribes to topics it cares about and emits events when done — no hardcoded dependencies between agents.

```
Design Agent ──emit──▶ design.ready ──subscribe──▶ Developer Agent
Developer    ──emit──▶ code.ready   ──subscribe──▶ Code Reviewer
Reviewer     ──emit──▶ review.done  ──subscribe──▶ QA Agent
```

See [Pipeline](#pipeline) for setup.

## Platform support

macOS and Linux only. Windows is not supported yet (haiflow depends on tmux and POSIX shell scripts).

## Prerequisites

- [Bun](https://bun.sh) v1.2.3+
- [tmux](https://github.com/tmux/tmux)
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code)
- [jq](https://jqlang.github.io/jq/)
- [Redis](https://redis.io/) — *optional*, enables event persistence and delivery retry. Without it, pipeline events fire but aren't persisted. Run with `docker run -d -p 6379:6379 redis`.

## Quick start

### One-liner (macOS / Linux)

```bash
curl -fsSL https://raw.githubusercontent.com/andersonaguiar/haiflow/main/install.sh | bash
```

Installs Bun if missing, checks for `tmux`/`jq`/`claude`/`redis`, installs the `haiflow` CLI globally, and wires up Claude Code hooks.

```bash
export HAIFLOW_API_KEY=your-secret
haiflow serve                                      # run the server
haiflow init /path/to/your/project                 # in another shell: wires hooks, starts a session, runs a smoke test
```

`haiflow init` is the fastest way to a working setup: it installs the hooks, starts a session, fires a smoke-test prompt, and tells you immediately if the hooks aren't wired (the #1 silent failure). To check health anytime, run `haiflow doctor` or `GET /doctor`. Prefer to do it by hand? Use `haiflow start worker --cwd /path/to/your/project`.

Skip hook setup with `HAIFLOW_SKIP_SETUP=1`. Force npm registry with `HAIFLOW_INSTALL_METHOD=npm`. Inspect the script before piping if you prefer: `curl -fsSL .../install.sh | less`.

### From source

```bash
git clone https://github.com/andersonaguiar/haiflow.git
cd haiflow
bun install      # also installs Claude Code hooks automatically
cp .env.example .env
# Edit .env and set HAIFLOW_API_KEY to any secret string you choose
bun run dev      # starts server with hot reload
```

### Try it out

```bash
export HAIFLOW_API_KEY="your-secret-key"

# Start a Claude session
curl -X POST http://localhost:3333/session/start \
  -H "Authorization: Bearer $HAIFLOW_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"session": "worker", "cwd": "/path/to/your/project"}'

# Send a prompt
curl -X POST http://localhost:3333/trigger \
  -H "Authorization: Bearer $HAIFLOW_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"prompt": "explain this codebase", "session": "worker", "id": "my-task"}'

# Poll for the response
curl -s -H "Authorization: Bearer $HAIFLOW_API_KEY" \
  "http://localhost:3333/responses/my-task?session=worker" | jq .

# Watch Claude work (read-only)
tmux attach -t worker -r

# Stop the session
curl -X POST http://localhost:3333/session/stop \
  -H "Authorization: Bearer $HAIFLOW_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"session": "worker"}'
```

Or use the CLI:

```bash
bun run bin/haiflow.ts start worker --cwd /path/to/your/project
bun run bin/haiflow.ts trigger "explain this codebase" --session worker
bun run bin/haiflow.ts status worker
bun run bin/haiflow.ts stop worker
```

## Setup

### 1. Install dependencies

```bash
bun install
```

### 2. Install hooks

Haiflow uses [Claude Code hooks](https://docs.anthropic.com/en/docs/claude-code/hooks) to track session state. The setup command merges hook config into `~/.claude/settings.json`:

```bash
bun run setup
```

The hooks are thin HTTP forwarders — they POST Claude Code events to the haiflow server. If the server isn't running, they silently no-op. They won't interfere with non-orchestrated Claude sessions (the server ignores unknown session IDs).

### 3. Configure environment (optional)

```bash
cp .env.example .env
```

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3333` | HTTP server port |
| `HAIFLOW_ENV` | `development` | Deployment environment (`development`/`production`; falls back to `NODE_ENV`). In `production`, haiflow fails closed at boot on an insecure exposure and rejects a weak/placeholder key. Dev is permissive (no tunnel required). |
| `HAIFLOW_HOST` | `127.0.0.1` | Bind address. Loopback by default so the origin is only reachable through a front proxy/tunnel — an identity layer can't be bypassed by hitting the port directly. A public bind in production needs `HAIFLOW_ALLOW_PUBLIC_BIND=true`. See [DEPLOYMENT.md](DEPLOYMENT.md). |
| `HAIFLOW_ALLOW_PUBLIC_BIND` | `false` | Acknowledge a public bind (`0.0.0.0`/LAN/public IP) in production — you firewall the port and run your own identity layer. Without it, production refuses to start when bound publicly. |
| `HAIFLOW_DATA_DIR` | `/tmp/haiflow` | Directory for session state, queues, and responses |
| `HAIFLOW_PORT` | `3333` | Port used by hook scripts (set if different from PORT) |
| `HAIFLOW_API_KEY` | — | **Required.** Any string you choose — this is your own secret, not a paid key. In `production` it must be ≥24 chars and not a placeholder. |
| `HAIFLOW_CWD` | — | When set, every session is forced to use this cwd. The `cwd` field in `/session/start` request bodies is ignored (a warning is logged if it differs). |
| `HAIFLOW_ALLOW_REQUEST_CWD` | `true` | When `false`, `/session/start` rejects requests that try to set their own `cwd` — `HAIFLOW_CWD` must be set on the server instead. |
| `HAIFLOW_GUARDRAILS` | `true` | Installs `~/.claude/skills/haiflow-guardrails/SKILL.md` on server boot and injects `/haiflow-guardrails` into each new tmux session. The skill instructs Claude to refuse paths outside cwd, refuse to read secrets, and refuse network exfiltration. |
| `REDIS_URL` | `redis://localhost:6379` | **Required.** Redis URL for event persistence and delivery tracking |
| `HAIFLOW_START_READY_TIMEOUT_MS` | `15000` | How long `/session/start` waits for the SessionStart hook to link a Claude session id before failing (a session that never links would silently drop every response — usually means hooks aren't wired) |
| `HAIFLOW_ALLOW_TRIGGER_CALLBACK` | `false` | Enables the per-`/trigger` `callbackUrl` completion webhook. Off by default because an arbitrary callback URL is an SSRF surface |
| `HAIFLOW_CALLBACK_ALLOW_HOSTS` | — | Optional comma-separated host allowlist for `callbackUrl`. With it set, callbacks to any other host are rejected with `400` |
| `N8N_API_KEY` | — | n8n API key for workflow integration |
| `HAIFLOW_USAGE_ALERT_TOKENS` | — | When set, `GET /usage/window` flags `alert: true` once the rolling 5h token total crosses it (alert-only, never throttles) |
| `HAIFLOW_TASK_TIMEOUT_SEC` | `0` | Optional hard per-task timeout. `0` disables it. The watchdog flags tasks that exceed it |
| `HAIFLOW_WAITING_GRACE_SEC` | `120` | How long a session flagged `waiting` by Claude's Notification hook may stay blocked before the watchdog acts |
| `HAIFLOW_WATCHDOG_RECOVER` | `false` | When `true`, the watchdog auto-recovers a wedged session (Escape, mark `timed_out`, drain). Default alert-only |
| `HAIFLOW_MAP_MAX_ITEMS` | `200` | Max items one `POST /map` call may fan across a pool |
| `HAIFLOW_MAP_TIMEOUT_SEC` | `1800` | How long a map run waits for stragglers before the reducer fires with partial results |

## Authentication

> 🔒 For the full threat model, trust boundaries, defense-in-depth layers, and a hardening checklist, see **[SECURITY.md](SECURITY.md)**.

`HAIFLOW_API_KEY` is required — pick any string you like (e.g. `openssl rand -hex 32`). It's not a third-party key or paid credential, just a secret you define to protect your server.

**Why this matters:** Without auth, anyone who can reach your server could send arbitrary prompts to Claude Code running with full file and git access. That means reading your source code, modifying files, running shell commands, or exfiltrating data — all through a simple HTTP request.

### Secret redaction

As defence-in-depth against the agent printing a secret it read while debugging, haiflow runs a best-effort redaction pass over every outbound text (responses, pipeline messages, webhooks, chat replies) before it leaves the box. It strips well-known credential shapes (AWS/GitHub/Stripe/Google/Anthropic/OpenAI keys, JWTs, Bearer tokens, private-key blocks), replacing each with `[REDACTED:type]` and recording a count. It is on by default (disable with `HAIFLOW_REDACT=false`); emails are opt-in (`HAIFLOW_REDACT_EMAILS=true`); add your own patterns with `HAIFLOW_REDACT_EXTRA`. This is best-effort DLP, not a firewall: it won't catch an encoded or reshaped secret, and it only ever rewrites outbound text, never the files the agent writes inside its working directory.

### Bearer token

The server will refuse to start without it. All API endpoints (except `/health` and `/hooks/*`) require an `Authorization` header:

```bash
curl -H "Authorization: Bearer your-secret-key" http://localhost:3333/sessions
```

Hooks are excluded from auth since they come from Claude Code running locally — requests to `/hooks/*` are restricted to localhost.

### Exposing to the internet

If you need to access haiflow remotely (from n8n cloud, webhooks, etc.), see [DEPLOYMENT.md](DEPLOYMENT.md) for a guide on setting up Cloudflare Zero Trust Access — adds an identity layer so a stolen API key alone isn't enough.

## Documentation

Full developer documentation lives in [`docs/`](docs/), a searchable [Mintlify](https://mintlify.com) site covering the quickstart, every endpoint (with an interactive playground generated from `docs/openapi.json`), the MCP server, n8n nodes, pipelines, worker pools, deployment, and security. Preview it locally:

```bash
cd docs && npx mint dev   # http://localhost:3000
```

## API

See [API.md](API.md) for the full API reference: all endpoints, parameters, and examples. The same surface is also published as an interactive reference in the [docs site](docs/).

## Dashboard

Haiflow includes a built-in web dashboard for monitoring and controlling sessions in real-time.

```
http://localhost:3333/dashboard
```

Enter your `HAIFLOW_API_KEY` to authenticate, then you get a two-panel layout:

- **Left panel** — all sessions with live status badges (idle/busy/offline), remove offline sessions with ×
- **Right panel** — current prompt (when busy), tabbed Queue/Responses/History view with expandable items showing full prompt and response text
- **History tab** — every task's tool/command/diff timeline, token usage, duration, and "API cost avoided", plus rolling 5h/7d usage windows (see [Task history & savings](#task-history--savings))
- **Live terminal** — read-only by default; click **Take control** to switch to a writable attach and type directly into a wedged session from the browser (gated by the API key; disable with `HAIFLOW_ALLOW_TAKEOVER=false`). While you hold the wheel, auto-drain pauses so the queue isn't typed over your input
- **Actions** — start/stop sessions, send prompts, clear queue/responses

The dashboard auto-refreshes every 3 seconds. No extra setup needed — it's served by the same Bun server.

## Task history & savings

Every task is recorded in a durable SQLite ledger (`haiflow.db` in `HAIFLOW_DATA_DIR`). On completion, haiflow mines the same Claude Code transcript it parses for the Stop hook and stores what the task actually did: the ordered tool calls, commands run, files changed, real diffs, token usage, model, and timing. Query it via `GET /tasks`, `GET /tasks/:id`, and `GET /responses/:id/timeline`, or browse it in the dashboard's History tab.

Because haiflow runs on a flat Claude Code subscription, tasks cost nothing per-token. `GET /usage` and `GET /usage/window` report measured token consumption over rolling 5-hour and 7-day windows (the subscription rate-limit windows) alongside the equivalent API cost a per-token caller would have paid — the savings the tool exists to deliver. The dollar figure is an estimate from a maintained price table, not a bill. Set `HAIFLOW_USAGE_ALERT_TOKENS` to get an alert-only flag when the 5h window crosses a threshold (it never throttles work).

> Durability note: the ledger lives in `HAIFLOW_DATA_DIR`, which defaults to `/tmp/haiflow` and is wiped on reboot. Point it at a persistent directory to keep history across restarts.

## Logging

Haiflow outputs structured JSON logs to stdout/stderr for all key events:

```jsonl
{"ts":"2026-03-18T02:35:00Z","level":"info","event":"server_started","port":3333,"auth":true}
{"ts":"2026-03-18T02:35:01Z","level":"info","event":"session_started","session":"worker","cwd":"/app"}
{"ts":"2026-03-18T02:35:02Z","level":"info","event":"trigger_sent","session":"worker","taskId":"task-001"}
{"ts":"2026-03-18T02:35:09Z","level":"info","event":"response_saved","session":"worker","taskId":"task-001","source":"transcript"}
{"ts":"2026-03-18T02:35:10Z","level":"warn","event":"auth_rejected","path":"/trigger"}
```

Events: `server_started`, `sessions_recovered`, `stale_prompts_swept`, `sessions_pruned`, `session_started`, `session_start_cwd_defaulted`, `session_stopped`, `session_start_failed`, `trigger_sent`, `trigger_queued`, `trigger_deduped`, `trigger_failed`, `queue_drained`, `queue_cleared`, `queue_item_removed`, `queue_item_reprioritized`, `task_cancelled`, `response_saved`, `stream_opened`, `hook_session_start`, `hook_stop`, `hook_session_end`, `hook_notification`, `interrupt_sent`, `watchdog_triggered`, `watchdog_recovered`, `auth_rejected`, `redis_connected`, `redis_disconnected`, `redis_unavailable`, `event_published`, `event_published_direct`, `pipeline_dispatched`, `pipeline_queued`, `pipeline_subscriber_offline`, `pipeline_circular_skipped`, `pipeline_prompt_too_large`, `pipeline_webhook_sent`, `pipeline_webhook_failed`, `publish_unknown_topic`, `publish_unauthorized`, `pool_dispatched`, `map_started`, `map_progress`, `map_reduced`, `map_reduced_partial`, `ingest_triggered`, `ingest_published`, `ingest_rejected`, `ingest_replay`, `ingest_replay_unavailable`, `shutdown`, `unhandled_rejection`, `uncaught_exception`.

## How it works

1. **`POST /session/start`** spawns Claude in a detached tmux session with `--permission-mode auto`
2. **`POST /trigger`** sends prompts via `tmux send-keys` (or queues if busy) and assigns a task ID
3. **Claude Code hooks** forward lifecycle events (start, prompt, stop, end) to the haiflow server via HTTP
4. On task completion, the server extracts assistant messages from the session transcript and saves them keyed by task ID
5. **`GET /responses/:id`** returns the response once complete, or `pending`/`queued` status while in progress
6. The queue auto-drains — when Claude finishes one task, the next queued prompt is sent automatically

### Context management

Context filling isn't a problem with haiflow. Each session is tied to the current task — once the task completes, the session can close cleanly with no leftover context. But this is optional: if the session is still healthy, haiflow keeps it alive so context builds up across tasks, giving Claude more awareness of prior work in the same session. If context does fill up, the next task simply starts a fresh session.

## Integration examples

Haiflow works with any tool that can make HTTP requests. Here are a few examples:

### n8n (example workflow templates included)

Import the chained calc workflow from `examples/chained-calc/`:
- `chained-calc-step1.json` — Step 1: calculate 2+2
- `chained-calc-step2.json` — Step 2: multiply result by 5
- `chained-calc-step3.json` — Step 3: multiply result by 10
- `pipeline-calc-chain.json` — Pipeline configuration that wires them together

### MCP server (drive haiflow from any agent)

`integrations/haiflow-mcp/` is an MCP server that exposes haiflow as tools (`haiflow_run`, `haiflow_start_session`, `haiflow_trigger`, `haiflow_get_response`, `haiflow_stop_session`, `haiflow_status`, `haiflow_doctor`, `haiflow_map`), so any MCP-capable agent (Claude Desktop, Cursor, Cline, another Claude Code) can orchestrate Claude Code through haiflow. See `integrations/haiflow-mcp/README.md` for wiring. Inside Claude Code, the `haiflow` skill teaches an agent to drive the HTTP API directly.

### GitHub bridge

Mention `@haiflow` in a GitHub issue or PR comment and Claude Code addresses it in the locally checked-out repo: on a branch, as a **draft** PR, never touching the default branch. The bridge is a thin, gated relay; Claude does the branch/commit/PR work itself (it has `gh` and `git` in the session).

```bash
# point GITHUB_SESSION at a session whose cwd is the cloned repo
haiflow github          # or: bun run github
```

It listens for GitHub webhooks (default port `3334`), verifies the `X-Hub-Signature-256` HMAC against `GITHUB_WEBHOOK_SECRET`, and only acts when **both** `GITHUB_ALLOWED_REPOS` and `GITHUB_ALLOWED_SENDERS` match.

> ⚠️ **Both allowlists are the trust boundary.** With either empty, every webhook is refused. Anyone who can comment on an allowlisted repo can drive Claude, so keep the repo and sender lists tight. The comment text is treated as untrusted input (wrapped in a data frame), and Claude is instructed to open a draft PR and never push the default branch — but review its PRs before merging.

### Cron job

```bash
0 9 * * * curl -X POST http://localhost:3333/trigger \
  -H "Authorization: Bearer $HAIFLOW_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"prompt": "/daily-update", "id": "daily-'$(date +\%Y\%m\%d)'", "source": "cron"}'
```

### Shell alias

```bash
alias ct='curl -s -X POST http://localhost:3333/trigger \
  -H "Authorization: Bearer $HAIFLOW_API_KEY" \
  -H "Content-Type: application/json" -d'
ct '{"prompt": "explain the error in the logs", "id": "debug-1"}'
```

## Worker pools & map-reduce

Define a pool of member sessions in `pipeline.json` and haiflow load-balances work across them. `POST /pool/:name/trigger` sends one prompt to an idle member; `POST /map` fans a list of items across the pool in parallel and fires a reducer once every item returns (the fan-in / JOIN). Because it all runs on one flat subscription, mapping 40 files across a pool of workers costs nothing extra per token. See [Worker pools & map-reduce](API.md) in the API reference for the full request shape.

```json
{ "pools": { "reviewers": { "members": ["reviewer-1", "reviewer-2", "reviewer-3"] } } }
```

## Pipeline

The pipeline system lets you chain agents together using pub/sub topics. When an agent finishes a task, haiflow automatically emits its output to configured topics. Other agents subscribed to those topics receive the output as their next prompt.

### How it works

1. Agent finishes a task → `/hooks/stop` fires
2. Haiflow checks if the session has emitter topics in `pipeline.json`
3. Output is published to those topics (persisted in Redis with delivery tracking)
4. Subscriber agents receive the message, rendered through their prompt template
5. If a subscriber is busy, the message queues up and drains automatically

### Setup

1. **Create `pipeline.json`** in your `HAIFLOW_DATA_DIR` (default `/tmp/haiflow`):

```json
{
  "topics": {
    "design.ready": {
      "description": "Design agent completed its analysis",
      "subscribers": [
        {
          "session": "developer",
          "promptTemplate": "Implement this design:\n\n{{message}}"
        }
      ]
    },
    "code.ready": {
      "subscribers": [
        {
          "session": "code-reviewer",
          "promptTemplate": "Review these changes:\n\n{{message}}"
        }
      ]
    }
  },
  "emitters": {
    "design-agent": ["design.ready"],
    "developer": ["code.ready"]
  }
}
```

2. **Start your agents** and trigger the first one. The pipeline handles the rest.

```bash
# Start all agents in the chain
curl -X POST http://localhost:3333/session/start \
  -H "Authorization: Bearer $HAIFLOW_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"session": "design-agent", "cwd": "/path/to/project"}'

curl -X POST http://localhost:3333/session/start \
  -H "Authorization: Bearer $HAIFLOW_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"session": "developer", "cwd": "/path/to/project"}'

# Trigger the first agent — the pipeline chains the rest
curl -X POST http://localhost:3333/trigger \
  -H "Authorization: Bearer $HAIFLOW_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Analyse the Figma design at ...", "session": "design-agent"}'
```

### Prompt templates

Templates use `{{variable}}` placeholders:

| Variable | Description |
|----------|-------------|
| `{{message}}` | The source agent's output text |
| `{{topic}}` | The topic name (e.g. `design.ready`) |
| `{{sourceSession}}` | The session that emitted the event |
| `{{taskId}}` | The source task ID |

### Outbound webhooks

Topics can fire webhooks when events are published — no polling needed. Add a `webhooks` array to any topic in `pipeline.json`:

```json
{
  "topics": {
    "review.done": {
      "subscribers": [...],
      "webhooks": [
        {
          "url": "https://your-n8n.example.com/webhook/review-done",
          "headers": { "X-Pipeline-Secret": "your-secret" }
        }
      ]
    }
  }
}
```

Haiflow POSTs the event payload to each URL:

```json
{
  "topic": "review.done",
  "sourceSession": "code-reviewer",
  "taskId": "task_1234_abc",
  "message": "Review complete. No issues found...",
  "publishedAt": "2026-04-06T10:00:00Z"
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `url` | — | Webhook endpoint URL |
| `method` | `POST` | HTTP method |
| `headers` | `{}` | Custom headers (merged with `Content-Type: application/json`) |
| `enabled` | `true` | Set to `false` to disable |

### External publishing

Inject events from outside (n8n, scripts, webhooks):

```bash
curl -X POST http://localhost:3333/publish \
  -H "Authorization: Bearer $HAIFLOW_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"topic": "design.ready", "message": "New login page design: ..."}'
```

### Introspection

```bash
# View pipeline config, Redis status, and recent events
curl -s -H "Authorization: Bearer $HAIFLOW_API_KEY" \
  http://localhost:3333/pipeline | jq .

# List topic names
curl -s -H "Authorization: Bearer $HAIFLOW_API_KEY" \
  http://localhost:3333/pipeline/topics | jq .
```

### Safety

- **Circular protection**: If agent A emits to a topic that eventually routes back to A, the cycle is detected and skipped
- **Emitter allowlist**: Only sessions listed in `emitters` can publish to a topic (except `POST /publish` which uses `"external"`)
- **Webhook retry**: Failed webhook deliveries are retried with exponential backoff (max 5 attempts)
- **Event replay**: Unprocessed events are replayed on server restart

See `examples/chained-calc/pipeline-calc-chain.json` for a chained calc workflow example.

## Project structure

```
haiflow/
├── src/
│   ├── index.ts              # Bun HTTP server
│   ├── github-bot.ts         # GitHub webhook bridge (haiflow github)
│   └── dashboard/            # Web dashboard (React + Tailwind)
│       ├── index.html
│       ├── app.tsx
│       ├── api.ts
│       └── components/
├── tests/
│   ├── api.test.ts                  # API integration tests
│   ├── auth.test.ts                 # Auth middleware tests
│   ├── consumer-lifecycle.test.ts   # E2E: start → payload → response → stop (fake Claude, no auth needed)
│   ├── integration.test.ts          # E2E against the REAL Claude CLI (skipped without it)
│   ├── fixtures/fake-claude.ts      # Test double that drives the hook lifecycle deterministically
│   └── index.test.ts                # Unit tests
├── bin/
│   ├── haiflow.ts            # CLI wrapper
│   ├── check-deps.sh         # Dependency checker
│   └── doctor.sh             # Full system health check
├── hooks/
│   ├── forward.sh            # Shared: guard + forward to haiflow server
│   ├── session-start.sh      # SessionStart hook
│   ├── prompt.sh             # UserPromptSubmit hook
│   ├── stop.sh               # Stop hook
│   └── session-end.sh        # SessionEnd hook
├── examples/
│   └── chained-calc/         # Chained calc workflow (n8n steps + pipeline config)
├── assets/
│   └── demo.gif              # Demo recording
├── API.md                    # Full API reference
├── .env.example
├── tsconfig.json
├── package.json
└── LICENSE
```

### Scripts

| Command | Description |
|---------|-------------|
| `bun run setup` | Install Claude Code hooks |
| `bun run dev` | Start server with hot reload |
| `bun run start` | Start server |
| `bun run github` | Run the GitHub webhook bridge |
| `bun run deps` | Check all dependencies |
| `bun run doctor` | Full health check (server, n8n, sessions, pipeline) |
| `bun test` | Run tests |

## License

MIT
