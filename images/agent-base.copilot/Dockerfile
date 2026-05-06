FROM node:22-bookworm-slim

WORKDIR /workspace

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git jq python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm install --omit=dev \
    # vscode-jsonrpc lacks an "exports" map, so ESM bare-specifier imports like
    # "vscode-jsonrpc/node" and "vscode-jsonrpc/node.js" fail in Node ≥16.
    # Patch its package.json to add the required subpath exports.
    && node -e "\
      const fs=require('fs');\
      const f='node_modules/vscode-jsonrpc/package.json';\
      const d=JSON.parse(fs.readFileSync(f,'utf8'));\
      d.exports={\
        '.':'./lib/node/main.js',\
        './node':'./node.js',\
        './node.js':'./node.js',\
        './browser':'./browser.js',\
        './browser.js':'./browser.js',\
        './*':'./*'\
      };\
      fs.writeFileSync(f,JSON.stringify(d,null,2));"

COPY runtime ./runtime

ENV ZEROCLAW_AGENT_DIR=/workspace/agent
ENV ZEROCLAW_RUNTIME_PORT=7080
EXPOSE 7080

ENTRYPOINT ["node", "/workspace/runtime/index.js"]
