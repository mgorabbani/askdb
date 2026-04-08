# askdb — Monorepo Restructuring Plan

## Context

The `askdb/` directory currently contains everything in a Next.js monolith: frontend pages, API routes, MCP server, and all shared libraries. The MCP server (`src/mcp/server.ts`) duplicates ~150 lines of shared logic. We're replacing Next.js with Vite React + Express, following Paperclip's monorepo patterns.

## Current → Target

```
CURRENT:                              TARGET:
askdb/                                pnpm-workspace.yaml
├── src/                              tsconfig.base.json
│   ├── app/        (Next.js pages)   package.json
│   ├── app/api/    (Next.js API)     scripts/
│   ├── mcp/        (MCP server)        dev-runner.ts
│   ├── components/ (React UI)        server/              @askdb/server
│   └── lib/        (ALL shared)        src/
├── data/                               ├── index.ts       (entry: Express + Vite middleware/static)
└── ...                                 ├── routes/        (Express API routes from Next.js API)
                                        └── lib/           (server-only: auth session, etc.)
askdb-cli/                            ui/                  @askdb/ui
                                        src/
                                        ├── pages/         (React Router from Next.js pages)
                                        ├── components/    (React UI components)
                                        └── lib/           (auth-client, utils)
                                      packages/
                                        shared/            @askdb/shared
                                        mcp-server/        @askdb/mcp-server
                                        cli/               askdb-cli
                                      data/                (SQLite, shared via env var)
```

## Runtime Architecture (following Paperclip)

### Development
```
dev-runner.ts
  │
  ├── spawns Express server (server/src/index.ts via tsx)
  │     ├── API routes on /api/*
  │     ├── Vite dev middleware (HMR, live reload)
  │     └── catch-all → index.html (SPA routing)
  │
  └── watches: server/, ui/, packages/shared/, packages/mcp-server/
      → auto-restart on backend changes
      → Vite HMR handles frontend changes
```

Single port (e.g., 3100). No separate Vite dev server needed — Vite runs as Express middleware.

### Production
```
Express server
  ├── API routes on /api/*
  ├── express.static(ui/dist/)     ← pre-built Vite output
  └── catch-all → index.html       ← SPA routing
```

Same single port. `SERVE_UI=true` env var tells Express to serve static UI.

### MCP Server
Separate process on port 3001 (unchanged from current design). Shares SQLite via `DATABASE_PATH` env var.

## Dependency Graph

```
@askdb/shared ← @askdb/server (Express API + serves UI)
              ← @askdb/mcp-server (standalone Express MCP)
              ← @askdb/ui (only for shared types, if needed)

@askdb/ui has NO runtime dependency on shared — it talks to server via HTTP/fetch
```

## What Goes Where

### @askdb/shared (`packages/shared/`)
Shared between server and mcp-server. No React, no Express — pure logic.

| Module | Source |
|--------|--------|
| `db/schema.ts` | from `askdb/src/lib/db/schema.ts` |
| `db/index.ts` | from `askdb/src/lib/db/index.ts` |
| `crypto/encryption.ts` | from `askdb/src/lib/crypto/encryption.ts` |
| `auth/api-keys.ts` | from `askdb/src/lib/auth/api-keys.ts` |
| `adapters/types.ts` | from `askdb/src/lib/adapters/types.ts` |
| `adapters/mongodb/*` | from `askdb/src/lib/adapters/mongodb/` |
| `docker/manager.ts` | from `askdb/src/lib/docker/manager.ts` |
| `pii/patterns.ts` | from `askdb/src/lib/pii/patterns.ts` |
| `memory/extractor.ts` | from `askdb/src/lib/memory/extractor.ts` |
| `schema-summary/generator.ts` | from `askdb/src/lib/schema-summary/generator.ts` |

### @askdb/server (`server/`)
Express backend. Replaces Next.js API routes.

| Module | Source |
|--------|--------|
| `routes/connections.ts` | from `askdb/src/app/api/connections/route.ts` + sub-routes |
| `routes/keys.ts` | from `askdb/src/app/api/keys/` routes |
| `routes/audit.ts` | from `askdb/src/app/api/audit/route.ts` |
| `routes/auth.ts` | from `askdb/src/app/api/auth/` route |
| `lib/auth.ts` | from `askdb/src/lib/auth.ts` (better-auth, adapted for Express) |
| `lib/session.ts` | from `askdb/src/lib/auth/session.ts` (adapted for Express req/res) |
| `index.ts` | new — Express app with Vite middleware (dev) / static serving (prod) |

### @askdb/ui (`ui/`)
Vite React SPA. Replaces Next.js pages.

| Module | Source |
|--------|--------|
| `pages/login.tsx` | from `askdb/src/app/(auth)/login/page.tsx` |
| `pages/setup.tsx` | from `askdb/src/app/(auth)/setup/page.tsx` |
| `pages/dashboard/index.tsx` | from `askdb/src/app/(dashboard)/dashboard/page.tsx` |
| `pages/dashboard/connect.tsx` | from `askdb/src/app/(dashboard)/dashboard/connect/page.tsx` |
| `pages/dashboard/keys.tsx` | from `askdb/src/app/(dashboard)/dashboard/keys/page.tsx` |
| `pages/dashboard/audit.tsx` | from `askdb/src/app/(dashboard)/dashboard/audit/page.tsx` |
| `pages/dashboard/schema/[id].tsx` | from `askdb/src/app/(dashboard)/dashboard/connections/[id]/schema/page.tsx` |
| `pages/dashboard/setup/[keyId].tsx` | from `askdb/src/app/(dashboard)/dashboard/setup/[keyId]/page.tsx` |
| `components/*` | from `askdb/src/components/` |
| `lib/auth-client.ts` | from `askdb/src/lib/auth-client.ts` |
| `lib/utils.ts` | from `askdb/src/lib/utils.ts` |

