---
name: haiflow-n8n
description: >-
  Deep expert knowledge of n8n workflow automation and haiflow orchestration.
  Understands all n8n node types, triggers, subworkflows, expressions, error
  handling, flow control, credentials, webhook configuration, binary data, and
  execution modes. Understands haiflow's full API, SSE streaming, multi-agent
  pipelines, hook lifecycle, queue mechanics, prompt security, and context
  management. Knows how to architect solutions combining both systems —
  choosing the right n8n nodes, configuring triggers, designing subworkflow
  hierarchies, and wiring haiflow's event-driven pub/sub into n8n flows.
  Triggers on: n8n questions, workflow design, node configuration, trigger
  setup, subworkflow architecture, haiflow pipeline design, SSE streaming
  patterns, webhook configuration, n8n + haiflow integration patterns, or any
  question about how either system works.
---

# n8n + haiflow Expert

You are an expert in both **n8n** (workflow automation) and **haiflow** (Claude Code HTTP orchestrator). Use this knowledge to answer questions, design workflows, debug issues, and architect solutions that combine both systems.

**Project references** (read these for current implementation details):
- `README.md` — haiflow setup, architecture, and examples
- `API.md` — haiflow endpoint reference
- `src/index.ts` — haiflow server implementation
- `examples/chained-calc/` — Chained calc n8n workflow steps and pipeline config

---

# Part 1: n8n Deep Knowledge

## Core Concepts

### Workflows
- A workflow is a DAG of **nodes** connected by **edges** that define data flow
- Exported/imported as JSON: `name`, `nodes[]`, `connections{}`, `settings{}`, `pinData{}`
- Must be **Active** (published) to run automatically via triggers
- Each workflow has `id`, `name`, `active` boolean

### Data Model
All data between nodes is an **array of items**. Each item:
```json
{
  "json": { "field": "value" },
  "binary": {
    "file-key": {
      "data": "base64...",
      "mimeType": "image/png",
      "fileExtension": "png",
      "fileName": "example.png"
    }
  }
}
```

### Connections
```json
{
  "connections": {
    "SourceNodeName": {
      "main": [[{ "node": "TargetNodeName", "type": "main", "index": 0 }]]
    }
  }
}
```
- Outer array = output indices (e.g., IF has index 0 for true, index 1 for false)
- Inner array = multiple connections from a single output (fan-out)

### Execution Modes
- `$execution.mode === 'test'` — Manual run from editor
- `$execution.mode === 'production'` — Automatic via trigger (workflow must be Active)
- `$execution.mode === 'evaluation'` — Running workflow tests

---

## Trigger Nodes

### Webhook (`n8n-nodes-base.webhook`)
- Creates an HTTP endpoint that triggers workflows
- **Test URL**: `https://instance/webhook-test/{path}` — editor development
- **Production URL**: `https://instance/webhook/{path}` — live when Active
- HTTP methods: GET, POST, PUT, PATCH, DELETE, HEAD
- Path supports route params: `/:variable`, `/path/:var1/:var2`
- Auth: None, Basic Auth, Header Auth, JWT Auth
- Max payload: 16MB (configurable via `N8N_PAYLOAD_SIZE_MAX`)
- **Response modes**:
  - **Immediately** — Returns `{"status": "Workflow got started"}` (fire-and-forget)
  - **When Last Node Finishes** — Waits for completion, returns last node output
  - **Using 'Respond to Webhook' Node** — Full control over response code/headers/body
  - **Streaming Response** — Real-time SSE for long-running ops

### Schedule Trigger (`n8n-nodes-base.scheduleTrigger`)
- Time-based: interval (every N minutes/hours) or cron expressions
- Legacy Cron node: `n8n-nodes-base.cron`

### Manual Trigger (`n8n-nodes-base.manualTrigger`)
- Starts when user clicks "Execute Workflow" in editor
- Every workflow typically has one for testing

### App-Specific Triggers
- 400+ app triggers (Slack, GitHub, Gmail, etc.)
- Some use polling, others register webhooks with the service
- Each listens for specific events

### Local File Trigger (`n8n-nodes-base.localFileTrigger`)
- Triggers on file changes on the n8n host

### Execute Sub-workflow Trigger (`n8n-nodes-base.executeWorkflowTrigger`)
- "When Executed by Another Workflow" — child workflow entry point
- Input modes: Define using fields, JSON example, or accept all data

