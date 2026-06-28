#!/usr/bin/env bash
# Provision a fresh Ubuntu server (DigitalOcean / Hetzner / any VPS) to run
# haiflow as a hardened systemd service. Run as root on the server:
#
#   bash provision-droplet.sh
#
# Idempotent: re-running skips work already done. It does NOT touch SSH password
# auth / root login (so it can't lock you out) and does NOT start the service
# until a Claude credential is present. See DEPLOYMENT-droplet.md for the full
# flow (Claude auth + Cloudflare Tunnel).
#
# Optional: export a Claude credential before running to have it baked in and the
# service started automatically:
#   CLAUDE_CODE_OAUTH_TOKEN=...   (subscription / `claude setup-token`), or
#   ANTHROPIC_API_KEY=sk-ant-...  (API billing)
set -euo pipefail

DEPLOY_USER="${DEPLOY_USER:-deploy}"
HAIFLOW_REF="${HAIFLOW_REF:-github:andersonaguiar/haiflow}"   # override with a branch: github:andersonaguiar/haiflow#branch
PROJECT_DIR="/home/$DEPLOY_USER/projects/app"
HOME_DIR="/home/$DEPLOY_USER"
ENV_FILE="$HOME_DIR/haiflow/.env"

[ "$(id -u)" -eq 0 ] || { echo "Run as root." >&2; exit 1; }
log() { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }

log "base packages"
apt-get update -y
apt-get install -y tmux jq redis-server ufw curl git ca-certificates sudo unzip

log "non-root user '$DEPLOY_USER' (keep your SSH key)"
id "$DEPLOY_USER" &>/dev/null || adduser --disabled-password --gecos "" "$DEPLOY_USER"
usermod -aG sudo "$DEPLOY_USER"
if [ -f /root/.ssh/authorized_keys ]; then
  install -d -m700 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$HOME_DIR/.ssh"
  install -m600 -o "$DEPLOY_USER" -g "$DEPLOY_USER" /root/.ssh/authorized_keys "$HOME_DIR/.ssh/authorized_keys"
fi

log "firewall: SSH only (app stays on loopback behind the tunnel)"
ufw allow OpenSSH
ufw --force enable
systemctl enable --now redis-server   # listens on 127.0.0.1:6379 by default

log "install bun + claude + haiflow as $DEPLOY_USER"
sudo -iu "$DEPLOY_USER" bash <<EOSU
set -euo pipefail
command -v bun >/dev/null || curl -fsSL https://bun.sh/install | bash
export PATH="\$HOME/.bun/bin:\$PATH"
grep -q '.bun/bin' ~/.bashrc || echo 'export PATH="\$HOME/.bun/bin:\$PATH"' >> ~/.bashrc
# Claude Code CLI (native installer; see https://code.claude.com/docs if it changes)
command -v claude >/dev/null || curl -fsSL https://claude.ai/install.sh | bash || true
export PATH="\$HOME/.local/bin:\$PATH"
grep -q '.local/bin' ~/.bashrc || echo 'export PATH="\$HOME/.local/bin:\$PATH"' >> ~/.bashrc
bun install -g '$HAIFLOW_REF'
mkdir -p "$HOME_DIR/haiflow/data" "$PROJECT_DIR"
EOSU

log "write production .env (strong key, loopback bind)"
if [ ! -f "$ENV_FILE" ]; then
  KEY=$(openssl rand -hex 32)
  CLAUDE_LINE="# CLAUDE_CODE_OAUTH_TOKEN=     # or: ANTHROPIC_API_KEY=sk-ant-..."
  [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] && CLAUDE_LINE="CLAUDE_CODE_OAUTH_TOKEN=$CLAUDE_CODE_OAUTH_TOKEN"
  [ -n "${ANTHROPIC_API_KEY:-}" ] && CLAUDE_LINE="ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY"
  cat > "$ENV_FILE" <<ENV
HAIFLOW_ENV=production
HAIFLOW_HOST=127.0.0.1
PORT=3333
HAIFLOW_API_KEY=$KEY
HAIFLOW_DATA_DIR=$HOME_DIR/haiflow/data
HAIFLOW_CWD=$PROJECT_DIR
HAIFLOW_GUARDRAILS=true
$CLAUDE_LINE
ENV
  chmod 600 "$ENV_FILE"
  chown "$DEPLOY_USER:$DEPLOY_USER" "$ENV_FILE"
  echo ">>> Generated HAIFLOW_API_KEY: $KEY"
else
  echo "$ENV_FILE already exists — leaving it untouched."
fi

log "wire Claude hooks for $DEPLOY_USER"
sudo -u "$DEPLOY_USER" -i bash -c 'set -a; source ~/haiflow/.env; set +a; haiflow setup' || \
  echo "hook setup failed (is claude installed/authed?) — run 'haiflow setup' after fixing."

log "systemd service"
BUN_BIN="$HOME_DIR/.bun/bin"
cat > /etc/systemd/system/haiflow.service <<UNIT
[Unit]
Description=haiflow
After=network.target redis-server.service
Requires=redis-server.service

[Service]
User=$DEPLOY_USER
WorkingDirectory=$HOME_DIR/haiflow
EnvironmentFile=$ENV_FILE
Environment=HOME=$HOME_DIR
Environment=PATH=$BUN_BIN:$HOME_DIR/.local/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=$BUN_BIN/haiflow serve
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable haiflow

if grep -qE '^(CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY)=.+' "$ENV_FILE"; then
  log "Claude credential present — starting haiflow"
  systemctl restart haiflow
  systemctl --no-pager --lines=10 status haiflow || true
else
  log "no Claude credential yet — NOT starting"
  echo "Add CLAUDE_CODE_OAUTH_TOKEN= (or ANTHROPIC_API_KEY=) to $ENV_FILE, then:"
  echo "  sudo -u $DEPLOY_USER -i bash -c 'set -a; source ~/haiflow/.env; set +a; haiflow setup'"
  echo "  systemctl start haiflow"
fi

log "done — next: expose via Cloudflare Tunnel (see DEPLOYMENT.md) and harden SSH (see DEPLOYMENT-droplet.md)"
