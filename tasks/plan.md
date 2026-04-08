# askdb — Implementation Plan

## Context

Building **askdb**, a self-hosted single-user tool that bridges MongoDB and AI agents via MCP (Model Context Protocol). User connects their MongoDB, data is cloned to a sandbox container, they configure field visibility, and get an MCP URL for Claude/ChatGPT/Cursor. Hidden fields are stripped at query time — AI never sees them.

**Scope:** MongoDB only, single user, self-hosted, manual sync, no cloud/team/billing.

## Tech Stack
- Next.js (latest, App Router) + TypeScript + custom `server.ts` (for MCP Express endpoint)
- shadcn/ui (with `shadcn apply` presets)
- Prisma + SQLite
- dockerode (sandbox container management)
- @modelcontextprotocol/sdk (MCP server via Express)
- mongodump/mongorestore (CLI, child_process.spawn)
- pnpm

## Architecture Note
MCP SDK requires Express `req`/`res`. Next.js App Router uses Web `Request`/`Response`. Solution: custom `server.ts` that boots both Next.js and an Express app on port 3000. Express handles `/mcp`, Next.js handles everything else.

## Dependency Graph

```
T1 (Scaffolding)
├── T2 (Prisma Schema) ─────┐
│                            ├── T4 (Auth)
├── T3 (Layout + shadcn) ───┘
│       │
│       ├── T5 (Dashboard Page)
│       └── T11 (Schema Browser UI)
│
T4 ──── T6 (Connection Wizard) ── T7 (Docker Sandbox) ── T8 (Sync) ── T9 (Schema + PII)
                                                                            │
                                          T10 (Visibility API) ────────────┘
                                          │       │
                                    T11 (UI)    T12 (MCP Server) ── T14 (Validation + Filtering)
                                                │                         │
                                          T13 (API Keys)           T15 (Audit Log)
                                                │
                                          T18 (Setup Page)    T16 (Manual Sync)
                                                              T17 (Audit Viewer)

T19 (Docker Deploy) ── T20 (Installer)
```

## Project Structure

```
askdb/
├── prisma/schema.prisma
├── server.ts                          # Custom server: Next.js + Express for /mcp
├── src/
│   ├── app/
│   │   ├── (auth)/login/ setup/
│   │   ├── (dashboard)/dashboard/
│   │   │   ├── connect/
│   │   │   ├── connections/[id]/schema/
│   │   │   ├── keys/
│   │   │   ├── audit/
│   │   │   └── setup/[keyId]/
│   │   └── api/ (connections, schema, keys, audit, auth)
│   ├── lib/
│   │   ├── adapters/types.ts          # DatabaseAdapter interface
│   │   ├── adapters/mongodb/          # MongoDB implementation
│   │   ├── mcp/server.ts             # MCP server + tools
│   │   ├── mcp/validation/           # Query + pipeline validators
│   │   ├── mcp/filtering/            # Field stripping
│   │   ├── auth/                     # JWT, bcrypt, API keys
│   │   ├── crypto/                   # Connection string encryption
│   │   ├── docker/                   # dockerode wrapper
│   │   └── pii/                      # PII detection patterns
│   └── components/                   # shadcn + custom
├── docker/Dockerfile, docker-compose.yml
└── scripts/install.sh
```

---

## Phase 1: Foundation
**Goal:** Working app with auth and dashboard shell.

### T1: Project Scaffolding + Custom Server [M]
- `pnpm create next-app@latest` + shadcn init + custom `server.ts` (Next.js + Express on :3000)
- TypeScript, path aliases, ESLint, directory stubs
- **Verify:** `pnpm dev` → page loads, `tsc --noEmit` passes

### T2: Prisma Schema + Database Layer [M]
- Full schema: users, connections, schema_tables, schema_columns, api_keys, audit_logs
- Prisma client singleton, SQLite WAL mode
- AES-256-GCM encryption util for connection strings
- **Verify:** `prisma migrate dev` works, encrypt/decrypt round-trips

