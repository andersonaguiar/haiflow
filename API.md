# API Reference

All endpoints (except `/health` and `/hooks/*`) require an `Authorization: Bearer <HAIFLOW_API_KEY>` header. `HAIFLOW_API_KEY` is any secret string you define — not a paid key or external credential.

## `POST /session/start`

Start a Claude Code session in a detached tmux session.

```bash
curl -X POST http://localhost:3333/session/start \
  -H "Content-Type: application/json" \
  -d '{"session": "worker", "cwd": "/path/to/project"}'
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `cwd` | string | **Yes** | Working directory for Claude |
| `session` | string | No | Session name (default: `"default"`) |

## `POST /session/stop`

Kill a Claude tmux session.

```bash
curl -X POST http://localhost:3333/session/stop \
  -H "Content-Type: application/json" \
  -d '{"session": "worker"}'
```

## `POST /session/remove`

Remove an offline session's data (state, queue, responses). Only works on offline sessions.

```bash
curl -X POST http://localhost:3333/session/remove \
  -H "Content-Type: application/json" \
  -d '{"session": "worker"}'
```

## `POST /interrupt`

Send a control key into a running session's TUI, optionally followed by a steering prompt. Use it to unstick a session wedged on a permission prompt, or to redirect a running agent.

```bash
curl -X POST http://localhost:3333/interrupt \
  -H "Authorization: Bearer $HAIFLOW_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"session": "worker", "mode": "escape", "prompt": "stop and run the tests instead"}'
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `session` | string | No | Session name (default: `"default"`) |
| `mode` | string | No | `escape` (default, cancels the current generation/tool without exiting) or `ctrl-c` (harsher) |
| `prompt` | string | No | A steering prompt typed in after the interrupt settles. Passes the same structural checks as `/trigger` |

Returns `{ "interrupted": true, "session": "worker", "mode": "escape", "steered": true }`. `404` if the session is not running.

> **Watchdog & `waiting`.** Claude Code's `Notification` hook tells haiflow when a session is blocked needing input mid-task; that session is flagged `waiting` (visible on `GET /status`). A background watchdog also flags tasks past `HAIFLOW_TASK_TIMEOUT_SEC`. By default the watchdog only logs a `watchdog_triggered` warning; set `HAIFLOW_WATCHDOG_RECOVER=true` to have it auto-recover (Escape, mark the task `timed_out`, drain the queue). Run `haiflow setup` again after upgrading to register the new `Notification` hook.

## `POST /trigger`

Send a prompt to Claude. If Claude is busy, the prompt is auto-queued and sent when idle.

```bash
curl -X POST http://localhost:3333/trigger \
  -H "Content-Type: application/json" \
  -d '{"prompt": "summarize recent commits", "session": "worker", "id": "task-001"}'
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `prompt` | string | **Yes** | The prompt or slash command to send |
| `session` | string | No | Session name (default: `"default"`) |
| `id` | string | No | Custom task ID (auto-generated if omitted) |
| `source` | string | No | Label for where the trigger came from |

Responses:
- **Idle**: `{"id": "...", "sent": true}` — sent immediately
- **Busy**: `{"id": "...", "queued": true, "position": 1}` — auto-sends when idle
- **Offline**: `503` error

## `GET /responses/:id`

Get the response for a completed task.

```bash
curl -s "http://localhost:3333/responses/task-001?session=worker" | jq .
```

```json
{
  "id": "task-001",
  "completed_at": "2025-03-18T02:35:09Z",
  "messages": ["Here's a summary of recent commits..."]
}
```

Status codes:
- **200**: Complete — response body included
- **202**: `{"status": "pending"}` or `{"status": "queued"}`
- **404**: Unknown task ID

## `GET /responses/:id/stream`

Stream response status via Server-Sent Events. Opens a persistent connection that sends real-time updates until the task completes — no polling required.

```bash
curl -N "http://localhost:3333/responses/task-001/stream?session=worker"
```

| Param | Default | Description |
|-------|---------|-------------|
| `timeout` | `300` | Max seconds to wait (capped at 600) |

Events:
- **`status`**: `{"id": "...", "status": "pending"}` or `{"status": "queued", "position": 2}`
- **`complete`**: Full response object (same as `GET /responses/:id`)
- **`error`**: `{"error": "Session is offline"}`
- **`timeout`**: Sent when the timeout is reached

Example with EventSource (browser/Node):

```js
const es = new EventSource("http://localhost:3333/responses/task-001/stream?session=worker");
es.addEventListener("complete", (e) => {
  const response = JSON.parse(e.data);
  console.log(response.messages);
  es.close();
});
es.addEventListener("status", (e) => console.log("Status:", JSON.parse(e.data)));
es.addEventListener("error", (e) => { console.error(e.data); es.close(); });
es.addEventListener("timeout", () => { console.log("Timed out"); es.close(); });
```

## `GET /status`

```bash
curl -s http://localhost:3333/status?session=worker | jq .
```

## `GET /sessions`

List all sessions and their status.

## `GET /responses`

List all completed response IDs.

## `DELETE /responses`

Clear all saved responses for a session.

```bash
curl -X DELETE -H "Authorization: Bearer $HAIFLOW_API_KEY" \
  "http://localhost:3333/responses?session=worker"
