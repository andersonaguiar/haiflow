---
name: integration-builder
description: >-
  Guided integration builder powered by haiflow. Helps users discover, design,
  and build integrations between services, APIs, and tools. Uses context7 MCP to
  research library/API docs in real-time. Supports two execution paths: (1) n8n
  workflows that call haiflow endpoints to orchestrate Claude Code, auto-deployed
  via n8n MCP if API keys are available; (2) raw Bun/TypeScript integrations that
  call haiflow directly. Triggers on: integrate, connect X to Y, build an
  integration, sync X with Y, automate X, webhook from X, n8n workflow for X,
  how do I connect X to Y, or any request to link two or more services together.
---

# Integration Builder

Build integrations between services using **haiflow** as the AI orchestration layer. Haiflow wraps Claude Code in tmux sessions and exposes a REST API — integrations trigger prompts, queue work, and poll for responses over HTTP.

**Project references** (read these for API details, don't duplicate):
- `README.md` — Full API docs, setup, and architecture
- `src/index.ts` — Endpoint implementations and types
- `examples/n8n-workflows/` — Existing n8n workflow templates

## Workflow

1. **Discover** — What services to connect, what triggers the flow, what data moves
2. **Research** — Look up API/library capabilities via context7
3. **Propose** — Recommend n8n or raw integration path, present the plan
4. **Build** — Create the workflow or code
5. **Deploy** — Activate in n8n or hand off runnable code

---

## Phase 1: Discover

Ask concise questions (max 3 per message) to understand:

- **Source system(s)** — Where does data/event originate?
- **Destination system(s)** — Where should data/action land?
- **Trigger** — Webhook, schedule, manual, or polling?
- **Data flow** — What moves between systems? Transforms needed?
- **Path preference** — n8n workflow or raw code?

**n8n vs raw code decision:**

| Factor | n8n | Raw code |
|--------|-----|----------|
| User has n8n instance or n8n MCP available | Prefer | - |
| Visual workflow management needed | Prefer | - |
| Many conditional branches | Prefer | - |
| High-performance / low-latency | - | Prefer |
| Deep custom logic / complex transforms | - | Prefer |
| User explicitly prefers code | - | Prefer |

Default to n8n if user mentions it or `mcp__n8n-mcp__*` tools are available.

---

## Phase 2: Research

Use **context7 MCP** to research each service/library involved:

1. `mcp__context7__resolve-library-id` — Resolve each service/library name
2. `mcp__context7__query-docs` — Query for:
   - Authentication methods
   - Available endpoints / webhook events
   - Rate limits or quirks
   - SDK availability

Summarise what affects integration design:
- Auth type (API key, OAuth, webhook secret)
- Available triggers/events
- Data format (JSON, XML, form-data)
- Limitations

Fallback: If context7 doesn't cover a service, use `WebSearch` or `WebFetch`.

---

## Phase 3: Propose

Present the integration plan. Always show how haiflow fits in the flow.

**n8n proposal format:**
```
## Proposed Workflow

Trigger: [type]
Flow: [Event Source] → n8n → haiflow /trigger → Claude Code → /responses/:id → [Action]

Nodes:
1. [Trigger] — [description]
2. POST /trigger — send prompt to Claude via haiflow
3. [Wait/Poll] — poll /responses/:id
4. [Action] — use Claude's response
```

**Raw code proposal format:**
```
## Proposed Integration

Runtime: Bun
Entry: integration.ts
Trigger: [HTTP endpoint / schedule / CLI]

Flow:
1. [Receive event / run on schedule]
2. POST /trigger with prompt
3. Poll /responses/:id until complete
4. [Process response and take action]
```

Confirm before building.

---

## Phase 4: Build

### n8n Path

Read `examples/n8n-workflows/` for existing haiflow + n8n templates. Use them as the base.

The core n8n + haiflow pattern:
1. **Trigger node** — webhook, schedule, or service event
2. **HTTP Request** — `POST /trigger` with `{prompt, session, id, source}`
3. **Wait node** — pause 10-30s for Claude to process
4. **HTTP Request** — `GET /responses/:id` to poll
5. **IF node** — check `status === "pending"` or `status === "queued"`, loop back if so
6. **Action node** — use `messages[]` from the completed response

Use n8n MCP tools to deploy:
- `mcp__n8n-mcp__search_workflows` — find existing
- `mcp__n8n-mcp__get_workflow_details` — inspect
- `mcp__n8n-mcp__execute_workflow` — create/execute

If n8n MCP unavailable, save workflow JSON to `examples/n8n-workflows/` for manual import.

### Raw Code Path

Follow CLAUDE.md conventions (Bun, no dotenv, TypeScript). The core pattern:

```ts
const HAIFLOW = process.env.HAIFLOW_URL || "http://localhost:3333";

// 1. Trigger
const { id } = await fetch(`${HAIFLOW}/trigger`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ prompt, session: "default", source: "integration" }),
}).then(r => r.json());

// 2. Poll
let result;
while (true) {
  const res = await fetch(`${HAIFLOW}/responses/${id}`);
  result = await res.json();
  if (res.status === 200) break; // done
  await Bun.sleep(5000); // 202 = pending/queued
}

// 3. Use result.messages[]
```

Read `src/index.ts` for the full endpoint API, types, and status codes.

---

## Phase 5: Deploy

### n8n
- Verify workflow via `mcp__n8n-mcp__get_workflow_details`
- Confirm haiflow running: `GET /health`
- Confirm Claude session active: `GET /status`
- List credentials needing manual n8n UI setup

### Raw Code
- Show run command: `bun run <file>`
- Remind to ensure haiflow + Claude session running:
  ```bash
  bun run src/index.ts
  curl -X POST localhost:3333/session/start -d '{"cwd":"/path/to/project"}'
  ```
- List env vars to set

---

## Error Handling

- context7 miss → try alternate library names, then web search
- n8n MCP unavailable → generate importable workflow JSON in `examples/n8n-workflows/`
- haiflow offline → remind user to start it and the Claude session
- Auth unclear → ask the user, don't guess
- Claude busy → haiflow auto-queues; integrations should handle 202 responses
