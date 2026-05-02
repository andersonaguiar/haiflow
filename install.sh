#!/usr/bin/env bash
# haiflow installer — curl -fsSL https://raw.githubusercontent.com/andersonaguiar/haiflow/main/install.sh | bash
set -euo pipefail

GITHUB_REPO="${HAIFLOW_GITHUB_REPO:-andersonaguiar/haiflow}"
INSTALL_METHOD="${HAIFLOW_INSTALL_METHOD:-github}"  # github | npm
SKIP_SETUP="${HAIFLOW_SKIP_SETUP:-0}"

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[0;33m'
  BLUE=$'\033[0;34m'; BOLD=$'\033[1m'; RESET=$'\033[0m'
else
  RED=""; GREEN=""; YELLOW=""; BLUE=""; BOLD=""; RESET=""
fi

info()    { echo "${BLUE}==>${RESET} $*"; }
success() { echo "${GREEN}✓${RESET}  $*"; }
warn()    { echo "${YELLOW}!${RESET}  $*"; }
error()   { echo "${RED}✗${RESET}  $*" >&2; }

OS="$(uname -s)"
case "$OS" in
  Darwin|Linux) ;;
  *) error "haiflow only supports macOS and Linux. Detected: $OS"; exit 1 ;;
esac

if ! command -v bun >/dev/null 2>&1; then
  info "Bun not found — installing from https://bun.sh"
  curl -fsSL https://bun.sh/install | bash
  [ -f "$HOME/.bun/bin/bun" ] && export PATH="$HOME/.bun/bin:$PATH"
  if ! command -v bun >/dev/null 2>&1; then
    error "Bun install failed. Install manually: https://bun.sh"
    exit 1
  fi
fi
success "bun $(bun --version)"

if [ "$OS" = "Darwin" ]; then
  TMUX_HINT="brew install tmux"
  JQ_HINT="brew install jq"
else
  TMUX_HINT="sudo apt-get install -y tmux  # or your distro's package manager"
  JQ_HINT="sudo apt-get install -y jq  # or your distro's package manager"
fi

check_required() {
  local cmd=$1 hint=$2
  if ! command -v "$cmd" >/dev/null 2>&1; then
    error "$cmd is required but not installed."
    echo "    Install with: $hint"
    exit 1
  fi
  success "$cmd installed"
}
check_required tmux "$TMUX_HINT"
check_required jq "$JQ_HINT"

if ! command -v claude >/dev/null 2>&1; then
  warn "Claude Code CLI not found — install from https://docs.anthropic.com/en/docs/claude-code"
  warn "haiflow needs it at runtime; install before running 'haiflow start'."
else
  success "claude installed"
fi

if ! command -v redis-cli >/dev/null 2>&1; then
  warn "Redis not found — pipeline events fall back to in-process delivery."
  warn "Run a local Redis with: docker run -d -p 6379:6379 redis"
fi

info "Installing haiflow via $INSTALL_METHOD..."
case "$INSTALL_METHOD" in
  github) HAIFLOW_SKIP_SETUP="$SKIP_SETUP" bun install -g "github:${GITHUB_REPO}" ;;
  npm)    HAIFLOW_SKIP_SETUP="$SKIP_SETUP" bun install -g haiflow ;;
  *) error "Unknown install method: $INSTALL_METHOD (use 'github' or 'npm')"; exit 1 ;;
esac

if ! command -v haiflow >/dev/null 2>&1; then
  GLOBAL_BIN="$(bun pm bin -g 2>/dev/null || true)"
  warn "haiflow installed but not on PATH."
  if [ -n "$GLOBAL_BIN" ]; then
    warn "Add this to your shell profile: export PATH=\"$GLOBAL_BIN:\$PATH\""
  fi
  exit 0
fi

success "haiflow installed at $(command -v haiflow)"

echo ""
echo "${BOLD}Next steps${RESET}"
echo "  1. Set the API key:    export HAIFLOW_API_KEY=your-secret"
echo "  2. Start the server:   haiflow serve"
echo "  3. In another shell:   haiflow start worker --cwd /path/to/project"
echo ""
echo "Docs: https://github.com/${GITHUB_REPO}#readme"
