#!/usr/bin/env bash
# End-to-end smoke test for a haiflow install.
# Boots redis, starts `haiflow serve`, exercises the HTTP API, then tears down.
# Designed to run inside the haiflow-install-test container.
set -euo pipefail

API_KEY="${HAIFLOW_API_KEY:-test-key}"
PORT="${PORT:-3333}"
BASE="http://localhost:${PORT}"
DATA_DIR="${HAIFLOW_DATA_DIR:-/tmp/haiflow-data}"
LOG=/tmp/haiflow-serve.log

pass() { echo "  PASS: $*"; }
fail() { echo "  FAIL: $*" >&2; cleanup_dump; exit 1; }

cleanup() {
  if [ -n "${SERVER_PID:-}" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  redis-cli shutdown nosave > /dev/null 2>&1 || true
}
cleanup_dump() {
  echo "----- haiflow serve log -----" >&2
  [ -f "$LOG" ] && cat "$LOG" >&2 || echo "(no log file)" >&2
  cleanup
}
trap cleanup EXIT

if [ "${SKIP_REDIS:-0}" = "1" ]; then
  echo "==> Step 1: skipping redis (testing fallback)"
  pass "redis fallback path will be exercised"
else
  echo "==> Step 1: start redis"
  redis-server --daemonize yes --bind 127.0.0.1 --port 6379 > /dev/null
  for _ in $(seq 1 25); do
    redis-cli ping > /dev/null 2>&1 && break
    sleep 0.2
  done
  redis-cli ping > /dev/null 2>&1 || fail "redis didn't come up"
  pass "redis ready"
fi

echo "==> Step 2: start haiflow serve in background"
mkdir -p "$DATA_DIR"
HAIFLOW_API_KEY="$API_KEY" HAIFLOW_DATA_DIR="$DATA_DIR" \
  haiflow serve > "$LOG" 2>&1 &
SERVER_PID=$!

# Wait for /health to respond (max ~10s).
for _ in $(seq 1 50); do
  if curl -fsS "$BASE/health" > /dev/null 2>&1; then break; fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then fail "haiflow serve exited early"; fi
  sleep 0.2
done
curl -fsS "$BASE/health" > /dev/null 2>&1 || fail "/health never responded"
pass "haiflow serve listening on port $PORT"

echo "==> Step 3: GET /health (no auth required)"
HEALTH=$(curl -fsS "$BASE/health")
[ "$HEALTH" = "ok" ] || fail "/health returned '$HEALTH', expected 'ok'"
pass "/health returns ok"

echo "==> Step 4: GET /sessions without auth → 401"
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/sessions")
[ "$HTTP_CODE" = "401" ] || fail "/sessions without auth returned $HTTP_CODE, expected 401"
pass "/sessions rejects unauthenticated requests"

echo "==> Step 5: GET /sessions with auth → 200 + JSON array"
RESP=$(curl -fsS -H "Authorization: Bearer $API_KEY" "$BASE/sessions")
echo "$RESP" | jq -e 'type == "array"' > /dev/null \
  || fail "/sessions returned non-array body: $RESP"
pass "/sessions returns JSON array (got $(echo "$RESP" | jq 'length') sessions)"

echo "==> Step 6: GET /status?session=demo with auth → 200 + JSON object"
RESP=$(curl -fsS -H "Authorization: Bearer $API_KEY" "$BASE/status?session=demo")
echo "$RESP" | jq -e '.status' > /dev/null \
  || fail "/status returned no .status field: $RESP"
pass "/status returns object with .status field"

echo "==> Step 7: server logged server_started"
grep -q "server_started" "$LOG" || fail "server_started not found in log"
pass "server_started logged"

echo ""
echo "ALL CHECKS PASSED — install + serve + HTTP API working end-to-end."
