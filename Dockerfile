# syntax=docker/dockerfile:1.7
# ─────────────────────────────────────────────────────────────────────────────
# askdb — multi-stage build
#
# Stages:
#   base    → node + pnpm + system deps shared by all stages
#   deps    → install workspace dependencies (cached on lockfile)
#   build   → compile workspace packages (vite build for ui, tsc for the rest)
#   runtime → minimal final image: copies built artifacts + runs server + mcp
# ─────────────────────────────────────────────────────────────────────────────

FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/root/.local/share/pnpm \
    PATH=/root/.local/share/pnpm:$PATH \
    CI=true
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl python3 build-essential \
 && rm -rf /var/lib/apt/lists/* \
 && corepack enable \
 && corepack prepare pnpm@10.33.0 --activate
WORKDIR /app


FROM base AS deps
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY server/package.json ./server/
COPY ui/package.json ./ui/
COPY cli/package.json ./cli/
COPY packages/shared/package.json ./packages/shared/
COPY packages/mcp-server/package.json ./packages/mcp-server/
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile


FROM base AS build
COPY --from=deps /app /app
COPY . .
RUN pnpm -r build


FROM node:22-bookworm-slim AS runtime
ARG MONGO_TOOLS_VERSION=100.10.0
ENV NODE_ENV=production \
    PNPM_HOME=/root/.local/share/pnpm \
    PATH=/root/.local/share/pnpm:$PATH \
    PORT=3100 \
    MCP_PORT=3001 \
    SERVE_UI=1 \
    DATABASE_PATH=/app/data/askdb.db
# Install runtime deps + mongodb-database-tools (mongodump/mongorestore) used by the sync pipeline.
# The ubuntu2204 .deb works on bookworm because the bundled binaries are mostly self-contained Go.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates tini curl; \
    ARCH=$(dpkg --print-architecture); \
    case "$ARCH" in \
      amd64) MTARCH=x86_64 ;; \
      arm64) MTARCH=arm64 ;; \
      *) echo "unsupported arch: $ARCH" >&2; exit 1 ;; \
    esac; \
    curl -fsSL "https://fastdl.mongodb.org/tools/db/mongodb-database-tools-ubuntu2204-${MTARCH}-${MONGO_TOOLS_VERSION}.deb" -o /tmp/mdb-tools.deb; \
    apt-get install -y --no-install-recommends /tmp/mdb-tools.deb; \
    rm /tmp/mdb-tools.deb; \
    rm -rf /var/lib/apt/lists/*; \
    corepack enable; \
    corepack prepare pnpm@10.33.0 --activate
WORKDIR /app

# Copy built artifacts and node_modules from the build stage.
COPY --from=build /app /app

# SQLite + future export volume.
VOLUME ["/app/data"]

EXPOSE 3100 3001

# tini = PID 1 reaper; entrypoint script spawns server + mcp.
COPY docker/entrypoint.sh /usr/local/bin/askdb-entrypoint
RUN chmod +x /usr/local/bin/askdb-entrypoint
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/askdb-entrypoint"]
