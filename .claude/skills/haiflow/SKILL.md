---
name: haiflow
description: Drive the haiflow HTTP orchestrator to run Claude Code via API — start sessions, send prompts/payloads, stream or poll responses, stop sessions, plus fire-and-forget jobs, queues, worker pools + map-reduce, and event pipelines. Use when an agent or service needs to programmatically run Claude Code through haiflow's REST API (POST /session/start, /trigger, GET /responses/:id/stream, /session/stop, /map, /publish, /ingest), wire a consumer/integration to haiflow, debug why a haiflow trigger never returned, or design a multi-agent haiflow workflow.
---

# Driving haiflow

haiflow is an HTTP orchestrator for Claude Code: it runs Claude in detached tmux sessions and exposes a REST API to start sessions, trigger prompts, capture responses, and chain agents. This skill is the procedural guide for *driving* that API well.

**Authoritative references in this repo — read them for exact contracts; do not rely on memory:**
- `API.md` — every endpoint, field, status code, and response shape.
- `README.md` — setup, architecture, env vars, the security/redaction model.
- `src/index.ts` — the server implementation (the source of truth when docs and behaviour disagree).

All endpoints except `/health`, `/version`, `/hooks/*`, and `/ingest/*` need `Authorization: Bearer $HAIFLOW_API_KEY`.

## The core lifecycle (the 90% case)

A consumer runs four steps. Always pass the **same `session`** to every call.

```bash
# 1. Start (one session per concurrent stream of work). cwd is optional: it defaults to HAIFLOW_CWD if pinned, otherwise /tmp.
curl -sX POST $H/session/start -H "Authorization: Bearer $K" -H 'Content-Type: application/json' \
  -d '{"session":"worker","cwd":"/path/to/project"}'      # -> {"started":true,"ready":true,...}

# 2. Trigger the prompt/payload (give an id so you can fetch the result).
curl -sX POST $H/trigger -H "Authorization: Bearer $K" -H 'Content-Type: application/json' \
  -d '{"session":"worker","id":"t1","prompt":"summarize recent commits"}'   # -> {"sent":true} or {"queued":true}

# 3. Stream the result over SSE (no polling). Wait for the `complete` event.
curl -N "$H/responses/t1/stream?session=worker&timeout=300" -H "Authorization: Bearer $K"

# 4. Stop when done.
curl -sX POST $H/session/stop -H "Authorization: Bearer $K" -d '{"session":"worker"}'
```

Get a result two ways: **SSE** `GET /responses/:id/stream` (push: `status` events then a `complete` event) or **poll** `GET /responses/:id` (`200` done, `202` pending/queued, `404` unknown). Prefer SSE. Multiline payloads are fine — send `\n`s in `prompt`, they arrive as one prompt.

## Fire-and-forget (one trigger, no manual lifecycle)

Two independent, optional `/trigger` fields (use one, both, or neither):
- `"ephemeral": true` (+ `cwd`): if the session is offline, haiflow auto-starts it, runs the task, and **stops it after responding**. One self-contained job from a single call.
- `"callbackUrl": "https://…"`: haiflow POSTs the result (`{event:"task.completed", id, session, messages, model, usage, completedAt}`) when the task finishes — no need to hold an SSE connection. Gated server-side: needs `HAIFLOW_ALLOW_TRIGGER_CALLBACK=true` and (optionally) `HAIFLOW_CALLBACK_ALLOW_HOSTS`. Disabled → `400`.

```bash
curl -sX POST $H/trigger -H "Authorization: Bearer $K" -H 'Content-Type: application/json' -d '{
  "session":"oneshot","cwd":"/path/to/project","prompt":"run the tests and report",
  "ephemeral":true, "callbackUrl":"https://my-app.example.com/haiflow-done"}'
```

## More capabilities (see `API.md` for full contracts)

- **Smart queue**: `/trigger` auto-queues when busy. Fields: `priority` (higher drains first), `dedupKey` (drop duplicates), `delaySeconds`/`notBefore` (schedule). Inspect/reprioritise via `/queue`, `POST /queue/:id`, `DELETE /queue/:id`.
- **Worker pools + map-reduce**: define pools in `pipeline.json`; `POST /pool/:name/trigger` load-balances; `POST /map` fans items across the pool in parallel and runs a reducer when all return (the fan-in JOIN).
- **Event pipeline**: agents emit to topics on completion; subscribers (other sessions or outbound webhooks) receive the output as their next prompt. `POST /publish` injects events; config in `pipeline.json`.
- **Signed inbound webhooks**: `POST /ingest/:source` lets a SaaS webhook drive a task with HMAC verification (no bearer key shared). Recipes in `ingest.json`.
- **Task ledger & usage**: `GET /tasks`, `/tasks/:id`, `/responses/:id/timeline` (tool/command/diff timeline, tokens, model); `GET /usage`, `/usage/window` (savings vs per-token API).
- **Control**: `POST /interrupt` (unstick a wedged session / steer it), `POST /tasks/:id/cancel`, `GET /doctor` (health).

## Gotchas (the things that actually bite consumers)

1. **Hooks must be wired.** Responses are captured via Claude Code's Stop hook calling back to haiflow. If hooks aren't installed (`haiflow setup`), `/session/start` now fails fast (`409`, "hooks are likely not wired") instead of silently dropping every response. Check `GET /doctor?session=…` — unhealthy is `tmuxRunning:true, hooksLinked:false`.
2. **`?session=` is load-bearing** on `/responses/:id`, `/responses/:id/stream`, `/status`, `/queue`. Omit it and you silently read the `"default"` session. Always pass the session you triggered on.
3. **Offline trigger → `503`** (unless `ephemeral` auto-starts it). Start the session first, or use `ephemeral`.
4. **One session = one serial worker.** Concurrent work needs distinct session names or a pool. Don't multiplex unrelated streams on one session — a second trigger queues behind the first.
5. **Idempotent start**: starting an already-running session returns `{started:true}` (reused), so retries are safe.
6. **Outbound text is redacted** (API keys, tokens, JWTs) before it leaves — responses, callbacks, pipeline messages. Expect `[REDACTED:type]` markers; it's best-effort DLP, not a guarantee.
7. **`HAIFLOW_CWD`/`HAIFLOW_ALLOW_REQUEST_CWD`** may override or reject a requested `cwd`; the start response includes `cwdOverridden:true` when it did.

## Designing a consumer or integration

- Quick scripts / services: call the REST API directly (the lifecycle above). For a self-contained job, prefer `ephemeral` + `callbackUrl` over holding an SSE connection.
- n8n: this repo ships an n8n node (`integrations/n8n-nodes-haiflow`) and the `haiflow-n8n` skill — use those for n8n-specific design.
- Building a new integration end to end: the `integration-builder` skill walks through discovery → design → wiring.
