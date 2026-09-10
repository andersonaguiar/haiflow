#!/bin/bash
# Forwards a Claude Code hook event to the haiflow server.
# Only fires when session was started by haiflow (HAIFLOW=1 is set via tmux -e).
# Usage: forward.sh <endpoint>  (e.g. forward.sh /hooks/stop)
[ "$HAIFLOW" != "1" ] && exit 0
# Which session this is. Claude's own session_id means nothing to haiflow on
# the first event, so without this the server has to GUESS which session a
# SessionStart belongs to, and it guesses wrong whenever more than one is
# unlinked. Sent as a header so the hook payload is passed through untouched.
curl -s -X POST "http://localhost:${HAIFLOW_PORT:-3333}$1" \
  -H "Content-Type: application/json" \
  ${HAIFLOW_SESSION:+-H "X-Haiflow-Session: $HAIFLOW_SESSION"} \
  --data-binary @- > /dev/null 2>&1 || true
