#!/bin/bash
# Check that all required dependencies are installed

OK=0
FAIL=0

check() {
  if command -v "$1" &> /dev/null; then
    VERSION=$($2 2>&1 | head -1)
    printf "  %-10s %s\n" "$1" "$VERSION"
    ((OK++))
  else
    printf "  %-10s MISSING — %s\n" "$1" "$3"
    ((FAIL++))
  fi
}

echo "Checking dependencies..."
echo ""
check "bun"    "bun --version"           "https://bun.sh"
check "tmux"   "tmux -V"                 "brew install tmux"
check "claude" "claude --version"        "https://docs.anthropic.com/en/docs/claude-code"
check "jq"     "jq --version"            "brew install jq"
check "curl"   "curl --version"          "brew install curl"
echo ""

if [ "$FAIL" -gt 0 ]; then
  echo "$FAIL missing, $OK found. Install the missing dependencies above."
  exit 1
else
  echo "All $OK dependencies found."
fi

# Optional dependencies
OPT=0
check_optional() {
  if command -v "$1" &> /dev/null; then
    VERSION=$($2 2>&1 | head -1)
    printf "  %-10s %s\n" "$1" "$VERSION"
    ((OPT++))
  else
    printf "  %-10s not installed\n" "$1"
  fi
}

echo ""
echo "Optional:"
echo ""

# n8n can be installed as CLI or run via Docker
if command -v n8n &> /dev/null; then
  VERSION=$(n8n --version 2>&1 | head -1)
  printf "  %-10s %s\n" "n8n" "$VERSION"
elif command -v docker &> /dev/null; then
  N8N_CONTAINER=$(DOCKER_API_VERSION=1.44 docker ps --filter "status=running" --format '{{.Names}} {{.Image}}' 2>/dev/null | grep n8n | awk '{print $1}' | head -1)
  if [ -n "$N8N_CONTAINER" ]; then
    printf "  %-10s running in Docker (container: %s)\n" "n8n" "$N8N_CONTAINER"
  else
    printf "  %-10s not installed\n" "n8n"
  fi
else
  printf "  %-10s not installed\n" "n8n"
fi
exit 0
