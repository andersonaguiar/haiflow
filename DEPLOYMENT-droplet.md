# Deploying haiflow on a VPS / droplet

A repeatable way to run haiflow on a cloud server (DigitalOcean, Hetzner, any Ubuntu VPS), bound to loopback and fronted by an identity layer. The heavy lifting is in [`provision-droplet.sh`](provision-droplet.sh); this doc is the flow around it.

## Sizing

| Usage | Spec | Notes |
|-------|------|-------|
| 1 session, real work (builds/tests) | **4 GB / 2 vCPU** | Recommended default. Hetzner CX23 (~$8/mo) or DO 4 GB (~$24/mo). |
| Worker pool, 3–4 concurrent sessions | 8 GB / 4 vCPU | Budget ~1.5 GB per concurrent Claude session. |
| Trying it out | 2 GB / 1–2 vCPU + swap | Tight; add 2–4 GB swap (and zram) so a build doesn't OOM. |

The model runs on Anthropic's side, so droplet load is just the tools Claude runs (builds, tests, installs). Prefer a **US** datacenter for the lowest droplet→Anthropic latency on every turn.

## Prerequisites

- A fresh Ubuntu server with root SSH access.
- A Claude credential: either an **`ANTHROPIC_API_KEY`** (console billing, never expires) or a **subscription token** from `claude setup-token` on your laptop (Pro/Max; expires, refresh periodically).
- For public access: a domain on Cloudflare (for Cloudflare Access) — or use Tailscale instead.

## 1. Secure the box first

From your laptop, move off the password before anything else:
```bash
ssh-copy-id root@SERVER_IP                 # add your SSH key
ssh root@SERVER_IP 'echo ok && passwd'     # verify key login, rotate the password
```

## 2. Provision

Copy `provision-droplet.sh` to the server and run it as root. It installs Bun, tmux, jq, Redis, Claude Code and haiflow, creates a non-root `deploy` user, writes a production `.env` (loopback bind, strong key), registers a systemd service, and enables a SSH-only firewall.
```bash
# optionally bake in the Claude credential so it starts automatically:
CLAUDE_CODE_OAUTH_TOKEN=... bash provision-droplet.sh
# or just: bash provision-droplet.sh   (then add the credential in step 3)
```
It does **not** disable SSH password/root login (no lock-out risk) and does **not** start the service until a Claude credential is present. Save the printed `HAIFLOW_API_KEY`.

## 3. Add the Claude credential (if not baked in)

```bash
# subscription token: run `claude setup-token` on your LAPTOP, copy the value, then on the server:
sudo -u deploy sed -i 's|^# CLAUDE_CODE_OAUTH_TOKEN=.*|CLAUDE_CODE_OAUTH_TOKEN=PASTE_TOKEN|' /home/deploy/haiflow/.env
sudo -u deploy -i bash -c 'set -a; source ~/haiflow/.env; set +a; haiflow setup'
sudo systemctl start haiflow
journalctl -u haiflow -n 20 --no-pager      # expect: server_started host=127.0.0.1 env=production
```
haiflow runs as `deploy`, so the credential must live in its `.env` (it can't see root's `~/.claude`).

## 4. Expose securely

The origin is loopback-only, so it can only be reached through a local proxy — which is what makes an identity layer non-bypassable. Set up **Cloudflare Tunnel + Access** following [DEPLOYMENT.md](DEPLOYMENT.md); the only droplet-specific value is the tunnel ingress `service: http://localhost:3333`. No domain? Use Tailscale (mesh VPN, only your devices reach it).

## 5. Verify end to end

```bash
KEY=$(sudo -u deploy grep '^HAIFLOW_API_KEY=' /home/deploy/haiflow/.env | cut -d= -f2)
curl -s -H "Authorization: Bearer $KEY" http://127.0.0.1:3333/doctor | jq .
# loopback proof: this must FAIL (origin not public)
curl --max-time 5 http://SERVER_IP:3333/health && echo "WARNING: port is public!" || echo "good: not public"
```
After a first task, `/doctor` should report `hooksLinked: true`.

## 6. Lock SSH (after key login is confirmed)

```bash
sudo sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/; s/^#\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
sudo systemctl restart ssh
```

Then walk the hardening checklist in [SECURITY.md](SECURITY.md) (cwd locking, redaction, the take-the-wheel kill-switch, transcript allowlist) before going live.
