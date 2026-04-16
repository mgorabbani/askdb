# Plan: Cloud Chat App Spinoff (codename TBD)

## Context
`askdb` stays open source as-is — a self-hosted MongoDB MCP bridge for AI agents.

This plan is for a **separate, new repo**: a cloud-native "chat with your data" app. The UX is a persistent chat sidebar on the left and a main body with navigable pages for: connections, schema, settings, audit, and a dashboard/artifacts gallery. Artifacts are chat-generated queries or functions, saved once, re-run on every view so the UI stays the same but data stays fresh. A mobile app (Expo) consumes the same API later.

Core differentiators versus a generic "chat with your DB":
1. **Sanitized read-replica onboarding** — every new DB goes through a human-in-the-loop review before the agent ever sees a row.
2. **Skills files** (md + TS) — the agent's knowledge of each connection is persisted to disk so it doesn't re-discover every session. Inspired by Claude Code's identity/memory pattern (soul/heartbeat).
3. **Multi-DB agent** — agent can plan, query, and join across connections in one thread.
4. **TS code-mode** (TanStack AI) — the model writes TypeScript that runs in a sandbox and calls query primitives, instead of guessing math/joins token-by-token.
5. **Safe writes via RLS + column allowlists** — agent can modify settings, fix schemas, and mutate user data, but only inside a per-user isolation boundary enforced at DB level (Postgres RLS) and API level (column allowlist). Pattern borrowed from Supabase / `aws-saas-factory-postgresql-rls` / Lovable's security model.
6. **First-class MCP server with OAuth 2.1** — the same tool catalog is exposed as an MCP server at `/mcp`, following the 2026 MCP auth spec (RFC 9728 resource metadata + RFC 7591 dynamic client registration + PKCE), so Claude Desktop, Claude Code, ChatGPT Apps, etc. can connect with the user's own scoped token.

The askdb codebase informs patterns (encryption, Drizzle schema shape, Better Auth, audit log, QuickJS sandbox) but is **not** a dependency. New codebase, own connectors.

## Architecture

### Repo layout (new repo, pnpm workspaces)
```
/apps
  /web        Vite 8 + React 19 SPA (dashboard, chat sidebar, onboarding wizard)
  /mobile     PLACEHOLDER ONLY — empty folder + README for future Expo app. Do not scaffold yet.
  /api        Fastify 5 server (chat SSE, connectors, auth, replication worker, MCP)
/packages
  /shared       Drizzle schema, Zod DTOs, tool defs, PII detectors
  /connectors   Per-DB adapters (pg, mysql, mongodb, sqlite/duckdb) w/ sampling + replicate
  /sandbox      QuickJS runner for code-mode + code artifacts
  /skills       Skills-file reader/writer (soul.md, heartbeat.md, per-connection packs)
/skills         Canonical top-level skill files (checked in, editable by user)
```

### Framework choice: Fastify vs Elysia
Picking **Fastify**. Comparison summary:

| Dimension | Fastify 5 | Elysia |
|---|---|---|
| Runtime | Node / Deno / Bun | Bun-first (peak perf requires Bun) |
| Maturity | Since 2016, battle-tested at scale | ~2023, fast-moving |
| Plugin ecosystem | Huge: `@fastify/jwt`, `@fastify/cors`, `@fastify/rate-limit`, `@fastify/multipart`, `@fastify/oauth2`, `@fastify/websocket`, `@fastify/swagger`, etc. | Smaller, still gaps around OAuth/issuer, queues, SSE helpers |
| TypeScript | Good, via schema-to-type plugins (`TypeBox`, `Zod` via `fastify-type-provider-zod`) | Best-in-class inference + Eden end-to-end client |
| Validation | JSON Schema / Zod / TypeBox | Own `t.` schema system |
| SSE for TanStack AI | Straightforward via `reply.raw` or `@fastify/sse-v2` | Works, less documented for TanStack AI |
| Better Auth support | First-class Fastify adapter | Community adapter only |
| Deployment | Any Node host (Hetzner, Fly, Railway) | Bun-native hosts or Bun-on-Node |
| Hiring / docs | Abundant | Niche |

**Why Fastify here**: we need the Better-Auth adapter, a solid OAuth issuer story for MCP (Phase 8), BullMQ/pg-boss for the replication worker, multipart for imports, SSE for chat. Elysia's end-to-end types are nice but we already get typed contracts via Zod + TanStack Query. Not locking the runtime to Bun keeps hosting options open (Supabase/Crunchy/Hetzner VPS).

If perf ever becomes a wall, Fastify itself runs on Bun and clocks within ~10% of Elysia; we'd gain Bun's speed without a rewrite.