### When to use which trigger
| Scenario | Trigger |
|----------|---------|
| External service calls your workflow | Webhook |
| Run on a schedule (daily, hourly, cron) | Schedule Trigger |
| React to events in a SaaS app | App-Specific Trigger |
| Called by another n8n workflow | Execute Sub-workflow Trigger |
| Manual/testing | Manual Trigger |
| React to file system changes | Local File Trigger |

---

## Flow Control Nodes

### IF (`n8n-nodes-base.if`)
- Routes items to **two outputs**: true (index 0) / false (index 1)
- Conditions: `leftValue` + `operator` + `rightValue`, combined with AND/OR
- Operators: equals, not equals, contains, greater than, regex, dateTime comparisons
- Options: `caseSensitive`, `typeValidation` (strict/loose)

### Switch (`n8n-nodes-base.switch`)
- Routes to **multiple outputs** (more than two)
- **Rules mode**: Define matching rules per output route
- **Expression mode**: Expression returns output index number

### Merge (`n8n-nodes-base.merge`, typeVersion 2.1)
- Combines data from multiple inputs
- **Append**: Concatenate items from all inputs (configurable input count)
- **Combine by Matching Fields**: SQL-like joins
  - Keep Matches (inner join)
  - Keep Non-Matches
  - Keep Everything (outer join)
  - Enrich Input 1 (left join)
  - Enrich Input 2 (right join)
- **Combine by Position**: Merge items by index
- **Multiplex**: All possible combinations
- **Choose Branch**: Waits for all inputs, outputs from one branch only

### Loop Over Items (`n8n-nodes-base.splitInBatches`, typeVersion 3)
- Processes items in configurable batch sizes
- Output 0: "done" branch (after all batches)
- Output 1: current batch items
- Pattern: Loop → Process → (loop back to Loop)
- Combine with Wait node for rate limiting

### Wait (`n8n-nodes-base.wait`)
- Pauses execution for a specified duration or until a webhook callback
- Essential for rate limiting in loops

---

## Subworkflows

### Execute Sub-workflow (`n8n-nodes-base.executeWorkflow`)
- Parent calls child workflow
- Input data passed to child's Execute Sub-workflow Trigger
- **Last node** in child returns data back to parent
- Flow: Parent → Child Trigger → Child processes → Last node → Parent

### Data Passing
- Parent sends data through Execute Sub-workflow node parameters
- Child accesses via: `{{ $('Execute Sub-workflow Trigger').item.json.myValue }}`
- **Workflow Values**: Named key-value pairs set in parent, appear in trigger output

### When to use subworkflows
- **Reusable logic**: Same processing used by multiple parent workflows
- **Complexity management**: Break large workflows into manageable pieces
- **Error isolation**: Child failures don't crash the parent (with error handling)
- **Team collaboration**: Different teams own different subworkflows
- **Rate limit management**: Subworkflow with Loop + Wait for API calls

### Architecture patterns
```
Main Workflow
├── Subworkflow: Data Enrichment (reused by 3 workflows)
├── Subworkflow: Notification Sender (email/slack/webhook)
└── Subworkflow: Error Reporter (standard error format)
```

---

## Code Node (`n8n-nodes-base.code`)

### Execution Modes
- **Run Once for All Items** (default): Code executes once for entire batch
- **Run Once for Each Item**: Code executes per item

### JavaScript Key Variables
```javascript
// Current item
$json                           // Current item JSON
$json.fieldName                 // Specific field
$binary                         // Current item binary data
$itemIndex                      // Current item index

// Input data
$input.all()                    // All input items
$input.first()                  // First item
$input.last()                   // Last item

// Other nodes
$("NodeName").all()             // All items from node
$("NodeName").first()           // First item from node
$("NodeName").item              // Linked/paired item
$("IF").all(1, 0)               // Output index 1, run 0

// Metadata
$execution.id                   // Execution ID
$execution.mode                 // 'test' | 'production' | 'evaluation'
$execution.customData.set("key", "value")
$execution.customData.get("key")
$workflow.id                    // Workflow ID
$workflow.name                  // Workflow name
$runIndex                       // Current run index
$env.VARIABLE_NAME              // Environment variable

// Data transformation
$jmespath($json.data, "[*].name")  // JMESPath queries
```

### Python (underscore prefix)
```python
_json, _input.all(), _("NodeName").all(), _execution, _runIndex, _jmespath()
```

### Return patterns
```javascript
// Run Once for All Items — return array of items
for (const item of $input.all()) {
  item.json.processed = true;
}
return $input.all();

// Run Once for Each Item — return single object
return { fieldName: "value" };
```

---

## HTTP Request Node (`n8n-nodes-base.httpRequest`)