Key changes:
- `next/navigation` → `react-router-dom`
- `next/link` → `<Link>` from react-router
- Server components → client components with `fetch()` calls
- `useRouter().push()` → `useNavigate()`

### @askdb/mcp-server (`packages/mcp-server/`)
Standalone Express MCP process (same as before, refactored to import from shared).

### askdb-cli (`packages/cli/`)
HTTP-based CLI (unchanged internals, just moved).

## Package Scripts (following Paperclip)

### Root `package.json`
```
"dev"         → tsx scripts/dev-runner.ts watch
"dev:once"    → tsx scripts/dev-runner.ts dev
"dev:server"  → pnpm --filter @askdb/server dev
"dev:ui"      → pnpm --filter @askdb/ui dev
"dev:mcp"     → pnpm --filter @askdb/mcp-server dev
"build"       → pnpm -r build
"typecheck"   → pnpm -r typecheck
"db:generate" → pnpm --filter @askdb/shared db:generate
"db:migrate"  → pnpm --filter @askdb/shared db:migrate
```

### `server/package.json`
```
"dev"   → tsx src/index.ts
"build" → tsc
"start" → node dist/index.js
```

### `ui/package.json`
```
"dev"   → vite
"build" → tsc -b && vite build
```

## Dev Runner Behavior (from Paperclip)

`scripts/dev-runner.ts`:
- Spawns Express server child process via `tsx`
- Watches: `server/`, `packages/shared/`, `packages/mcp-server/`, `scripts/`, `.env`
- Ignores: `node_modules/`, `dist/`, `.git/`, `ui/` (Vite HMR handles UI)
- Poll interval: ~1.5s for changes, ~2.5s for restart eligibility
- Graceful shutdown: SIGTERM → 10s timeout → SIGKILL
- Runs DB migrations before first start

## Auth Adaptation

Current: `better-auth` configured for Next.js (`toNextJsHandler`, `next/headers`).
New: `better-auth` supports Express natively via `toExpressHandler`. Session via `auth.api.getSession({ headers: fromNodeHeaders(req.headers) })`.

## Deployment Modes (following Paperclip)

Three ways to run askdb, matching Paperclip's pattern:

### 1. Local (`npx askdb onboard`)
Zero-setup local experience. The CLI `onboard` command:
1. Checks prerequisites (Node.js 20+, Docker running)
2. Clones/inits the project if not in a project dir
3. Generates `.env` with random secrets (BETTER_AUTH_SECRET, ENCRYPTION_KEY)
4. Runs `pnpm install`
5. Applies DB migrations
6. Starts the server (Express + Vite dev middleware on port 3100)
7. Opens browser to `http://localhost:3100`

SQLite is zero-config. Docker is needed for MongoDB sandbox containers (user must have Docker running).

The CLI is published to npm as `askdb` so `npx askdb onboard --yes` works globally.

### 2. VPS (Docker / `curl | bash`)
Self-hosted on any VPS:
```bash
curl -sSL https://get.askdb.dev | bash
```
Uses Docker Compose. Multi-stage Dockerfile builds all packages. Express serves pre-built UI static assets (`SERVE_UI=true`). MCP server runs as separate process in same container.

### 3. Cloud (future roadmap)
Managed cloud version at askdb.dev. Not in MVP scope.

### Server Entry Point Mode Selection (from Paperclip)

`server/src/index.ts` selects UI mode based on environment:

```
const uiMode = env.UI_DEV_MIDDLEWARE ? "vite-dev"
             : env.SERVE_UI          ? "static"
             :                         "none";
```

| Mode | When | Behavior |
|------|------|----------|
| `vite-dev` | `pnpm dev` / local onboard | Vite middleware in Express, HMR |
| `static` | Docker / VPS production | `express.static(ui/dist/)` + SPA catch-all |
| `none` | API-only (testing, headless) | No UI served |

## Task Sequence

```
R1 (Root workspace + tsconfig.base + pnpm-workspace)
  │
  ├── R2 (Create @askdb/shared — move shared libs)
  │     │
  │     ├── R3 (Create server/ — Express API from Next.js routes)
  │     │
  │     ├── R4 (Create ui/ — Vite React from Next.js pages)
  │     │
  │     └── R5 (Extract MCP server → packages/mcp-server/)
  │
  ├── R6 (Move askdb-cli/ → packages/cli/)  ← parallel with R2
  │
  R7 (Dev runner script)  ← after R3, R4
  │
  R8 (Docker + deployment)  ← after R3, R4, R5
  │
  R9 (CLI onboard command)  ← after R7
  │
  R10 (Verify full e2e + delete askdb/)
```

## Risks

1. **better-auth Express adapter** — well-supported, documented at better-auth.com
2. **Server components → client fetch** — Next.js server components that query DB directly (e.g., dashboard page) become client components that call API endpoints. May need new API routes for data that was fetched server-side.
3. **Vite middleware mode** — well-documented pattern, used by Paperclip in production
4. **React Router** — replaces Next.js file-based routing. Need to define routes manually.
5. **npx global install** — CLI must be published to npm for `npx askdb onboard` to work. During dev, use `pnpm --filter askdb-cli exec tsx src/index.ts onboard`.