```

```json
{ "session": "worker", "cleared": true, "count": 5 }
```

## `GET /queue`

View queued prompts for a session.

## `DELETE /queue`

Clear all queued prompts.

## Task ledger

Every task is recorded in a durable SQLite ledger (`haiflow.db` in `HAIFLOW_DATA_DIR`). On completion, haiflow mines the Claude Code transcript it already parses for the Stop hook and stores the ordered tool calls, commands run, files changed, real diffs, token usage, model, and timing. Durability across reboots depends on `HAIFLOW_DATA_DIR` pointing somewhere persistent (the default `/tmp/haiflow` is wiped on reboot).

### `GET /tasks`

List recorded tasks, newest first.

```bash
curl -s -H "Authorization: Bearer $HAIFLOW_API_KEY" \
  "http://localhost:3333/tasks?session=worker&status=completed&limit=20" | jq .
```

| Param | Description |
|-------|-------------|
| `session` | Filter by session |
| `status` | `running` \| `completed` \| `timed_out` \| `cancelled` \| `failed` |
| `source` | Filter by trigger source (`trigger`, `queue`, `pipeline:<topic>`, ...) |
| `since` / `until` | ISO timestamps bounding `started_at` |
| `limit` / `offset` | Pagination (limit capped at 500) |

Returns `{ "tasks": [...], "total": N }`. Each task includes `steps[]` (tool name, summary, `isError`, optional `detail`/diff, `filePath`), `usage`, `model`, `duration_ms`, `files_changed`, `commands_run`, and `saved_usd`.

### `GET /tasks/:id`

Get one task by ID (optionally scoped with `?session=`). Includes the saved response `messages` when available.

### `GET /responses/:id/timeline`

The tool/command/diff timeline for a task: `steps`, `durationMs`, `usage`, `model`, `filesChanged`, `commandsRun`.

### `POST /tasks/:id/cancel`

Cancel a single task without killing the warm session or clearing the whole queue.

```bash
curl -X POST -H "Authorization: Bearer $HAIFLOW_API_KEY" \
  "http://localhost:3333/tasks/task-001/cancel?session=worker"
```

- If `id` is the session's running task: sends Escape, records a `cancelled` task + response, returns the session to idle, and drains the next queued prompt. Returns `{ "cancelled": true, "where": "running" }`.
- If `id` is a queued item: removes just that item. Returns `{ "cancelled": true, "where": "queue" }`.
- `404` if the id is neither running nor queued for that session.

### `DELETE /queue/:id`

Remove a single queued item by id (vs `DELETE /queue`, which clears the whole queue).

```bash
curl -X DELETE -H "Authorization: Bearer $HAIFLOW_API_KEY" \
  "http://localhost:3333/queue/task-001?session=worker"
```

## Usage & savings

haiflow runs on a flat Claude Code subscription, so tasks cost nothing per-token. These endpoints report measured token consumption and the equivalent API cost a per-token caller would have paid (an estimate from a maintained price table, not a bill).

### `GET /usage`

Aggregate usage and savings since a timestamp (default: last 24h).

```bash
curl -s -H "Authorization: Bearer $HAIFLOW_API_KEY" \
  "http://localhost:3333/usage?session=worker&since=2026-06-09T00:00:00Z" | jq .
```

Returns `{ since, session, tasks, totalTokens, inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens, savedUsd }`.

### `GET /usage/window`

Rolling 5-hour and 7-day windows (the rate-limit windows), for the whole account or one `?session=`. If `HAIFLOW_USAGE_ALERT_TOKENS` is set, `alert` is `true` when the 5h window crosses it (alert-only, never throttles).

```json
{
  "session": "all",
  "windows": {
    "5h": { "tasks": 3, "totalTokens": 41000, "savedUsd": 0.42 },
    "7d": { "tasks": 88, "totalTokens": 1200000, "savedUsd": 14.10 }
  },
  "alertThresholdTokens": null,
  "alert": false
}
```

## Pipeline

The pipeline system enables event-driven agent chains. When an agent finishes a task, it can emit an event to a topic. Other agents subscribed to that topic automatically receive the output as their next prompt.

Configuration is via `pipeline.json` in your `HAIFLOW_DATA_DIR`. See `examples/chained-calc/pipeline-calc-chain.json` for an example. Topics support two subscriber types: **agent sessions** (receive a rendered prompt) and **outbound webhooks** (receive a JSON POST with the event payload).

### `GET /pipeline`

Get the current pipeline configuration, Redis status, and recent events.

```bash
curl -s -H "Authorization: Bearer $HAIFLOW_API_KEY" \
  http://localhost:3333/pipeline | jq .
```

```json
{
  "topics": { "design.ready": { "subscribers": [...] } },
  "emitters": { "design-agent": ["design.ready"] },
  "redis": true,
  "recentEvents": [
    {
      "topic": "design.ready",
      "sourceSession": "design-agent",
      "taskId": "task_1234_abc",
      "subscribers": ["developer"],
      "publishedAt": "2025-04-06T10:00:00Z"
    }
  ]
}
```

### `GET /pipeline/topics`

List all configured topic names.

```bash
curl -s -H "Authorization: Bearer $HAIFLOW_API_KEY" \
  http://localhost:3333/pipeline/topics | jq .
```

```json
["design.ready", "code.ready", "review.done"]
```

### `POST /publish`

Publish an event to a pipeline topic. Useful for external systems (n8n, scripts) to inject work into the pipeline.

```bash
curl -X POST http://localhost:3333/publish \
  -H "Authorization: Bearer $HAIFLOW_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"topic": "design.ready", "message": "New design for the login page: ..."}'
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `topic` | string | **Yes** | Topic name to publish to |
| `message` | string | **Yes** | Message content (passed to subscriber prompt templates as `{{message}}`) |
| `session` | string | No | Source session name (default: `"external"`) |

## `GET /health`

Returns `ok`.
