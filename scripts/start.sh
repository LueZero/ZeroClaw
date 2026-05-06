#!/usr/bin/env sh
# Start ZeroClaw Platform via docker compose
set -eu

cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
  echo "[warn] .env not found; using defaults"
fi

if ! docker info >/dev/null 2>&1; then
  echo "[error] Docker daemon 未啟動，請先啟動 Docker 後再執行此腳本。" >&2
  exit 1
fi

docker network inspect zeroclaw-net >/dev/null 2>&1 || docker network create zeroclaw-net

# Build base agent images first
docker compose --profile build build agent-base-opencode-build agent-base-copilot-build
docker compose build api-server web-app
docker compose up -d api-server web-app

echo
echo "✅ ZeroClaw started"
echo "   Web: http://localhost:5173"
echo "   API: http://localhost:3000/healthz"
