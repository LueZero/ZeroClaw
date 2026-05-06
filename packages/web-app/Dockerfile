# Web App Dockerfile (build context = monorepo root)

FROM node:20-bookworm-slim AS builder
WORKDIR /repo
RUN npm install -g pnpm@10.33.0

# Copy ALL workspace manifests
COPY pnpm-workspace.yaml package.json tsconfig.json .npmrc ./
COPY packages/shared/package.json packages/shared/
COPY packages/api-server/package.json packages/api-server/
COPY packages/web-app/package.json packages/web-app/

# Full workspace install
RUN pnpm install --frozen-lockfile=false

COPY packages/shared packages/shared
COPY packages/web-app packages/web-app

# Build shared first; this populates dist used by tsc/vite for web-app
RUN pnpm --filter @zeroclaw/shared build \
 && pnpm --filter @zeroclaw/web-app build


FROM nginx:1.27-alpine
COPY --from=builder /repo/packages/web-app/dist /usr/share/nginx/html
COPY packages/web-app/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