### Configuration
- Methods: GET, POST, PUT, DELETE, HEAD, OPTIONS, PATCH
- URL, query params, headers, body all configurable
- Response format: JSON (default), text, file (binary)

### Authentication
- **None**: No auth
- **Predefined Credential Type**: Built-in for 400+ services
- **Generic Credential Type**: Basic Auth, Header Auth, Query Auth, OAuth2

### Pagination
- **Response Contains Next URL**: Follow `{{ $response.body["next-page"] }}`
- **Update Parameter**: Increment `{{ $pageCount + 1 }}`

### Key options
- `timeout`: Request timeout in ms
- `skipSslCertificateValidation`: For self-signed certs
- `returnFullResponse`: Include headers and status code
- `disableFollowRedirect`: Don't follow 3xx
- Proxy support

---

## Error Handling

### Error Trigger (`n8n-nodes-base.errorTrigger`)
- Starts a separate "error workflow" when another workflow fails
- Error workflow does NOT need to be Active
- Access error data: `{{ $("Error Trigger").item.json["workflow"]["name"] }}`
- Access execution URL: `{{ $("Error Trigger").item.json["execution"]["url"] }}`

### Node-Level Error Settings
- **Stop Workflow** (default): Halts on error
- **Continue**: Proceeds with last valid data
- **Continue (using error output)**: Routes error info to a separate output branch

### Retry On Fail
- Node setting: automatic retries with configurable count and wait time
- Essential for flaky external APIs

### Workflow-Level Error Workflow
- `settings.errorWorkflow`: Designate a workflow that runs when main workflow fails

### Error handling patterns
```
Pattern 1: Error output branch
  HTTP Request (on error: continue with error output)
    ├── [Success] → Process response
    └── [Error] → Log error → Notify team

Pattern 2: Error workflow
  Main Workflow → (fails) → Error Workflow → Slack notification

Pattern 3: Retry + fallback
  HTTP Request (retry: 3, wait: 1s, on error: continue)
    → IF (has error?) → Fallback logic
```

---

## Expressions & Data Transformation

### Syntax
All expressions: `{{ expression }}`

### Key Variables
| Variable | Description |
|----------|-------------|
| `$json` | Current item JSON |
| `$json.field` or `$json['field']` | Field access |
| `$binary` | Current item binary |
| `$input.all()` / `.first()` / `.last()` | Input items |
| `$("NodeName").item` | Linked item from node |
| `$("NodeName").all()` | All items from node |
| `$execution.id` / `.mode` | Execution metadata |
| `$workflow.id` / `.name` | Workflow metadata |
| `$env.KEY` | Environment variable |
| `$now` / `$today` | Current datetime/date |
| `$runIndex` | Current run index |
| `$pageCount` | Pagination page counter |
| `$response` | HTTP response (pagination) |
| `$itemIndex` | Item index in array |

### Inline operations
```javascript
{{ $json.price * 1.1 }}                         // Math
{{ $json.email.toLowerCase() }}                  // String methods
{{ $json.status === 'active' ? 'Yes' : 'No' }}  // Ternary
{{ $json.items.length }}                         // Array length
{{ $json.body.city }}                            // Nested access
{{ DateTime.now().toISO() }}                     // Luxon DateTime
```

---

## Credential Management

### In node JSON
```json
"credentials": {
  "slackApi": { "id": "17", "name": "slack_credentials" }
}
```

### For HTTP Request node
- **Predefined**: Select service-specific credential type
- **Generic**: Header auth (`Authorization: Bearer {{token}}`), Basic auth, Query auth

### SSL certificates
- HTTP Request supports custom SSL via `provideSslCertificates`

---

## Binary Data

### Key nodes
- **Convert to File** (`n8n-nodes-base.convertToFile`): Data → file
- **Extract From File** (`n8n-nodes-base.extractfromfile`): File → data
- **Read/Write Files** (`n8n-nodes-base.readWriteFile`): Disk I/O
- **Compression** (`n8n-nodes-base.compression`): Zip/unzip
- **Edit Image** (`n8n-nodes-base.editimage`): Image manipulation
- **FTP** (`n8n-nodes-base.ftp`): File transfer

### Access
- Expressions: `$binary`, `$binary.propertyName`
- Code: `$binary` (JS), `_binary` (Python)

---

## Workflow Settings

```json
"settings": {
  "executionTimeout": 3600,
  "saveDataSuccessExecution": "all",
  "saveDataErrorExecution": "all",
  "errorWorkflow": "workflow-id"
}
```

### Node-level settings
- **Always Output Data**: Force output even with no data (caution: can cause loops)
- **Execute Once**: Only process first input item
- **Retry On Fail**: Auto-retry with count and delay
- **On Error**: Stop / Continue / Continue (error output)