### Stack (all Vercel-free)

**Server (`apps/api`)**
- Fastify 5 with `fastify-type-provider-zod` for typed routes + Zod validation
- TanStack AI `chat()` over SSE at `POST /api/chat` via `reply.raw` (or `@fastify/sse-v2`)
  - Providers: Anthropic (primary), OpenAI, Gemini, Ollama, OpenRouter
- Agent loop with isomorphic, typed tools (Zod-validated)
- **TS code-mode tool** (per TanStack AI "code mode" blog): model emits a TS function, sandbox executes with `query(connectionId, …)`, `aggregate`, `fetchArtifact`
- Drizzle ORM + Postgres (app data); every request opens tx with `SET LOCAL app.user_id = …` for RLS
- Better Auth via `@better-auth/fastify`
- AES-256-GCM encryption for every stored DSN (`node:crypto`, key from env)
- `@fastify/rate-limit`; 30s query timeout; 10k row cap; memory cap
- Replication worker: BullMQ on Redis (or pg-boss if we want Postgres-only) to build sanitized replicas asynchronously
- MCP server mounted under the same Fastify app at `/mcp` + `/.well-known/oauth-*`

**Web (`apps/web`)**
- React 19 + Vite 8 + Tailwind 4 + shadcn/ui (match askdb look)
- TanStack Router (file-based) + TanStack Query
- Chat: `@tanstack/ai-react` `useChat` against `/api/chat` via `fetchServerSentEvents`
- Chat UI: **assistant-ui** primitives wrapped in a custom TanStack-AI adapter
- Charts: shadcn charts (Recharts); tables: TanStack Table
- Layout: persistent left sidebar (chat), top nav, main content; collapsible < md

**Mobile (`apps/mobile`)** — **deferred**
- Folder reserved (`apps/mobile/README.md` documenting intent). No scaffolding, no dependency, no build step. Picked up post-MVP.

## New-connection onboarding wizard (HITL)
When a user adds a DB, we never point the agent at the live DB. Instead:

1. **Connect (read-only creds)** — user pastes DSN; we connect with lowest-privilege creds; immediate connection test.
2. **Introspect + sample** — list all tables/collections; pull up to N (e.g. 5) sample rows per table.
3. **Auto-detect PII** — column-name heuristics + value regex for email / phone / SSN / credit card / DOB / password / address / IP → mark fields "hidden by default." Detectors live in `packages/shared/src/pii`.
4. **AI auto-describe** — small provider call with {table name, columns, sample rows with PII masked} → one-sentence description per table and per-column purpose. Results shown to user for editing.
5. **User review UI** — per-table card with: include/exclude, per-column include/exclude + PII override, optional row-level filter (e.g. `tenant_id = :user_tenant`), edit description. Bulk actions.
6. **Submit → build sanitized replica**:
   - **Postgres**: `CREATE SUBSCRIPTION` with a publication covering only approved tables; views on the replica mask excluded columns; RLS policies from user's filters.
   - **MySQL/MariaDB**: `mysqldump --tables … --where …` into a fresh schema on our replica instance; scheduled incremental via binlog reader (phase 2) or interval re-dump (phase 1).
   - **MongoDB**: per-collection `$project` + `$match` via change streams into a target DB (same pattern askdb uses but column-filtered).
   - **SQLite / DuckDB**: file-level copy with views masking excluded columns.
   - Replication runs in a worker; user sees "ready" status on dashboard.
7. **Write skills pack** (per connection) — see next section. These files are now the agent's primary reference.

The agent is **only** ever connected to the sanitized replica, never the origin DB. Connection strings to origin are stored encrypted and used only by the replication worker.

## Skills / memory system (soul / heartbeat pattern)

Inspired by Claude Code's CLAUDE.md / memory files. Skills are plain markdown + TS, stored in the user's workspace (DB-backed, but rendered as files at `/skills/<userId>/…` for transparency and export).

```
/skills
  soul.md              App + agent identity, tone, hard rules (read-only, PII, multi-tenant)
  heartbeat.md         Live state: current thread, active connection(s), recent schema deltas
  /common
    query-style.md     House style for SQL/MQL (CTEs, naming, limits)
    charting.md        When to pick table vs bar vs line; axis conventions
  /connections
    /<connectionId>
      overview.md        Connection purpose (AI-generated + user-edited)
      tables.md          Per-table description + column semantics + PII notes
      relationships.md   FK graph, inferred joins
      learnings.md       Query patterns the agent discovered that worked
      queries.ts         Saved TS code-mode artifacts as importable helpers
      schema.json        Machine-readable schema hash + column list
```

