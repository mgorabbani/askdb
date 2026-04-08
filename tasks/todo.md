# askdb — Task List

## Phase 1: Foundation

- [x] **T1** [M] Project Scaffolding (Next.js 16 + pnpm + TypeScript)
- [x] **T2** [M] Database Layer (Drizzle ORM + SQLite + AES-256-GCM encryption)
- [x] **T3** [S] Layout Shell + shadcn/ui v4
- [x] **T4** [M] Authentication (Better Auth + email/password)
- [x] **CHECKPOINT 1:** App boots, auth works, dashboard shell renders

---

## Phase 2: Core Engine

- [x] **T5** [S] Dashboard Overview Page
- [x] **T6** [M] Connection Wizard API + UI (adapter interface + MongoDB validate + size check)
- [x] **T7** [L] Docker Sandbox Manager (dockerode + volumes + health checks)
- [x] **T8** [L] mongodump/mongorestore Sync pipeline
- [x] **T9** [M] Schema Introspection + PII Detection
- [x] **CHECKPOINT 2:** Full pipeline via API: connect → sandbox → sync → introspect → PII

---

## Phase 3: Dashboard + MCP

- [x] **T10** [S] Visibility Config API
- [x] **T11** [L] Schema Browser UI (toggles, PII badges, optimistic updates)
- [x] **T12** [L] MCP Server — separate Express process on :3001, 4 tools, Bearer auth, field stripping, query validation, audit logging
- [x] **T13** [S] API Key Management (create/list/revoke + UI)
- [x] **CHECKPOINT 3:** Schema browser works, MCP responds with filtered data, API keys work

---

## Phase 4: Security + Polish

- [x] **T14** [L] Query Validation + Field Filtering (built into T12 MCP server)
- [x] **T15** [S] Audit Logging (built into T12 MCP server)
- [x] **T16** [M] Manual Sync + Status UI (sync button, polling, health indicator)
- [x] **T17** [S] Audit Log Viewer UI (paginated, filters, expandable rows)
- [x] **T18** [S] MCP Setup Instructions Page (tabbed: Claude/ChatGPT/Cursor + copy buttons)
- [x] **CHECKPOINT 4:** All features built, build passes clean

---

## Phase 5: Deployment

- [x] **T19** [M] Dockerfile + docker-compose (multi-stage, node:22-slim, mongodump)
- [x] **T20** [S] curl|bash Installer (idempotent, secret gen, IP detection)
- [x] **CHECKPOINT 5:** Deployment files ready

---

## Tech Stack (final)

- Next.js 16.2 (App Router) + TypeScript
- Drizzle ORM + better-sqlite3 (SQLite)
- Better Auth (email/password)
- shadcn/ui v4 (base-ui)
- MCP SDK (@modelcontextprotocol/sdk) — separate Express server
- dockerode + mongodump/mongorestore
- pnpm
