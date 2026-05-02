# Smoke-test install.sh against a clean Ubuntu image.
#
# Build:  docker build -f tests/install/Dockerfile -t haiflow-install-test .
# Run:    docker run --rm haiflow-install-test
#
# Strategy:
#   1. Set up a clean Ubuntu with the deps install.sh expects (curl, tmux, jq, bash, git, redis).
#   2. Stub `claude` so install.sh's hook-setup step doesn't bail.
#   3. Copy this checkout in and run install.sh with HAIFLOW_INSTALL_METHOD=local
#      so we exercise the real installer end-to-end (not GitHub-tarball-from-net).
#   4. Verify `haiflow --help` runs and `haiflow serve` boots Bun.serve
#      (after starting redis-server, which the server connects to at startup).

FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl unzip tmux jq git bash redis-server \
    && rm -rf /var/lib/apt/lists/*

# Stub `claude` so install.sh's optional check succeeds.
RUN printf '#!/bin/sh\necho "claude (stub) 0.0.0"\n' > /usr/local/bin/claude \
    && chmod +x /usr/local/bin/claude

WORKDIR /haiflow
COPY . .

ENV PATH="/root/.bun/bin:${PATH}"

# Run the real install.sh — pointed at the local checkout instead of GitHub.
RUN HAIFLOW_INSTALL_METHOD=local \
    HAIFLOW_INSTALL_PATH=/haiflow \
    HAIFLOW_SKIP_SETUP=1 \
    bash /haiflow/install.sh

# Verify CLI is on PATH and prints usage.
RUN haiflow 2>&1 | grep -q "haiflow - HTTP orchestrator" \
    && echo "PASS: haiflow CLI runs and prints usage"

# Boot redis in the background, then verify `haiflow serve` starts Bun.serve.
# The server's EventBus connects to Redis at startup with no fallback, so a
# running redis is required for the server to log "server_started".
RUN bash -c '\
      set -o pipefail; \
      redis-server --daemonize yes --bind 127.0.0.1 --port 6379 > /dev/null; \
      for i in $(seq 1 20); do redis-cli ping > /dev/null 2>&1 && break; sleep 0.2; done; \
      export HAIFLOW_API_KEY=test-key HAIFLOW_DATA_DIR=/tmp/haiflow-data; \
      timeout 8s haiflow serve > /tmp/serve.log 2>&1 || true; \
      if grep -q "server_started" /tmp/serve.log; then \
        echo "PASS: haiflow serve booted Bun.serve"; \
      else \
        echo "FAIL: haiflow serve did not log server_started — full log below:"; \
        cat /tmp/serve.log; \
        exit 1; \
      fi \
    '

CMD ["bash", "-lc", "haiflow && echo OK"]
