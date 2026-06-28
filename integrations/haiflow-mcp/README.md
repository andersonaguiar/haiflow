# haiflow MCP server

Exposes haiflow's Claude Code orchestration as [MCP](https://modelcontextprotocol.io) tools, so any MCP-capable agent — Claude Desktop, Cursor, Cline, or another Claude Code — can start sessions, run prompts, and chain agents through haiflow.

It's a thin stdio adapter over haiflow's HTTP API. Point it at a running haiflow server.

## Tools

| Tool | What it does |
|------|--------------|
| `haiflow_run` | Run a prompt and **wait** for the result (triggers, then streams until complete). Use `ephemeral: true` for a one-shot against an offline session (auto-start + auto-stop). |
| `haiflow_start_session` | Start a session (`session`, `cwd`). |
| `haiflow_trigger` | Fire a prompt **without** waiting — returns a task id. Supports `ephemeral`, `callbackUrl`, `priority`, `dedupKey`. |
| `haiflow_get_response` | Fetch a task result by id (200 done / 202 pending / 404 unknown). |
| `haiflow_stop_session` | Stop a session. |
| `haiflow_status` | Status of one session, or all sessions. |
| `haiflow_doctor` | Health check (catches tmux-running-but-hooks-not-linked). |
| `haiflow_map` | Map a list of items across a worker pool in parallel, then reduce. |

For the precise field/contract of each underlying endpoint, see the repo's [`API.md`](../../API.md).

## Configuration

| Env var | Default | Description |
|---------|---------|-------------|
| `HAIFLOW_URL` | `http://localhost:3333` | Base URL of the haiflow server |
| `HAIFLOW_API_KEY` | — | Bearer key (required by every endpoint except health/version) |

## Run

```bash
bun install
HAIFLOW_URL=http://localhost:3333 HAIFLOW_API_KEY=your-secret bun run index.ts
```

It speaks MCP over stdio (diagnostics go to stderr). Hosts normally spawn it for you — wire it in their config:

### Claude Desktop / Cline / Cursor (`mcpServers`)

```json
{
  "mcpServers": {
    "haiflow": {
      "command": "bun",
      "args": ["run", "/absolute/path/to/haiflow/integrations/haiflow-mcp/index.ts"],
      "env": {
        "HAIFLOW_URL": "http://localhost:3333",
        "HAIFLOW_API_KEY": "your-secret"
      }
    }
  }
}
```

### Claude Code

```bash
claude mcp add haiflow --env HAIFLOW_URL=http://localhost:3333 --env HAIFLOW_API_KEY=your-secret \
  -- bun run /absolute/path/to/haiflow/integrations/haiflow-mcp/index.ts
```

## Notes

- **`haiflow_run` blocks** until the task completes (it consumes haiflow's SSE stream internally), capped by `timeoutSec` (default 300, max 600). For long jobs, prefer `haiflow_trigger` + `callbackUrl`, or `haiflow_trigger` then `haiflow_get_response`.
- The haiflow server's hooks must be wired (`haiflow setup`); otherwise `haiflow_start_session` returns a 409 and `haiflow_doctor` will tell you why.
- Outbound text is redacted by haiflow before it leaves the box, so tool results may contain `[REDACTED:type]` markers.
