# n8n-nodes-haiflow

An n8n community node for [haiflow](https://github.com/coderz/haiflow), an HTTP orchestrator for Claude Code. It lets you trigger prompts, stream responses, manage sessions, publish pipeline events, and receive outbound pipeline webhooks, all from inside an n8n workflow.

This package contains two nodes:

- **Haiflow**: an action node with operations for triggering prompts and managing sessions.
- **Haiflow Pipeline Trigger**: a trigger node that starts a workflow when haiflow posts a pipeline event to its webhook URL.

## Installation

### Community Nodes (recommended)

In your n8n instance, go to **Settings > Community Nodes**, select **Install**, and enter:

```
n8n-nodes-haiflow
```

Agree to the risks of using community nodes and select **Install**. n8n downloads and installs the package, and the Haiflow nodes become available in the nodes panel.

### Manual install

```bash
npm i n8n-nodes-haiflow
```

Then place the package where your n8n instance loads custom nodes (for example `~/.n8n/custom`), or follow the n8n docs for installing private nodes.

## Credentials

Create a **Haiflow API** credential with:

- **Base URL**: the haiflow server URL, without a trailing slash (default `http://localhost:3333`).
- **API Key**: your `HAIFLOW_API_KEY`. It is sent as `Authorization: Bearer <key>` on every request.

The credential test calls `GET /sessions` to confirm the URL and key are valid.

## Haiflow node operations

### Trigger

Sends a prompt to a session (`POST /trigger`). Fields:

- **Prompt** (required): the prompt text.
- **Session** (default `default`): the target session.
- **Task ID** (optional): a client supplied id. Leave empty to let haiflow generate one.
- **Source** (default `n8n`): a label for where the prompt came from.

Returns haiflow's trigger result. When the session is idle you get `{ id, session, sent: true, prompt }`. When it is busy you get `{ id, session, queued: true, position }`. If the session is offline, haiflow replies `503` and the node raises an error (or, with **Continue On Fail**, emits `{ error }`).

### Trigger and Wait

This is the headline operation. It sends the prompt (`POST /trigger`) and then consumes the Server-Sent Events stream (`GET /responses/:id/stream`) until the task completes. Fields are the same as **Trigger**, plus:

- **Timeout (Seconds)** (default 300, max 600): how long to wait for the stream. haiflow caps this server side at 600 seconds.

The stream is parsed by splitting on blank lines into `event:` / `data:` blocks:

- `status` events mean the task is still pending or queued, so the node keeps reading.
- `complete` returns the full response, and the node emits `{ id, session, status: "complete", prompt, response, messages }` where `response` is the messages joined into a single string and `messages` is the raw array.
- `error` raises a node error with the message from haiflow (or emits `{ error }` with **Continue On Fail**).
- `timeout` returns `{ id, session, status: "timeout", prompt }` so downstream nodes can branch on it.

If the prompt was queued behind another task, the output also carries `{ queued: true, position }` as an interim note.

### Get Response

Fetches a response by id (`GET /responses/:id`). Fields:

- **Task ID** (required).
- **Session** (default `default`).

Returns `200` with the full response (`{ id, completed_at, prompt, messages }`), or `202` with `{ id, session, status: "pending" | "queued" }` if it is not ready yet.

### Start Session

Starts a session (`POST /session/start`). Fields:

- **Session** (required, default `default`).
- **Working Directory** (required): the absolute path the session runs in.

### Stop Session

Stops a session (`POST /session/stop`). Field: **Session** (required).

### Publish Event

Injects an external pipeline event (`POST /publish`). Fields:

- **Topic** (required).
- **Message** (required).
- **Session** (optional): the source session for the event.

### List Sessions

Lists every session and its status (`GET /sessions`). Each item is `{ session, status, tmux }`.

## Haiflow Pipeline Trigger node

This trigger node exposes a webhook that haiflow can call when a pipeline topic publishes. haiflow POSTs a payload shaped like:

```json
{
  "topic": "deploy.finished",
  "sourceSession": "default",
  "taskId": "abc123",
  "message": "Deploy completed",
  "publishedAt": "2026-06-09T10:00:00.000Z"
}
```

### Setup

1. Add the **Haiflow Pipeline Trigger** node to a workflow and activate the workflow.
2. Copy the node's **Production** webhook URL.
3. In your haiflow `pipeline.json`, add that URL to the target topic's `webhooks` array, for example:

```json
{
  "topics": {
    "deploy.finished": {
      "webhooks": ["https://your-n8n-host/webhook/haiflow-pipeline"]
    }
  }
}
```

4. (Optional) Set a **Shared Secret** on the node. When set, incoming requests must send a matching `X-Pipeline-Secret` header, otherwise they are rejected. Configure haiflow to send that header for the topic.

The node emits the received payload as workflow data so you can route, filter, or forward it.

## Example: issue webhook to Trigger and Wait to Slack

A common pattern is to have an external service (such as a GitHub issue webhook) ask Claude Code to do work, then post the result to Slack:

1. **Webhook** (n8n core) receives the issue payload (for example a new GitHub issue).
2. **Haiflow** node, operation **Trigger and Wait**: set **Prompt** to something like `Investigate issue: {{ $json.body.issue.title }}, {{ $json.body.issue.body }}`, **Session** to your project session, and **Timeout** to 600. The node waits for Claude Code to finish and returns the response text.
3. **Slack** node: post `{{ $json.response }}` to your channel.

The result is an end-to-end flow: an issue arrives, Claude Code investigates through haiflow, and the answer lands in Slack, with no manual steps in between.

## Compatibility

- Built against the n8n community node API version 1 (`n8n-workflow` types).
- Requires an n8n instance that allows community nodes.

## License

MIT (c) Anderson Aguiar