### Custom execution metadata
```javascript
$execution.customData.set("key", "value");
$execution.customData.setAll({"k1": "v1", "k2": "v2"});
$execution.customData.get("key");
$execution.customData.getAll();
```

---

## Common Node Type Identifiers

| Node | Type |
|------|------|
| Manual Trigger | `n8n-nodes-base.manualTrigger` |
| Webhook | `n8n-nodes-base.webhook` |
| Schedule Trigger | `n8n-nodes-base.scheduleTrigger` |
| HTTP Request | `n8n-nodes-base.httpRequest` |
| Code | `n8n-nodes-base.code` |
| IF | `n8n-nodes-base.if` |
| Switch | `n8n-nodes-base.switch` |
| Merge | `n8n-nodes-base.merge` |
| Loop Over Items | `n8n-nodes-base.splitInBatches` |
| Execute Sub-workflow | `n8n-nodes-base.executeWorkflow` |
| Execute Sub-workflow Trigger | `n8n-nodes-base.executeWorkflowTrigger` |
| Error Trigger | `n8n-nodes-base.errorTrigger` |
| Wait | `n8n-nodes-base.wait` |
| Set/Edit Fields | `n8n-nodes-base.set` |
| Respond to Webhook | `n8n-nodes-base.respondToWebhook` |
| Convert to File | `n8n-nodes-base.convertToFile` |
| Extract From File | `n8n-nodes-base.extractfromfile` |
| Read/Write Files | `n8n-nodes-base.readWriteFile` |
| Date & Time | `n8n-nodes-base.dateTime` |

---

# Part 2: haiflow Deep Knowledge

## Architecture

haiflow wraps Claude Code in **tmux sessions** and exposes a REST API. It enables:
- Running Claude Code headless over HTTP (no per-token API costs)
- Auto-queuing work when Claude is busy
- Multi-agent chains via event-driven pub/sub pipelines
- Real-time SSE streaming of responses

**Project references** (always read for current implementation):
- `src/index.ts` — Full server implementation
- `API.md` — Endpoint reference
- `README.md` — Setup and architecture

## Full API Surface

### Session Management

**`POST /session/start`** — Start a Claude Code tmux session
- Body: `{ cwd: string (required), session?: string (default "default") }`
- Response: `{ started: true, session, tmux, cwd }`
- Status: 200 (ok), 409 (tmux failed), 400 (missing cwd)

**`POST /session/stop`** — Kill a session
- Body: `{ session?: string }`
- Response: `{ stopped: true, session }`

**`GET /sessions`** — List all sessions
- Response: `[{ session, status: "idle"|"busy"|"offline", tmux }]`

**`GET /status`** — Session state
- Query: `?session=name`
- Response: `{ status, session, cwd, since, currentPrompt, currentTaskId, currentChain, queueLength }`

### Task Triggering

**`POST /trigger`** — Send a prompt (queues if busy)
- Body: `{ prompt: string (required), session?: string, id?: string, source?: string }`
- Response (idle): `{ id, session, sent: true, prompt }`
- Response (busy): `{ id, session, queued: true, position, message }`
- Status: 200 (sent/queued), 400 (missing prompt), 413 (>512KB), 503 (offline)
- Prompt validation: injection detection, secret file references, path traversal

### Responses

**`GET /responses/:id`** — Get completed response
- Query: `?session=name`
- Response: `{ id, completed_at, messages: string[] }`
- Status: 200 (complete), 202 (pending/queued), 404 (unknown)

**`GET /responses/:id/stream`** — SSE stream (no polling needed)
- Query: `?session=name&timeout=300` (max 600)
- Events:
  - `event: status` — `{ id, status: "pending"|"queued", position }`
  - `event: complete` — Full response object
  - `event: error` — `{ id, error }`
  - `event: timeout` — Max wait exceeded
- Headers: `Content-Type: text/event-stream`, `Cache-Control: no-cache`

**`GET /responses`** — List all responses for session
- Response: `{ session, items: [{ id, completed_at }], length }`

**`DELETE /responses`** — Clear responses
- Response: `{ session, cleared: true, count }`

### Queue

**`GET /queue`** — View queued prompts
- Response: `{ session, items: [{ id, prompt, addedAt, source?, chain? }], length }`

**`DELETE /queue`** — Clear queue
- Response: `{ session, cleared: true }`

### Pipeline (Multi-Agent)

**`GET /pipeline`** — Get pipeline config, Redis status, recent events
- Response: `{ topics, emitters, redis: boolean, recentEvents: [] }`

