# askdb — Monorepo Restructuring Tasks

## R1: Root workspace setup
- [ ] Create `pnpm-workspace.yaml` listing `packages/*`, `server`, `ui`
- [ ] Create root `package.json` with workspace scripts (dev, build, typecheck, db:*)
- [ ] Create `tsconfig.base.json` (ES2023, NodeNext, strict, declaration, sourceMap)
- [ ] Create root `tsconfig.json` with project references to all packages
- [ ] Move `data/` to root level, reference via `DATABASE_PATH` env var
- [ ] **Verify:** `pnpm install` at root succeeds

---

## R2: Create `@askdb/shared` package
- [ ] Create `packages/shared/package.json` (name: `@askdb/shared`, exports map)
- [ ] Create `packages/shared/tsconfig.json` extending base
- [ ] Move from `askdb/src/lib/` to `packages/shared/src/`:
  - `db/schema.ts`, `db/index.ts`
  - `crypto/encryption.ts`
  - `auth/api-keys.ts`
  - `adapters/types.ts`, `adapters/mongodb/*`
  - `docker/manager.ts`
  - `pii/patterns.ts`
  - `memory/extractor.ts`
  - `schema-summary/generator.ts`
- [ ] Create barrel export `packages/shared/src/index.ts`
- [ ] Update internal imports (replace `@/lib/` with relative paths)
- [ ] Move `drizzle.config.ts` here + drizzle scripts in package.json
- [ ] **Verify:** `tsc --noEmit` passes

**Depends on:** R1

---

## R3: Create `@askdb/server` — Express backend
- [ ] Create `server/package.json` (deps: `@askdb/shared`, express, better-auth, etc.)
- [ ] Create `server/tsconfig.json` extending base
- [ ] Create `server/src/index.ts` — Express app entry (following Paperclip pattern):
  - Dev: Vite middleware mode (HMR)
  - Prod: `express.static(ui/dist/)` + catch-all → index.html
- [ ] Convert Next.js API routes to Express routes:
  - `routes/auth.ts` — better-auth via `toExpressHandler`
  - `routes/connections.ts` — CRUD + sync + status + schema + memories
  - `routes/keys.ts` — API key create/list/revoke
  - `routes/audit.ts` — audit log listing
- [ ] Adapt `lib/auth.ts` — better-auth for Express (not Next.js)
- [ ] Adapt `lib/session.ts` — Express req/res session (no `next/headers`)
- [ ] **Verify:** `pnpm --filter @askdb/server dev` starts, API routes respond

**Depends on:** R2

---

## R4: Create `@askdb/ui` — Vite React frontend
- [ ] Create `ui/package.json` (deps: react, react-dom, react-router-dom, shadcn, etc.)
- [ ] Create `ui/tsconfig.json` (bundler resolution, path alias `@/*`)
- [ ] Create `ui/vite.config.ts` with `/api` proxy to server (for standalone dev)
- [ ] Set up React Router with route definitions matching current pages
- [ ] Convert Next.js pages to React Router pages:
  - Replace `next/navigation` → `react-router-dom` (useNavigate, useParams)
  - Replace `next/link` → `<Link>` from react-router
  - Server components (dashboard page) → client components with fetch()
- [ ] Move `components/` from askdb
- [ ] Move `lib/auth-client.ts`, `lib/utils.ts`, `globals.css`
- [ ] **Verify:** `pnpm --filter @askdb/ui dev` renders pages

**Depends on:** R2, R3 (needs API to fetch data)

---

## R5: Extract MCP server → `packages/mcp-server/`
- [ ] Create `packages/mcp-server/package.json` (deps: `@askdb/shared`, express, MCP SDK)
- [ ] Create `packages/mcp-server/tsconfig.json`
- [ ] Move `server.ts`, refactor: import from `@askdb/shared` instead of duplicating
  - Remove duplicated decrypt, hashKey, generateSchemaMarkdown, DB setup
- [ ] **Verify:** `pnpm --filter @askdb/mcp-server dev` starts on port 3001

**Depends on:** R2

---

## R6: Move `askdb-cli/` → `packages/cli/`
- [ ] Move directory, update package.json if needed
- [ ] **Verify:** `pnpm --filter askdb-cli dev` works

**Parallel with:** R2

---

## R7: Dev runner script
- [ ] Create `scripts/dev-runner.ts` following Paperclip pattern:
  - Spawn Express server child via tsx
  - Watch: server/, packages/shared/, packages/mcp-server/, .env
  - Ignore: node_modules/, dist/, .git/, ui/ (Vite HMR handles)
  - Auto-restart on backend changes (~1.5s poll)
  - Graceful shutdown (SIGTERM → 10s → SIGKILL)
  - Run DB migrations before first start
- [ ] **Verify:** `pnpm dev` starts everything, file changes trigger restart

**Depends on:** R3, R4

---

## R8: Docker + deployment (VPS mode)
- [ ] Create root `Dockerfile` (multi-stage following Paperclip):
  1. deps stage — copy all package.json, pnpm install
  2. build stage — build ui (vite), build server (tsc), build shared (tsc)
  3. production stage — SERVE_UI=true, node server/dist/index.js
- [ ] Update `docker-compose.yml` at root
- [ ] Update `curl | bash` install script
- [ ] **Verify:** `docker build` succeeds, container runs with SERVE_UI=true

**Depends on:** R3, R4, R5

---

## R9: CLI `onboard` command (local mode)
- [ ] Add `onboard` command to `packages/cli/` (like Paperclip's `npx paperclipai onboard`)
  - Check prerequisites: Node.js 20+, Docker running
  - Generate `.env` with random secrets (BETTER_AUTH_SECRET, ENCRYPTION_KEY)
  - Run `pnpm install` if needed
  - Apply DB migrations
  - Start server (Express + Vite dev middleware)
  - Open browser to `http://localhost:3100`
- [ ] Support `--yes` flag for non-interactive mode
- [ ] Update CLI package.json `bin` field so `npx askdb onboard` works
- [ ] **Verify:** Fresh directory → `npx askdb onboard --yes` → app running

**Depends on:** R7

---

## R10: Final verification + cleanup
- [ ] Delete old `askdb/` directory
- [ ] Clean `pnpm install` from scratch
- [ ] Verify all 3 modes:
  - Local: `npx askdb onboard --yes` → dashboard loads
  - Dev: `pnpm dev` → dashboard loads, HMR works, API works
  - Docker: `docker build` + `docker compose up` → dashboard loads
- [ ] Verify: MCP server responds, CLI works
- [ ] Update root `CLAUDE.md` with new structure
- [ ] No duplicate code between packages
- [ ] Git commit

**Depends on:** all above