### T3: Layout Shell + shadcn/ui [S]
- Dashboard layout (sidebar + content), auth layout (centered card)
- shadcn components: button, input, card, table, badge, switch, dialog, toast
- **Verify:** `/dashboard` shows shell, responsive sidebar
- **Parallel with T2**

### T4: Authentication [M]
- First-run `/setup` (create admin, only if no users exist)
- `/login` with email/password, bcrypt, JWT in httpOnly cookie
- Middleware: no user → /setup, no JWT → /login
- **Verify:** Fresh DB → setup → dashboard → logout → login flow works
- **Depends on T2, T3**

### CHECKPOINT 1: `pnpm dev` boots, auth works, dashboard shell renders, Prisma schema complete.

---

## Phase 2: Core Engine
**Goal:** Connect MongoDB, spin up sandbox, sync data, introspect schema. API-only.

### T5: Dashboard Overview Page [S]
- Connection list (empty state + connection cards)
- "Connect Database" CTA
- **Parallel with T6**

### T6: Connection Wizard API + UI [M]
- `DatabaseAdapter` interface in `lib/adapters/types.ts`
- MongoDB adapter: validate connection, check size (warn >5GB, reject >20GB)
- API: POST/GET/DELETE `/api/connections`
- Connect form UI
- **Verify:** POST valid MongoDB URL → connection created, encrypted in SQLite

### T7: Docker Sandbox Manager [L]
- dockerode wrapper: create/start/stop/destroy sandbox containers
- Named volumes for data persistence, port allocation (27100-27199)
- Container labels, health checks
- **Verify:** `createSandbox()` → `docker ps` shows container, `mongosh` connects

### T8: mongodump/mongorestore Sync [L]
- Spawn `mongodump` from prod → temp dir → `mongorestore` to sandbox
- Status lifecycle: IDLE → SYNCING → COMPLETED/FAILED
- Temp dir cleanup on success/failure
- **Verify:** Sync real MongoDB → sandbox has same data

### T9: Schema Introspection + PII Detection [M]
- Introspect sandbox: collections, fields, types, doc counts, sample docs
- Nested field support (dot notation)
- PII pattern matcher (HIGH/MEDIUM/LOW confidence)
- HIGH+MEDIUM auto-hidden, LOW flagged
- **Verify:** Sync DB with `email` field → auto-hidden, `status` field → visible

### CHECKPOINT 2: Full pipeline works via API: connect → sandbox → sync → introspect → PII detected.

---

## Phase 3: Dashboard + MCP
**Goal:** Schema browser UI, MCP server with filtered responses, API keys.

### T10: Visibility Config API [S]
- GET schema tree, PATCH table/field visibility, POST re-run PII detection
- **Parallel with T13**

### T11: Schema Browser UI [L]
- Accordion table: collections → fields, toggle switches, PII badges, sample values
- Optimistic UI, bulk actions ("Hide All PII")
- **Depends on T10, T3**

### T12: MCP Server with 4 Tools [L]
- `@modelcontextprotocol/sdk` + `StreamableHTTPServerTransport` on Express
- Bearer token auth via API keys
- 4 tools: list_tables, describe_table, query, sample_data
- Load visibility config, strip hidden fields
- **Depends on T10**

### T13: API Key Management [S]
- Generate `ask_sk_{32chars}`, hash with SHA-256, store prefix
- Create/list/revoke API + UI
- **Parallel with T10, T11, T12**

### CHECKPOINT 3: Schema browser works, MCP server responds to tool calls with filtered data, API keys work.

---

## Phase 4: Security + Polish
**Goal:** Production-safe query validation, audit trail, sync UI.

### T14: Query Validation + Field Filtering [L]
- Allowlist: find, aggregate, count, distinct
- Reject: $merge, $out, $collStats, $currentOp, $listSessions
- Reject: $lookup on hidden collections
- Field stripping on all responses (nested field support)
- 10s timeout, 500 doc limit
- **THE critical security task**
- **Verify:** Hidden fields never appear in any MCP response (adversarial testing)

