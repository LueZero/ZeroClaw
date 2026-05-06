#!/bin/sh
set -e

AGENT_DIR="${ZEROCLAW_AGENT_DIR:-/workspace/agent}"

# Symlink agent config files to /workspace so opencode server picks them up
# (opencode looks for opencode.json in CWD and parent dirs)
if [ -f "$AGENT_DIR/opencode.json" ]; then
  ln -sf "$AGENT_DIR/opencode.json" /workspace/opencode.json
  echo "[entrypoint] Linked opencode.json from agent dir"
fi
if [ -d "$AGENT_DIR/.opencode" ]; then
  cp -r "$AGENT_DIR/.opencode" /workspace/.opencode
  echo "[entrypoint] Copied .opencode/ from agent dir"
fi
if [ -f "$AGENT_DIR/AGENTS.md" ]; then
  ln -sf "$AGENT_DIR/AGENTS.md" /workspace/AGENTS.md
fi

# Start the opencode server in headless mode
echo "[entrypoint] Starting opencode server..."
opencode serve --port 54321 --hostname 127.0.0.1 &
OPENCODE_PID=$!

# Wait for the opencode server to be ready (max 60s ??first start needs DB migration)
echo "[entrypoint] Waiting for opencode server on port 54321..."
OPENCODE_READY=0
for i in $(seq 1 120); do
  if curl -sf http://localhost:54321/app > /dev/null 2>&1; then
    echo "[entrypoint] opencode server ready"
    OPENCODE_READY=1
    break
  fi
  sleep 0.5
done
if [ "$OPENCODE_READY" = "0" ]; then
  echo "[entrypoint] WARNING: opencode server not ready after 60s, starting runtime anyway"
fi

# Start the Node.js runtime
echo "[entrypoint] Starting runtime..."
exec node /workspace/runtime/index.js
