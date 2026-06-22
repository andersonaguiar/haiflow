# Security

## Reporting a vulnerability

Please report security issues **privately** via this repository's GitHub Security Advisories (the **Security** tab → *Report a vulnerability*), not as public issues. Include reproduction steps and the affected version (`GET /version` or `haiflow version`).

## Threat model

haiflow runs **Claude Code in a tmux session with your shell, `git`, and `gh`** and exposes an HTTP API to drive it. Treat it accordingly:

> **Anyone who can get a prompt executed can run code as the operator** (inside the working directory, subject to the defense-in-depth layers below). So the authentication boundaries — the API key, the hook localhost restriction, the webhook signatures, and the bridge allowlists — are the real security perimeter. The guardrail skill and redaction are mitigations, **not** a sandbox.

Run haiflow as a dedicated, low-privilege user, scoped to a single project directory (`HAIFLOW_CWD`), and do not expose it to untrusted networks without the controls below.

## Trust boundaries

| Surface | Control |
|---|---|
| **HTTP API** (`/trigger`, `/session/*`, `/map`, `/publish`, …) | Bearer `HAIFLOW_API_KEY`, compared in constant time. This is the **root credential** — anyone holding it can run code in your sessions. |
| **Claude Code hooks** (`/hooks/*`) | Restricted to localhost; requests carrying reverse-proxy headers (`X-Forwarded-For`, `CF-Connecting-IP`) are rejected, so a tunnel/proxy can't reach them. |
| **Inbound webhooks** (`/ingest/:source`) | **Not** bearer-authenticated by design — authenticity is a per-source HMAC signature over the raw body (`github`, `stripe`, or generic `hmac-sha256`), so you never hand a third party your API key. One-use replay nonce bound to **signed material** (never an unsigned header), bounded by `HAIFLOW_INGEST_NONCE_TTL_SEC` (7 days). Fails **closed** (`503`) when Redis is unavailable unless `HAIFLOW_INGEST_ALLOW_WITHOUT_REDIS=true`. Per-source rate limit (`HAIFLOW_INGEST_RATE_PER_MIN`, default 120/min) → `429`. Every payload field is wrapped in a `BEGIN/END WEBHOOK DATA` frame as untrusted input; the operator instruction lives outside it. |
| **Take-the-wheel terminal** (`GET /terminal?mode=control`) | A **writable** PTY into the session that bypasses the structural checks and the guardrail skill, so it is gated by the API key and the `HAIFLOW_ALLOW_TAKEOVER` kill-switch (read-only view is always available). **Known limitation:** the key is passed as a URL query parameter, which can be captured by reverse-proxy/browser logs — only expose `/terminal` over localhost (or a trusted tunnel), or set `HAIFLOW_ALLOW_TAKEOVER=false`. |
| **GitHub bridge** (`haiflow github`) | Verifies the `X-Hub-Signature-256` HMAC and **fails closed** on `GITHUB_ALLOWED_REPOS`/`GITHUB_ALLOWED_SENDERS` (both required to act). **Known limitation:** the standalone bridge has no replay nonce of its own — it relies on queue-level dedup; use the `/ingest` `github` recipe if you need persistent replay protection. |

## Defense-in-depth (mitigations, not the perimeter)

- **Guardrail skill** (`HAIFLOW_GUARDRAILS=true`, default): injects `haiflow-guardrails` into each session, instructing Claude to refuse paths outside the cwd, refuse to read secrets, and refuse network exfiltration. It is **LLM-instructed, best-effort** — not an enforced sandbox.
- **Structural prompt blocks**: every prompt is rejected if it contains sandbox-escape (`--dangerously-skip-permissions`) or tmux-manipulation patterns.
- **cwd locking**: `HAIFLOW_CWD` forces every session to one directory; `HAIFLOW_ALLOW_REQUEST_CWD=false` rejects request-supplied `cwd`.
- **Secret redaction** (`HAIFLOW_REDACT=true`, default): best-effort DLP that strips well-known credential shapes from all outbound text (responses, pipeline messages, webhooks). It is **not** a firewall — it won't catch encoded/reshaped secrets.
- **Transcript path allowlist**: the Stop hook only reads transcripts under `~/.claude` or `/tmp/claude`, resolving symlinks (`realpath`) and requiring a regular file.

## Hardening checklist

1. Set a strong, unique `HAIFLOW_API_KEY` and keep it out of logs/URLs.
2. Keep hooks on localhost; never expose `/hooks/*` through a proxy.
3. Lock sessions to one project: `HAIFLOW_CWD=/path` and `HAIFLOW_ALLOW_REQUEST_CWD=false`.
4. Leave `HAIFLOW_GUARDRAILS` and `HAIFLOW_REDACT` on.
5. If you don't need the writable browser terminal, set `HAIFLOW_ALLOW_TAKEOVER=false`; if you do, keep `/terminal` localhost-only.
6. Run the signed-webhook gateway with Redis available so replay protection is active (it fails closed otherwise).
7. For chat/webhook bridges, configure the allowlists — they fail closed, so an empty allowlist serves no one.
