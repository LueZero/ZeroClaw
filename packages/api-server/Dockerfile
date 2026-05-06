# API Server Dockerfile (build context = monorepo root)

FROM node:20-bookworm-slim AS builder
WORKDIR /repo
RUN npm install -g pnpm@10.33.0

# Copy ALL workspace manifests first
COPY pnpm-workspace.yaml package.json tsconfig.json .npmrc ./
COPY packages/shared/package.json packages/shared/
COPY packages/api-server/package.json packages/api-server/
COPY packages/web-app/package.json packages/web-app/

# Full workspace install (ensures workspace symlinks are created)
RUN pnpm install --frozen-lockfile=false

# Copy source
COPY packages/shared packages/shared
COPY packages/api-server packages/api-server

# Build shared first, then api-server
RUN pnpm --filter @zeroclaw/shared build \
 && pnpm --filter @zeroclaw/api-server build


FROM node:20-bookworm-slim
WORKDIR /workspace
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm@10.33.0

COPY --from=builder /repo/pnpm-workspace.yaml /repo/package.json /repo/.npmrc ./
COPY --from=builder /repo/packages/shared/package.json packages/shared/
COPY --from=builder /repo/packages/shared/dist packages/shared/dist
COPY --from=builder /repo/packages/api-server/package.json packages/api-server/
COPY --from=builder /repo/packages/api-server/dist packages/api-server/dist
RUN pnpm install --prod --filter "@zeroclaw/api-server..."

ENV NODE_ENV=production
EXPOSE 3000
WORKDIR /workspace/packages/api-server
CMD ["node", "dist/main.js"]
