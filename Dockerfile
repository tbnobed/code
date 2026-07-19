# ---------- Build stage ----------
FROM node:22-slim AS build
RUN corepack enable && corepack prepare pnpm@10 --activate
WORKDIR /app

# Install dependencies with layer caching
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY lib ./lib
COPY artifacts/api-server ./artifacts/api-server
COPY artifacts/agent ./artifacts/agent
RUN pnpm install --frozen-lockfile

# Build shared libs, the API server bundle, and the frontend.
# PORT/BASE_PATH are required by the vite config at build time; the app is
# served from the root of the container's origin.
RUN npx tsc -b lib/db lib/api-zod \
 && pnpm --filter @workspace/api-server run build \
 && PORT=3000 BASE_PATH=/ pnpm --filter @workspace/agent run build

# ---------- Runtime stage ----------
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# git + curl for the agent's GitHub push/pull sync (and general tooling)
RUN apt-get update \
 && apt-get install -y --no-install-recommends git curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Bundled server (esbuild output is self-contained)
COPY --from=build /app/artifacts/api-server/dist ./dist
# Built frontend, served by the API server from the same origin
# (vite outDir is dist/public — copy its contents so index.html lands at /app/public)
COPY --from=build /app/artifacts/agent/dist/public ./public

# Non-root user; workspaces live in a mounted volume
RUN useradd -m forge \
 && mkdir -p /data/workspaces \
 && chown -R forge:forge /app /data
USER forge

# Explicit HOME so `git config --global` resolves deterministically
ENV HOME=/home/forge
ENV PORT=3000 \
    STATIC_DIR=/app/public \
    AGENT_WORKSPACES_DIR=/data/workspaces

EXPOSE 3000
VOLUME ["/data/workspaces"]

CMD ["node", "--enable-source-maps", "dist/index.mjs"]
