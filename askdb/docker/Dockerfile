# ── Stage 1: Install dependencies ────────────────────────────────────
FROM node:22-slim AS deps

RUN corepack enable && corepack prepare pnpm@8.7.6 --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --no-frozen-lockfile

# ── Stage 2: Build Next.js ───────────────────────────────────────────
FROM node:22-slim AS build

RUN corepack enable && corepack prepare pnpm@8.7.6 --activate

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Create data dir so better-sqlite3 doesn't fail during build-time evaluation
RUN mkdir -p /app/data

RUN pnpm build

# ── Stage 3: Production runtime ──────────────────────────────────────
FROM node:22-slim AS runtime

# Install MongoDB database tools (mongodump/mongorestore) via direct download
# arm64: no debian12 build exists, use ubuntu2204 (binary-compatible)
# x86_64: debian12 build available
RUN apt-get update && apt-get install -y --no-install-recommends \
      curl ca-certificates libgssapi-krb5-2 libssl3 \
    && ARCH=$(dpkg --print-architecture) \
    && if [ "$ARCH" = "arm64" ]; then \
         MONGO_URL="https://fastdl.mongodb.org/tools/db/mongodb-database-tools-ubuntu2204-arm64-100.12.0.tgz"; \
       else \
         MONGO_URL="https://fastdl.mongodb.org/tools/db/mongodb-database-tools-debian12-x86_64-100.12.0.tgz"; \
       fi \
    && curl -fsSL "$MONGO_URL" -o /tmp/mongo-tools.tgz \
    && tar -xzf /tmp/mongo-tools.tgz -C /tmp \
    && mv /tmp/mongodb-database-tools-*/bin/* /usr/local/bin/ \
    && rm -rf /tmp/mongo-tools.tgz /tmp/mongodb-database-tools-* \
    && apt-get purge -y --auto-remove curl \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@8.7.6 --activate

WORKDIR /app

# Copy package.json
COPY package.json ./

# Copy node_modules (includes better-sqlite3 compiled for this arch, tsx, etc.)
COPY --from=deps /app/node_modules ./node_modules

# Copy built Next.js app
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public

# Copy MCP server source (runs via tsx at runtime)
COPY src/mcp/ ./src/mcp/
COPY src/lib/ ./src/lib/

# Copy tsconfig (tsx needs it for path resolution)
COPY tsconfig.json ./

# Copy startup script
COPY docker/start.sh ./start.sh
RUN chmod +x ./start.sh

# Create data directory for SQLite
RUN mkdir -p /app/data

EXPOSE 3000 3001

ENV NODE_ENV=production

CMD ["./start.sh"]