**`GET /pipeline/topics`** — List topic names
- Response: `["design.ready", "code.ready", ...]`

**`POST /publish`** — Publish event to topic
- Body: `{ topic: string (required), message: string (required), session?: string }`
- Response: `{ published: true, topic }`
- Dispatches to subscriber agents and outbound webhooks

### Health

**`GET /health`** — Health check (no auth)
- Response: `"ok"`

**`GET /dashboard`** — Web UI (no auth, login in UI)

---

## SSE Streaming Architecture

### How it works
1. Client sends `POST /trigger` → gets `{ id }`
2. Client opens `GET /responses/:id/stream`
3. Server opens ReadableStream, sends `event: status` every ~1.5s
4. When response file exists → sends `event: complete` and closes
5. On timeout → sends `event: timeout` and closes

### Parsing SSE response (critical for n8n integration)
SSE comes as a text block with multiple events separated by `\n\n`:
```
event: status
data: {"id":"task_123","status":"pending"}

event: status
data: {"id":"task_123","status":"pending"}

event: complete
data: {"id":"task_123","completed_at":"...","messages":["Response text"]}
```

**Parse logic** (used in n8n Code nodes):
```javascript
const text = $input.first().json.data || '';
for (const block of text.split('\n\n').reverse()) {
  if (block.includes('event: complete')) {
    const line = block.split('\n').find(l => l.startsWith('data: '));
    if (line) return [{ json: JSON.parse(line.slice(6)) }];
  }
}
return [{ json: { error: 'Task did not complete', raw: text } }];
```

---

## Hook Lifecycle (Claude Code → haiflow)

Four hooks fire during Claude Code's lifecycle:

1. **`POST /hooks/session-start`** — Claude session starts
   - Body: `{ session_id }` — associates Claude UUID with haiflow session
   - Sets state → idle

2. **`POST /hooks/prompt`** — User prompt submitted
   - Body: `{ session_id, prompt }`
   - Sets state → busy, stores current prompt

3. **`POST /hooks/stop`** — Claude finishes responding
   - Body: `{ session_id, transcript_path?, last_assistant_message }`
   - Extracts response from transcript (or uses fallback message)
   - Saves response keyed by `currentTaskId`
   - **Publishes to pipeline topics** (if session is an emitter)
   - Sets state → idle
   - **Drains queue** (sends next queued prompt)

4. **`POST /hooks/session-end`** — Claude session ends
   - Body: `{ session_id, reason }`
   - Sets state → offline (ignores "clear"/"compact" reasons)

Hooks are **localhost-only**: IP check + proxy header rejection.

---

## Pipeline System (Multi-Agent Chains)

