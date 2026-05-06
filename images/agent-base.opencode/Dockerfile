FROM node:20-bookworm-slim

WORKDIR /workspace

# 系統工具 + opencode CLI binary
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git jq \
    && rm -rf /var/lib/apt/lists/*

# Install opencode CLI (binary from GitHub releases)
RUN ARCH=$(dpkg --print-architecture) \
    && case "$ARCH" in \
         amd64) OC_ARCH="x64" ;; \
         arm64) OC_ARCH="arm64" ;; \
         *) echo "Unsupported arch: $ARCH" && exit 1 ;; \
       esac \
    && curl -fsSL "https://github.com/anomalyco/opencode/releases/latest/download/opencode-linux-${OC_ARCH}.tar.gz" \
       | tar -xz -C /usr/local/bin \
    && chmod +x /usr/local/bin/opencode

# 安裝 Opencode SDK + runtime 依賴
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# Runtime entrypoint
COPY runtime ./runtime
# Remove Windows CRLF line endings from shell scripts (safe on any platform)
RUN sed -i 's/\r//' /workspace/runtime/entrypoint.sh \
    && chmod +x /workspace/runtime/entrypoint.sh

# Agent 資料夾將以 volume mount 到 /workspace/agent (read-only)
ENV ZEROCLAW_AGENT_DIR=/workspace/agent
ENV ZEROCLAW_RUNTIME_PORT=7080
ENV OPENCODE_BASE_URL=http://localhost:54321
EXPOSE 7080

ENTRYPOINT ["/workspace/runtime/entrypoint.sh"]