### T15: Audit Logging [S]
- Log every MCP tool call: action, query, collection, execution time, doc count, API key
- **Parallel with T14**

### T16: Manual Sync + Status UI [M]
- "Sync Now" button, status polling, container health indicator
- Re-introspect after sync, preserve existing visibility settings
- **Parallel with T14, T15**

### T17: Audit Log Viewer UI [S]
- Paginated table with date/collection/action filters, expandable rows

### T18: MCP Setup Instructions Page [S]
- Tabbed instructions: Claude Desktop, ChatGPT, Cursor
- Copy buttons for MCP URL + API key
- **Parallel with T17**

### CHECKPOINT 4: All security invariants verified, audit trail complete, full e2e flow works.

---

## Phase 5: Deployment
**Goal:** Docker deploy + one-command installer.

### T19: Dockerfile + docker-compose [M]
- Multi-stage build (deps → build → runtime with mongodump/mongorestore)
- Docker socket mount, SQLite volume, env file
- **Verify:** `docker compose up` → full e2e flow works

### T20: curl|bash Installer [S]
- Check OS/Docker, generate secrets, pull image, start, print URL
- Idempotent (re-run safe)
- **Verify:** Fresh Ubuntu VPS → `curl | bash` → app running

### CHECKPOINT 5: Ship-ready. Clean install on VPS works end-to-end.

---

## Summary

| # | Task | Phase | Size | Depends On | Parallel With |
|---|------|-------|------|-----------|--------------|
| T1 | Scaffolding + Custom Server | 1 | M | — | — |
| T2 | Prisma Schema + DB | 1 | M | T1 | T3 |
| T3 | Layout Shell + shadcn | 1 | S | T1 | T2 |
| T4 | Auth (Setup + Login + JWT) | 1 | M | T2, T3 | — |
| T5 | Dashboard Overview | 2 | S | T4 | T6 |
| T6 | Connection Wizard | 2 | M | T4 | T5 |
| T7 | Docker Sandbox Manager | 2 | L | T6 | — |
| T8 | Sync (dump/restore) | 2 | L | T7 | — |
| T9 | Schema Introspection + PII | 2 | M | T8 | — |
| T10 | Visibility Config API | 3 | S | T9 | T13 |
| T11 | Schema Browser UI | 3 | L | T10, T3 | T13 |
| T12 | MCP Server (4 tools) | 3 | L | T10 | T11, T13 |
| T13 | API Key Management | 3 | S | T2, T4 | T10-T12 |
| T14 | Query Validation + Filtering | 4 | L | T12 | T15 |
| T15 | Audit Logging | 4 | S | T12 | T14 |
| T16 | Manual Sync + Status UI | 4 | M | T8, T9 | T14, T15 |
| T17 | Audit Log Viewer UI | 4 | S | T15 | T18 |
| T18 | MCP Setup Instructions | 4 | S | T12, T13 | T17 |
| T19 | Dockerfile + docker-compose | 5 | M | All | — |
| T20 | Installer Script | 5 | S | T19 | — |

**20 tasks: 6S + 6M + 5L**

## Verification (end-to-end)

1. `curl | bash` on clean VPS → app running
2. Visit `http://<IP>:3000` → setup page → create admin
3. Connect MongoDB → sandbox created → data synced
4. Schema browser → toggle fields → PII auto-hidden
5. Create API key → copy MCP URL
6. Configure Claude Desktop → ask "how many users?" → get answer with hidden fields omitted
7. Check audit log → query logged
8. Sync again → data refreshed, visibility preserved
9. Stop/restart Docker → everything persists

## Risks
1. **MCP SDK + Next.js**: Custom server.ts bridges the gap. Well-documented pattern.
2. **Docker-in-Docker**: Socket mount for sibling containers. Standard CI/CD pattern.
3. **mongodump availability**: Install `mongodb-database-tools` in Dockerfile runtime stage.
4. **SQLite concurrency**: WAL mode handles single-user fine.
5. **Field filtering bypass**: Adversarial testing in T14 is critical — test $project, $addFields, $replaceRoot, $unwind.