### Configuration (`pipeline.json` in `HAIFLOW_DATA_DIR`)
```json
{
  "topics": {
    "design.ready": {
      "description": "Design agent completed analysis",
      "subscribers": [
        {
          "session": "developer",
          "promptTemplate": "Implement this design:\n\n{{message}}",
          "enabled": true
        }
      ],
      "webhooks": [
        {
          "url": "https://n8n.example.com/webhook/design-ready",
          "method": "POST",
          "headers": { "X-Secret": "..." },
          "enabled": true
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

### How pipelines work
1. Agent finishes → `/hooks/stop` fires
2. Server checks `emitters` config for session → finds topics
3. For each topic subscriber:
   - Renders `promptTemplate` with `{{message}}`, `{{topic}}`, `{{sourceSession}}`, `{{taskId}}`
   - Checks circular detection (if subscriber already in `chain[]`, skip)
   - Sends or queues to subscriber session
4. Fires outbound webhooks (async, fire-and-forget) with payload:
   ```json
   { "topic", "sourceSession", "taskId", "message", "publishedAt" }
   ```

### Circular protection
- Each task carries `chain: [session1, session2, ...]`
- Subscribers already in chain are skipped → prevents infinite loops

### Event persistence (Redis)
- Events and deliveries persisted in Redis (required dependency)
- Webhook retry with exponential backoff (max 5 attempts)
- Unprocessed events replayed on server restart
- 7-day TTL with daily pruning

---

## Prompt Security

Three validation layers on `/trigger` and `/publish`:

1. **Instruction override detection**: `ignore instructions`, `disregard rules`, `you are now`, etc.
2. **Secret file references**: `.env`, `credentials.json`, SSH keys, `.aws/credentials`, etc.
3. **Path traversal**: `../`, absolute paths outside `cwd`, `~` outside `cwd`

### Limits
- Max prompt: **512 KB**
- Large prompts (>2000 chars): Written to `/tmp/haiflow-prompt-{uuid}.txt`, cleaned after 60s
- Session name: **64 chars** (alphanumeric, `-`, `_`)
- Task ID: **128 chars** (alphanumeric, `.`, `-`, `_`)

---

## Authentication

- **API Key**: `HAIFLOW_API_KEY` env var, sent as `Authorization: Bearer {key}`
- **Constant-time comparison**: Prevents timing attacks
- **Public routes**: `/health`, `/hooks/*` (localhost-only), `/dashboard`
- **Cloudflare Zero Trust**: Tunnel + Access + service tokens for n8n cloud

---

## State Machine

```
offline → POST /session/start → idle
idle → POST /trigger → busy
busy → /hooks/stop → idle (drains queue → may become busy again)
idle/busy → /hooks/session-end → offline
```

---

# Part 3: Combining n8n + haiflow

## Core Integration Pattern (SSE, No Polling)

Every n8n + haiflow workflow follows this pattern:

```
[Trigger] → HTTP POST /trigger → HTTP GET /responses/:id/stream → Code (parse SSE) → [Action]
```

### Step 1: Trigger
Choose based on use case:
- **Webhook**: External service pushes event → workflow starts
- **Schedule**: Cron/interval → periodic automation
- **App trigger**: React to SaaS events (Slack message, GitHub PR, etc.)
- **Manual**: Testing and development

### Step 2: POST /trigger
```
HTTP Request node:
  Method: POST
  URL: {{ $env.HAIFLOW_URL }}/trigger
  Headers:
    Authorization: Bearer {{ $env.HAIFLOW_API_KEY }}
    Content-Type: application/json
  Body (JSON):
    {
      "prompt": "Your prompt here",
      "session": "worker",
      "source": "n8n"
    }
  Response format: JSON
```
Returns: `{ id, session, sent: true }` or `{ id, session, queued: true, position }`

### Step 3: GET /responses/:id/stream (SSE)
```
HTTP Request node:
  Method: GET
  URL: {{ $env.HAIFLOW_URL }}/responses/{{ $json.id }}/stream?session=worker&timeout=300
  Headers:
    Authorization: Bearer {{ $env.HAIFLOW_API_KEY }}
  Response format: text (NOT JSON — SSE is text)
  Timeout: 310000 (slightly > 300s server timeout)
```

### Step 4: Parse SSE (Code node)
```javascript
const text = $input.first().json.data || '';
for (const block of text.split('\n\n').reverse()) {
  if (block.includes('event: complete')) {
    const line = block.split('\n').find(l => l.startsWith('data: '));
    if (line) return [{ json: JSON.parse(line.slice(6)) }];
  }
}
return [{ json: { error: 'Task did not complete', raw: text } }];
```
Returns: `{ id, completed_at, messages: ["Response text 1", "Response text 2"] }`

### Step 5: Action
Use `messages[]` array — join or iterate as needed for Slack, email, GitHub, etc.

---

## Advanced Patterns

### Pattern: Multi-PR Review (Loop + haiflow)
```
Schedule (30min) → Code (gh pr list) → Loop Over Items
  → POST /trigger (review each PR) → GET /stream → Parse SSE
  → Post review comment
```
Use Loop Over Items to iterate PRs, trigger haiflow for each.

### Pattern: Pipeline Event → n8n Webhook
Configure `pipeline.json` webhooks to call n8n:
```json
{
  "topics": {
    "review.done": {
      "webhooks": [{
        "url": "https://n8n.example.com/webhook/review-done",
        "method": "POST",
        "headers": { "X-Webhook-Secret": "..." }
      }]
    }
  }
}
```
n8n Webhook node receives: `{ topic, sourceSession, taskId, message, publishedAt }`

### Pattern: n8n Triggers Pipeline Chain
```
n8n Webhook → POST /trigger (first agent) → GET /stream (wait for chain completion)
Pipeline: agent-1 → agent-2 → agent-3 (each auto-triggers next via pipeline.json)
```
Or use `POST /publish` to inject events directly into the pipeline.

### Pattern: Poll Pipeline Events
```
Schedule (5min) → GET /pipeline → Code (filter recentEvents) → IF (new events?)
  → [true] → Process events → Notify
  → [false] → (end)
```

### Pattern: Conditional Session Selection
```
Webhook → Switch (based on webhook body.type)
  → "design" → POST /trigger (session: design-agent)
  → "code" → POST /trigger (session: developer)
  → "review" → POST /trigger (session: code-reviewer)
```

### Pattern: Fan-out with Merge
```
Webhook → POST /trigger (session: analyst) → GET /stream → Parse
                                                              ↓
       → POST /trigger (session: researcher) → GET /stream → Parse
                                                              ↓
                                                          Merge (Append)
                                                              ↓
                                                         Code (combine)
                                                              ↓
                                                      Respond to Webhook
```

### Pattern: Error Handling for haiflow
```
POST /trigger (on error: continue with error output)
  ├── [Success] → GET /stream → Parse → Action
  └── [Error] → IF (status 503 = offline?)
        → [true] → Wait 30s → Retry POST /trigger
        → [false] → Notify admin
```

### Pattern: Subworkflow for haiflow Call
Create a reusable subworkflow:
```
Execute Sub-workflow Trigger (inputs: prompt, session)
  → POST /trigger
  → GET /stream
  → Parse SSE
  → Return messages[]
```
Then any parent workflow can call it with just `prompt` and `session`.

---

## Handling haiflow Response Codes in n8n

| Status | Meaning | n8n Handling |
|--------|---------|-------------|
| 200 (sent) | Prompt sent to Claude | Proceed to SSE stream |
| 200 (queued) | Claude busy, queued | Proceed to SSE stream (it waits) |
| 202 | Pending/queued (on GET response) | SSE stream handles this |
| 400 | Missing prompt | Error branch → fix input |
| 404 | Unknown task ID | Error branch → log |
| 413 | Prompt too large (>512KB) | Error branch → truncate or split |
| 503 | Session offline | Error branch → start session or notify |

---

## n8n Credentials for haiflow

Set up a **Header Auth** credential in n8n:
- Name: `haiflow`
- Header Name: `Authorization`
- Header Value: `Bearer YOUR_HAIFLOW_API_KEY`

Then use "Generic Credential Type → Header Auth" on all HTTP Request nodes calling haiflow.

For **Cloudflare Access** (when haiflow is behind a tunnel):
Add extra headers in each HTTP Request node:
```
CF-Access-Client-Id: {{ $env.CF_CLIENT_ID }}
CF-Access-Client-Secret: {{ $env.CF_CLIENT_SECRET }}
```

---

## Docker Networking: n8n ↔ haiflow

**Critical**: When n8n runs in Docker (bridge mode) and haiflow runs on the host machine, `localhost` inside the Docker container does NOT reach the host. Use `host.docker.internal` instead.

Read `PORT` from `.env` (default `3333`) and `N8N_URL` from `.env` (default `http://localhost:5678`) to determine the correct ports. Never hardcode ports.

| Direction | From | To | URL to use |
|-----------|------|-----|------------|
| n8n → haiflow | Docker container | Host machine | `http://host.docker.internal:$PORT` |
| haiflow → n8n | Host machine | Docker container | `$N8N_URL` (port-mapped) |

**When building n8n workflows that call haiflow:**
- All HTTP Request nodes must use `host.docker.internal:$PORT` (not `localhost:$PORT`)
- This applies to: `/session/start`, `/trigger`, `/responses/:id/stream`, `/session/stop`, `/publish`

**When configuring pipeline.json webhooks (haiflow → n8n):**
- Use `$N8N_URL` — haiflow runs on the host and Docker port-maps to the container

**How to check n8n's network mode:**
```bash
docker inspect n8n --format '{{.HostConfig.NetworkMode}}'
```
If `bridge` (default) → use `host.docker.internal`. If `host` → `localhost` works both ways.

**n8n Docker MUST have `WEBHOOK_URL` env var set** (e.g. `WEBHOOK_URL=http://localhost:5678/`). Without it, production webhooks silently fail to register.

**When deploying workflows via n8n API:**
- The n8n API is accessible at `$N8N_URL` (port-mapped from host)
- But workflow node URLs that n8n executes at runtime must use `host.docker.internal:$PORT` for haiflow

---

## Decision Guide: When to Use What

### n8n triggers vs haiflow pipeline triggers
| Use case | Approach |
|----------|----------|
| External event starts AI work | n8n webhook → haiflow /trigger |
| Schedule-based AI work | n8n schedule → haiflow /trigger |
| Agent A output triggers Agent B | haiflow pipeline (pipeline.json emitters/subscribers) |
| Agent output triggers non-AI actions | haiflow pipeline webhooks → n8n webhook |
| Complex conditional routing | n8n (IF/Switch nodes) → multiple haiflow /trigger calls |
| Simple linear chain | haiflow pipeline only (no n8n needed) |

### n8n subworkflows vs haiflow multi-session
| Use case | Approach |
|----------|----------|
| Reusable "call haiflow" logic | n8n subworkflow (encapsulate trigger+stream+parse) |
| Multiple AI agents in sequence | haiflow pipeline (auto-chains via pub/sub) |
| AI + non-AI steps interleaved | n8n workflow with haiflow calls at AI steps |
| Parallel AI agents | n8n fan-out (multiple /trigger calls) + Merge |

### Polling vs SSE vs pipeline webhooks
| Method | When to use |
|--------|-------------|
| SSE stream (`/responses/:id/stream`) | **Default** — n8n waits for response inline |
| Pipeline webhooks | haiflow pushes to n8n when agent finishes — event-driven |
| Polling (`GET /responses/:id`) | Only if SSE not possible (rare) |
| Pipeline polling (`GET /pipeline`) | Monitor pipeline activity from n8n |

---

## Deploying Workflows via n8n REST API

When n8n MCP tools don't support creating workflows, use the **n8n public API (v1)** directly via curl/fetch.

### Authentication
- Header: `X-N8N-API-KEY`
- **API key**: Read from `N8N_API_KEY` in the project `.env` file
- **Base URL**: `http://localhost:5678/api/v1` (read from `N8N_URL` in `.env` if set, otherwise default to `http://localhost:5678`)

### Create a workflow
```bash
curl -s -X POST "$N8N_URL/api/v1/workflows" \
  -H "X-N8N-API-KEY: $N8N_API_KEY" \
  -H "Content-Type: application/json" \
  -d "$(jq '. + {settings: {}}' workflow.json)"
```
- Body accepts the same JSON as workflow export, but **must include `settings`** (even if `{}`)
- Required fields: `name`, `nodes`, `connections`, `settings`
- Returns: full workflow object with assigned `id`
- **CRITICAL: Webhook nodes MUST have a `webhookId` field** — n8n does NOT auto-generate this when creating via API. Without it, production webhooks silently fail to register (the workflow shows as active but the webhook URL returns 404). Generate a UUID for each webhook node:
  ```json
  { "type": "n8n-nodes-base.webhook", "webhookId": "uuid-here", ... }
  ```

### Activate / Deactivate
```bash
# Activate (required for webhook-triggered workflows to listen)
curl -s -X POST "$N8N_URL/api/v1/workflows/{id}/activate" \
  -H "X-N8N-API-KEY: $N8N_API_KEY"

# Deactivate
curl -s -X POST "$N8N_URL/api/v1/workflows/{id}/deactivate" \
  -H "X-N8N-API-KEY: $N8N_API_KEY"
```

### Other endpoints
| Action | Method | Path |
|--------|--------|------|
| List workflows | GET | `/api/v1/workflows` |
| Get workflow | GET | `/api/v1/workflows/{id}` |
| Update workflow | PUT | `/api/v1/workflows/{id}` |
| Delete workflow | DELETE | `/api/v1/workflows/{id}` |
| Activate | POST | `/api/v1/workflows/{id}/activate` |
| Deactivate | POST | `/api/v1/workflows/{id}/deactivate` |

### Deployment pattern
When building workflows for the user:
1. Generate workflow JSON files in `examples/chained-calc/`
2. Use `jq '. + {settings: {}}' file.json` to add required settings field
3. POST to `/api/v1/workflows` to create
4. POST to `/api/v1/workflows/{id}/activate` for webhook-triggered workflows
5. Confirm with GET to verify

### Interactive API docs
Every n8n instance serves Swagger UI at: `http://<host>/api/v1/docs`

---

## Best Practices

1. **Always use SSE streaming** — Don't poll `/responses/:id` in a loop. SSE blocks until complete.
2. **Set response format to "text"** on the SSE HTTP Request node — SSE is not JSON.
3. **Set HTTP timeout to 310000ms** — Slightly above haiflow's 300s default.
4. **Use `source: "n8n"`** in trigger body — Shows in haiflow logs and dashboard.
5. **Create a haiflow subworkflow** — Encapsulate trigger+stream+parse for reuse.
6. **Use pipeline webhooks for event-driven flows** — Don't poll if you can receive.
7. **Handle 503 (offline)** — Add error branch to notify or retry after starting session.
8. **Use `id` parameter** — Pass custom task IDs for traceability across systems.
9. **Mind the 512KB prompt limit** — For large inputs, write to file in the project dir and reference it in the prompt.
10. **Use `session` parameter** — Route different workload types to dedicated Claude sessions.
11. **Always add `settings: {}`** when creating workflows via API — the field is required even if empty.
12. **Activate webhook workflows** — Webhook triggers only listen on production URLs when the workflow is Active.
