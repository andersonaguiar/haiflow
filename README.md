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
haiflow start worker --cwd /path/to/your/project   # in another shell
```

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
| `HAIFLOW_DATA_DIR` | `/tmp/haiflow` | Directory for session state, queues, and responses |
| `HAIFLOW_PORT` | `3333` | Port used by hook scripts (set if different from PORT) |
| `HAIFLOW_API_KEY` | — | **Required.** Any string you choose — this is your own secret, not a paid key |
| `REDIS_URL` | `redis://localhost:6379` | **Required.** Redis URL for event persistence and delivery tracking |
| `N8N_API_KEY` | — | n8n API key for workflow integration |

## Authentication

`HAIFLOW_API_KEY` is required — pick any string you like (e.g. `openssl rand -hex 32`). It's not a third-party key or paid credential, just a secret you define to protect your server.

**Why this matters:** Without auth, anyone who can reach your server could send arbitrary prompts to Claude Code running with full file and git access. That means reading your source code, modifying files, running shell commands, or exfiltrating data — all through a simple HTTP request.

The server will refuse to start without it. All API endpoints (except `/health` and `/hooks/*`) require an `Authorization` header:

```bash
curl -H "Authorization: Bearer your-secret-key" http://localhost:3333/sessions
```

Hooks are excluded from auth since they come from Claude Code running locally — requests to `/hooks/*` are restricted to localhost.

### Exposing to the internet

If you need to access haiflow remotely (from n8n cloud, webhooks, etc.), see [DEPLOYMENT.md](DEPLOYMENT.md) for a guide on setting up Cloudflare Zero Trust Access — adds an identity layer so a stolen API key alone isn't enough.

## API

See [API.md](API.md) for the full API reference — all endpoints, parameters, and examples.

## Dashboard

Haiflow includes a built-in web dashboard for monitoring and controlling sessions in real-time.

```
http://localhost:3333/dashboard
```

Enter your `HAIFLOW_API_KEY` to authenticate, then you get a two-panel layout:

- **Left panel** — all sessions with live status badges (idle/busy/offline), remove offline sessions with ×
- **Right panel** — current prompt (when busy), tabbed Queue/Responses view with expandable items showing full prompt and response text
- **Actions** — start/stop sessions, send prompts, clear queue/responses

The dashboard auto-refreshes every 3 seconds. No extra setup needed — it's served by the same Bun server.

## Logging

Haiflow outputs structured JSON logs to stdout/stderr for all key events:

```jsonl
{"ts":"2026-03-18T02:35:00Z","level":"info","event":"server_started","port":3333,"auth":true}
{"ts":"2026-03-18T02:35:01Z","level":"info","event":"session_started","session":"worker","cwd":"/app"}
{"ts":"2026-03-18T02:35:02Z","level":"info","event":"trigger_sent","session":"worker","taskId":"task-001"}
{"ts":"2026-03-18T02:35:09Z","level":"info","event":"response_saved","session":"worker","taskId":"task-001","source":"transcript"}
{"ts":"2026-03-18T02:35:10Z","level":"warn","event":"auth_rejected","path":"/trigger"}
```

Events: `server_started`, `sessions_recovered`, `session_started`, `session_stopped`, `session_start_failed`, `trigger_sent`, `trigger_queued`, `trigger_failed`, `queue_drained`, `queue_cleared`, `response_saved`, `stream_opened`, `hook_session_start`, `hook_stop`, `hook_session_end`, `auth_rejected`, `redis_connected`, `redis_unavailable`, `event_published`, `event_published_direct`, `pipeline_dispatched`, `pipeline_queued`, `pipeline_subscriber_offline`, `pipeline_circular_skipped`, `pipeline_prompt_too_large`, `pipeline_webhook_sent`, `pipeline_webhook_failed`, `publish_unknown_topic`, `publish_unauthorized`.

## How it works

1. **`POST /session/start`** spawns Claude in a detached tmux session with `--dangerously-skip-permissions`
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
│   └── dashboard/            # Web dashboard (React + Tailwind)
│       ├── index.html
│       ├── app.tsx
│       ├── api.ts
│       └── components/
├── tests/
│   ├── api.test.ts           # API integration tests
│   ├── auth.test.ts          # Auth middleware tests
│   └── index.test.ts         # Unit tests
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
| `bun run deps` | Check all dependencies |
| `bun run doctor` | Full health check (server, n8n, sessions, pipeline) |
| `bun test` | Run tests |

## License

MIT