- On thread start, agent loads `soul.md`, `heartbeat.md`, and — for each connection referenced — `overview.md` + `tables.md` + `learnings.md` into system context.
- `save-learning` tool lets the agent append to `learnings.md` after a successful multi-step query (model-proposed, rate-limited, user-reviewable from the Skills page).
- `heartbeat.md` is updated by the server on every thread tick: last schema hash, active connection, last query time.
- User can hand-edit any file from a Skills page in the web app — changes reflect immediately in agent context.

## Safe agent writes — three isolation zones

The agent needs to do more than read. Users should be able to say *"set up this Postgres properly — I'm not sure how the fields connect"* and have the agent run DDL, fix rows, update app settings. This is only safe if there's a hard boundary the agent cannot cross. Three zones with different rules:

### Zone A — the user's row in our app DB (settings, profile, preferences)
- Single Postgres cluster, every table carries `user_id`.
- **Postgres RLS** on every table: `USING (user_id = current_setting('app.user_id')::uuid)`.
- API server opens each request's DB transaction with `SET LOCAL app.user_id = $auth.userId` — so even if a bug leaks a query, the DB refuses rows from other users. Pattern from `aws-saas-factory-postgresql-rls` and Supabase.
- Agent has tools `read-settings`, `update-settings(patch)`, `update-profile(patch)` — all scoped by RLS, plus a Zod schema defining *which fields* the AI may touch (e.g. allow `theme`, `defaultModel`; deny `email`, `role`, `apiKeys`).

### Zone B — the user's origin DB (their Postgres / MySQL / Mongo)
- Default: **read-only**, via sanitized replica (see onboarding wizard).
- Opt-in write mode per connection. When a user enables writes:
  - They pick a set of tables + **specific columns** that are writable by the agent.
  - We create a dedicated Postgres role per-user-per-connection with `GRANT SELECT` on all approved cols and `GRANT INSERT/UPDATE(col_a, col_b)` **only** on the writable cols. `REVOKE` everything else.
  - Optional row-filter: RLS policy on the origin DB, or a `WHERE` guard enforced in our SQL rewriter, so updates only touch rows the user "owns" in their own schema (e.g. `tenant_id = :user_tenant`).
  - All mutating queries are parsed (pg-query-parser / node-sql-parser) and rejected unless they touch only the allowlisted tables/columns — defense-in-depth on top of the DB role.
  - Every mutation requires **agent → user confirmation** in chat (tool-call card with "Approve / Modify / Deny") for the first N writes; user can set a per-connection trust level ("always confirm" / "confirm DDL only" / "trust writes on these tables").
- DDL ("set up my schema") runs in a **staging schema** first: agent generates a migration plan (list of `CREATE TABLE`/`ALTER TABLE` statements), user approves, we apply to staging, run a smoke test, then diff-apply to the real schema. Uses a mini-migrations table on the origin DB to record what we ran.

### Zone C — user's data created *inside* our app (threads, artifacts, skills, notes)
- Same RLS model as Zone A.
- Agent can freely CRUD within its own user's scope: rename artifacts, rewrite skills, delete threads, etc.

### Field-level allowlist schema (shared across all zones)
- A single config object per connection/table describes `{ included, writable, piiKind, description }` per column. Lives in `connection_columns`. The agent reads this to know what it *can* touch; the API enforces the same allowlist on every write; and the DB role enforces it a third time. Three-layer defense.

