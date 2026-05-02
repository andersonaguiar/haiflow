#!/usr/bin/env bash
# Wires Claude Code hooks into ~/.claude/settings.json.
# Skipped when HAIFLOW_SKIP_SETUP=1 (CI, library consumers, headless installs).
# Soft-fails so a missing ~/.claude or unreadable settings.json doesn't break the install.

if [ "${HAIFLOW_SKIP_SETUP:-0}" = "1" ]; then
  exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
bun run "$SCRIPT_DIR/haiflow.ts" setup || {
  echo "haiflow: hook setup failed — run 'haiflow setup' manually once Claude Code is installed." >&2
}
exit 0