### Open source references to study / borrow from
- `aws-saas-factory-postgresql-rls` — canonical multi-tenant RLS SaaS template.
- `supabase/supabase` — RLS + JWT claim pattern + SQL policies UI (we'll ape the UX).
- `PostgREST` — auto-derived API from RLS policies; useful for understanding the contract.
- `hasura/graphql-engine` — column-level permissions model.
- `KavachOS` — agent-auth with delegated, time-limited scopes for sub-agents.
- `supabase/easyrls` (and similar) — RLS policy editor UX.
- `pg-query-parser` / `vitaly-t/pg-promise` — SQL AST parsing for the mutation guard.

## MCP server with OAuth 2.1

Expose the same tool catalog at `/mcp` per the 2026 MCP auth spec.

- MCP server acts as an **OAuth 2.1 resource server**. Our app serves as the **authorization server** (Better Auth already issues sessions; we add an OAuth issuer module — candidates: `node-oidc-provider`, `@better-auth/oauth-provider`, or Hono-based `oauth4webapi`).
- Protected resource metadata at `/.well-known/oauth-protected-resource` (RFC 9728) points to `/.well-known/oauth-authorization-server`.
- **Dynamic client registration** (RFC 7591) at `/oauth/register` so Claude Desktop / Code / ChatGPT can self-register without the user copy-pasting a client ID.
- **PKCE required** for all clients (public + confidential).
- **Per-tool, per-resource scopes**:
  - `connections:read` — list + describe
  - `connections:query:<id>` — read queries against connection `<id>`
  - `connections:write:<id>` — writes (honors Zone B allowlist)
  - `artifacts:run` / `artifacts:write`
  - `settings:write` (Zone A)
  - `skills:write`
- Consent screen on first authorization — user sees which tools + connections the client is asking for.
- Audit log records every MCP tool call with the client ID and scopes used.
- MCP tool surface: mirror the internal chat tools (`list-connections`, `describe-table`, `run-query`, `run-code`, `save-artifact`, `run-artifact`, `update-settings`). Keeping parity means the web chat and external AI clients exercise the same code path and permission model.

## Multi-DB agent behavior

- Agent's system context always includes the list of the user's connections (id, kind, label, 1-line description from `overview.md`).
- Every query tool requires a `connectionId` argument; the agent is trained (via system prompt + examples) to pick based on the question.
- For cross-DB joins / comparisons: agent writes a code-mode TS function that calls `query(connA, …)` and `query(connB, …)`, then merges/aggregates in-process. This is the killer use case for code-mode: the model doesn't have to guess numbers, it writes code.
- Code-mode sandbox primitives:
  ```ts
  query(connectionId, sqlOrMql, params?): Promise<Row[]>
  aggregate(rows, groupBy, agg): Row[]
  saveArtifact(spec): ArtifactId
  ```
- Outputs flow back through the agent loop so the model can narrate and offer "Save as artifact."

## Data model (app Postgres)

- `users`, `sessions` (Better Auth); RLS on every downstream table via `user_id = current_setting('app.user_id')::uuid`
- `connections` — id, userId, kind, encryptedDsn, label, status (`onboarding`|`replicating`|`ready`|`error`), replicaDsn (internal, encrypted), schemaHash, writeMode (`off`|`confirm-all`|`confirm-ddl`|`trusted`)
- `connection_tables` — id, connectionId, name, included, description, aiDescription, rowFilter (nullable)
- `connection_columns` — id, tableId, name, type, included, writable (bool), piiKind, userOverride
- `connection_roles` — id, connectionId, pgRoleName, grantsHash (for Zone B dedicated roles)
- `threads`, `messages` — chat history
- `artifacts` — id, userId, connectionIds (array), kind (`sql`|`mql`|`code`), source, paramsSchema, render, renderConfig, createdFromMessageId, …
- `artifact_runs` — id, artifactId, startedAt, ms, rowCount, error
- `skills_files` — id, userId, connectionId (nullable), path, content, updatedAt, updatedBy (`ai`|`user`)
- `mutation_proposals` — id, userId, connectionId, threadId, kind (`dml`|`ddl`), sql, status (`pending`|`approved`|`denied`|`applied`|`failed`), appliedAt, diff
- `oauth_clients` — id, clientId, clientSecretHash, name, redirectUris[], registeredVia (`dynamic`|`manual`), createdAt
- `oauth_grants` — id, userId, clientId, scopes[], resourceId (connection scope), expiresAt
- `audit_logs` — userId, connectionId, actor (`user`|`agent`|`mcp-client:<id>`), action, query, ms, rows, toolCallId

## Artifact lifecycle

1. User chats → agent calls `run-query` or `run-code` → result rendered inline as table/chart
2. "Save as artifact" on the tool-call card → modal pre-filled with source + render config → writes `artifacts` + appends a skill entry to `queries.ts`
3. Dashboard = grid of artifact cards; each card calls `POST /api/artifacts/:id/run` on mount → executes against the sanitized replica → renders via stored `renderConfig`
4. Short-TTL server cache keyed by `(artifactId, paramsHash)`; manual refresh button

## App DB hosting — security-focused (no Neon)

1. **Self-hosted Postgres on Hetzner / Fly Machines** — disk encryption, private network, restic→S3 encrypted backups. Max control.
2. **Crunchy Bridge** — SOC2 Type 2, HIPAA-eligible, VPC peering. Recommended managed.
3. **Supabase (Postgres only)** — SOC2 at Team, self-hostable escape hatch.
4. **Aiven for PostgreSQL** — multi-cloud, SOC2/HIPAA, BYO-KMS on higher tiers.

**Recommendation**: Supabase managed for MVP; plan migration to self-hosted or Crunchy Bridge before first paying customer.

Replica DBs (per user/connection) are hosted on the same infra (isolated schemas) for MVP; separate cluster or BYO-region for enterprise.

## Critical files / references (patterns to borrow from askdb)

- `/home/user/askdb/packages/shared/src/db/schema.ts` — Drizzle shapes, encrypted column pattern
- `/home/user/askdb/packages/mcp-server/src/index.ts` — tool registration, audit logging, learning hooks
- `/home/user/askdb/packages/shared/src/...` (sandbox) — QuickJS caps (128MB, 30s, 50 bridge calls, 256KB result)
- `/home/user/askdb/ui/src/pages/dashboard/schema.tsx` — field visibility UI pattern for the onboarding wizard
- `/home/user/askdb/.env.example` — env surface

## Phases

**Phase 0 — Repo setup (0.5 day)**
pnpm workspace; Biome + tsc project refs; CI; base shadcn install.

**Phase 1 — Auth + connection CRUD (2 days)**
Better Auth; connection add/test/delete; encrypted DSN storage; list UI.

**Phase 2 — Onboarding wizard (3 days)**
Introspection, sampling, PII detection, AI auto-describe, review UI, submit. Replica worker: Postgres logical replication path first.

**Phase 3 — Skills engine (2 days)**
`/skills` layout generated after onboarding; soul/heartbeat files; Skills page for editing; loader that assembles system context per thread.

**Phase 4 — Chat MVP + code-mode (3 days)**
TanStack AI server; assistant-ui sidebar; tools: `list-connections`, `describe-table`, `run-query`, `run-code`, `save-learning`. Code-mode sandbox with cross-DB primitives.

**Phase 5 — Artifacts + dashboard (2 days)**
Save-as-artifact; dashboard grid; re-run on view; shadcn charts; TanStack Table for tables.

**Phase 6 — Safe writes (3 days)**
Zone A RLS + update-settings tool. Zone B write mode: per-column allowlist UI, dedicated pg role provisioner, SQL AST guard, mutation_proposals + approval UI. DDL migration planner.

**Phase 7 — Other replica kinds (2 days)**
MySQL (dump/interval), MongoDB (change streams + $project), SQLite/DuckDB (copy + views).

**Phase 8 — MCP server + OAuth 2.1 (3 days)**
OAuth issuer module; `/.well-known/oauth-*` endpoints; RFC 7591 dynamic client registration; PKCE; consent screen; `/mcp` endpoint exposing the same tools with scope enforcement; Claude Desktop/Code/ChatGPT Apps smoke tests.

**Phase 9 — Settings, audit, polish (1.5 days)**
Settings, API keys, audit log page, error surfaces, rate limits, BYO model keys.

**Phase 10 — (deferred) Expo mobile shell**
Out of scope for this round. Folder kept as a placeholder.

## Verification

- **Connectors**: vitest against Dockerized pg / mysql / mongo / sqlite with fixture data; assert mutation queries rejected.
- **Onboarding**: Playwright flow — add pg DSN → wizard renders tables + samples → PII auto-hidden → submit → replica status goes `onboarding → replicating → ready` → agent query returns only approved columns.
- **Skills**: unit tests that `loadContext(userId, threadId)` assembles the expected files; editing a file mid-thread is picked up on next turn.
- **Multi-DB**: fixture with 2 connections; chat "compare X between them" → agent emits code-mode TS → sandbox runs → merged result rendered.
- **Artifacts**: save from chat → appears on dashboard → re-run returns fresh rows → delete flow.
- **Safe writes**: Zone A — user A's agent cannot read/write user B's settings even with a forged query (RLS test). Zone B — writes blocked unless column is writable; pg role has no grant outside allowlist (introspection test); DDL goes through migration proposals with user approval.
- **MCP OAuth**: Claude Desktop adds our server via URL only → dynamic client registration succeeds → consent screen lists scopes → tool call against connection X fails with 403 when scope is for connection Y → audit log attributes calls to the MCP client ID.
- **Security**: encrypted DSN never in logs; origin DB never hit by chat path in read mode (only replica); mutation guard blocks `INSERT/UPDATE/DELETE/DROP` outside allowlist; rate limits enforced; AES key rotation documented; OAuth tokens revocable from settings.

## Open items for later
- Teams / workspace sharing of connections, artifacts, skills
- Scheduled artifact runs + alerts (Slack/email)
- Streamed large results (cursor-based)
- MCP export: let this app expose its skills + tools as an MCP server for Claude Desktop / Code
- Skills marketplace: share connection packs across users (opt-in)
