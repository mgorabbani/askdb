# dbgate - Product Specification Summary

> **One-liner:** Connect your database to any AI agent in 5 minutes. Data stays protected, team stays in control.

## What It Is

dbgate is an **open-source, database-agnostic orchestration layer** that bridges company databases and AI agents (Claude, ChatGPT, Cursor, etc.). It supports **PostgreSQL, MongoDB, and MySQL** from day one.

- **Docker sandbox containers** — dump/restore from prod into isolated Docker containers. AI never touches prod.
- **Dynamic field filtering** — CTO sees real sample data, toggles fields/tables visible or hidden. Hidden fields are stripped from MCP responses at query time. No fake data, no masking engine — just omit what shouldn't be seen.
- **MCP (Model Context Protocol)** — standard interface for AI agent communication, DB-type-aware queries.

It is **NOT** a database, BI tool, dashboard builder, or agent framework. It is the secure bridge between databases and AI agents.

---

## Problem

Business teams need data answers ("how many users signed up this week?") but currently must wait on engineers to write queries or build APIs. Existing workarounds are all bad:

- Sharing raw DB credentials with AI tools (security risk)
- Exporting CSVs to ChatGPT (stale data, GDPR violations)
- Setting up Metabase/Looker (weeks of work, not agent-compatible)

## Solution

CTO connects their production database once, configures what data AI agents can see (visible or hidden per field/table), and gives every team member a personal MCP connection to use in Claude, ChatGPT, or any MCP-compatible tool.

**Core flow:**
```
CTO pastes DB URL → dbgate clones to sandbox → CTO sees real sample rows
→ CTO toggles which fields/tables to hide → saves config → invites team
→ each member gets MCP URL → pastes into Claude → done
```

**Key principles:**
- **Database-agnostic** — works with Postgres, MongoDB, MySQL (and extensible to more)
- **Two simple policies** — visible (AI sees real data) or hidden (field stripped entirely)
- Zero data on dbgate servers (sandbox lives in Docker containers alongside the app)
- Only stores: configs, user accounts, API keys, audit logs
- One MCP server works across all AI platforms
- Non-technical setup (no CLI, no YAML, no SQL required for end users)
- **One-command self-hosted install** — `curl -sSL https://get.dbgate.dev | bash`
- **Configurable sync schedule** — manual, every 6h, 12h, daily, or weekly

---

## Target Users

| Tier | Who | Need |
|------|-----|------|
| **Primary** | Startup CTO (5-50 person company) | Connect any database (Postgres, MongoDB, MySQL), give team self-serve data access in 10 minutes |
| **Secondary** | Team members (sales, marketing, ops) | Ask questions in Claude/ChatGPT, zero technical skill required |
| **Tertiary** | Enterprise (future) | Self-hosted, SSO/SAML, audit logs, data stays in VPC |

---

## Architecture

### Data Flow
```
User's Prod DB ──> dump ──> restore to Docker sandbox ──> ready
   |                              |
   ├─ Postgres  (pg_dump)     Docker Postgres
   ├─ MongoDB   (mongodump)   Docker MongoDB
   └─ MySQL     (mysqldump)   Docker MySQL
                                  |
                            MCP Server ──> strips hidden fields at query time
                                  |
                      Claude / ChatGPT / Cursor
```

**No masking step. No fake data.** Sandbox is a clean copy of prod. The MCP server applies the visibility config when returning results — hidden fields are simply omitted from responses.

### How Field Filtering Works (query time)

```
1. AI agent calls query("SELECT * FROM users WHERE plan = 'pro'")
2. MCP server executes against sandbox → gets full rows with ALL fields
3. MCP server loads visibility config for this connection
4. Hidden fields (email, phone, password_hash) are stripped from results
5. Only visible fields (id, plan, created_at, last_login) are returned
6. Query + result metadata logged to audit trail
```

The AI never knows hidden fields exist. `describe_table` doesn't list them. `query` results don't include them. `sample_data` omits them.

### Database Adapter Pattern
Each supported database implements a common interface:
```
┌─────────────────────────────────────────┐
│           Database Adapter              │
├─────────────────────────────────────────┤
│  validateConnection(url)                │
│  dumpFromProd(sourceUrl) -> dumpFile    │
│  restoreToSandbox(dumpFile) -> void     │
│  introspectSchema() -> tables/fields    │
│  executeQuery(query) -> results         │
│  validateReadOnly(query) -> boolean     │
│  refreshSandbox() -> void               │
└─────────────────────────────────────────┘
         │              │             │
    ┌────┴───┐    ┌────┴───┐   ┌────┴───┐
    │Postgres│    │MongoDB │   │ MySQL  │
    │Adapter │    │Adapter │   │Adapter │
    │pg_dump │    │mongodmp│   │mysqldum│
    └────────┘    └────────┘   └────────┘
```

| DB Type | Dump Tool | Sandbox Container | Query Format |
|---------|-----------|-------------------|--------------|
| **Postgres** | `pg_dump` / `pg_restore` | `postgres:16-alpine` | SQL SELECT |
| **MongoDB** | `mongodump` / `mongorestore` | `mongo:7` | Aggregation pipeline / find |
| **MySQL** | `mysqldump` / `mysql` | `mysql:8` | SQL SELECT |

### Protocol Stack (layered)
```
+-------------------------------------------+
| A2A Server (post-MVP)                     |
| NL question in -> plain answer out        |
| Discoverable via Agent Card               |
+-------------------------------------------+
| MCP Server (MVP)                          |
| list_tables, describe, query, sample      |
| DB-type-aware, strips hidden fields       |
+-------------------------------------------+
| Core Engine                               |
| Auth, permissions, audit, rate limits     |
+-------------------------------------------+
| Database Adapter Layer                    |
| Postgres | MongoDB | MySQL adapters       |
| Docker sandbox containers                 |
+-------------------------------------------+
```

### What We Store vs. Don't Store
- **Store:** User accounts, org settings, visibility configs, API keys (hashed), audit logs, sync schedules
- **Never store:** Database content, query results, connection strings (encrypted at rest, never logged), user's production data

---

## Tech Stack

### Web App
| Layer | Tech | Why |
|-------|------|-----|
| Framework | Next.js 15 (App Router) | Full-stack, RSC, server actions |
| Language | TypeScript | Type safety across stack |
| Styling | Tailwind CSS + shadcn/ui | Fast, consistent UI |
| Auth (cloud) | Clerk | Teams, orgs, invite flows, OAuth |
| Auth (self-hosted) | Built-in email/password (bcrypt + JWT) | Zero external dependencies |
| Database (app) | PostgreSQL (Docker container) | App metadata store (configs, users, audit logs) |
| ORM | Drizzle | Type-safe, lightweight |
| Hosting (cloud) | Vercel | Zero-config Next.js deploy |
| Hosting (self-hosted) | Docker on any VPS | One-command install |
| Payments | Stripe (cloud only) | Usage-based billing |
| Reverse Proxy | Caddy (self-hosted) | Auto-SSL, custom domains |

### MCP Server
| Layer | Tech | Why |
|-------|------|-----|
| Runtime | Node.js | MCP SDK is TypeScript-first |
| MCP SDK | @modelcontextprotocol/sdk | Official Anthropic SDK |
| Transport | Streamable HTTP (SSE fallback) | Works with remote clients |
| Hosting (cloud) | Fly.io or Railway | Per-org isolated instances |
| Hosting (self-hosted) | Docker (same VPS) | Runs alongside dashboard |
| Base | Fork of Google MCP Toolbox patterns | Proven DB query patterns |

---

## External Dependencies

### Self-Hosted (zero external dependencies)
| Component | How | Cost |
|-----------|-----|------|
| Sandbox DBs | Docker containers (postgres, mongo, mysql) | Included — runs on your VPS |
| Field filtering | Built-in — MCP server strips hidden fields from responses | Included — zero dependencies |
| Auth | Built-in email/password | Included |
| Reverse proxy | Caddy (auto-SSL) | Included |
| **Total** | **Just a VPS with Docker** | **$5-20/mo VPS** |

### Cloud (dbgate.dev)
| Service | Purpose | Cost |
|---------|---------|------|
| Docker sandbox instances | Per-customer sandbox DBs | ~$5-8/mo per customer |
| Clerk | Auth + team management (cloud version) | Free tier -> $25/mo |
| Vercel | Web app hosting | Free tier -> $20/mo |
| Fly.io | MCP server hosting | ~$5-10/mo per org |

---

## Data Model

### Core Tables
- **users** — User accounts (email, bcrypt password hash for self-hosted; Clerk user ID for cloud)
- **organizations** — Tenant, has plan tier and Stripe customer (cloud)
- **connections** — Database connections (encrypted), db_type (postgres/mongodb/mysql), sandbox container ID, sync_schedule, last_sync_at
- **schema_tables** — Cached table metadata (name, row count, `is_visible` boolean)
- **schema_columns** — Column metadata with PII auto-detection flag, `is_visible` boolean (visible = AI sees it, hidden = stripped from responses)
- **api_keys** — Per-user keys with role (admin/analyst/limited), allowed_tables restriction, bcrypt-hashed
- **audit_logs** — Every MCP query logged with action, query text, tables accessed, execution time, row count, IP

---

## CTO Setup Flow (the core UX)

### Step 1: Connect database
CTO selects DB type, pastes connection string, validates (read-only test).

### Step 2: Sandbox created
dbgate spins up a Docker container, runs dump/restore. CTO sees a progress bar.

### Step 3: Schema browser with sample data
**This is the key screen.** CTO sees every table/collection with a sample of the latest row from each, and toggles visibility per field and per table.

```
┌───────────────────────────────────────────────────────────────────┐
│  Schema Browser — acme-production (MongoDB)                       │
│  Last synced: just now                              [Sync Now]    │
│  Sync schedule: [Manual ▼]                                        │
├───────────────────────────────────────────────────────────────────┤
│                                                                   │
│  ▼ 👁 users (15,234 docs)                                        │
│  ┌─────────────┬──────────┬──────────────────────────┬──────────┐│
│  │ Field       │ Type     │ Sample (latest row)      │ Visible? ││
│  ├─────────────┼──────────┼──────────────────────────┼──────────┤│
│  │ _id         │ ObjectId │ 6621a3f4e8b2...          │ [✓]  ⚠  ││
│  │ email       │ String   │ sarah@acmecorp.com       │ [ ]  ⚠  ││
│  │ full_name   │ String   │ Sarah Chen               │ [ ]  ⚠  ││
│  │ password    │ String   │ $2b$10$xK9v...           │ [ ]  ⚠  ││
│  │ phone       │ String   │ +1-415-555-0123          │ [ ]  ⚠  ││
│  │ plan        │ String   │ pro                      │ [✓]      ││
│  │ company     │ String   │ Acme Corp                │ [✓]      ││
│  │ created_at  │ Date     │ 2026-01-15T10:30:00Z     │ [✓]      ││
│  │ last_login  │ Date     │ 2026-04-06T14:22:00Z     │ [✓]      ││
│  └─────────────┴──────────┴──────────────────────────┴──────────┘│
│  ⚠ = PII auto-detected (recommended to hide)                     │
│                                                                   │
│  ▼ 👁 orders (89,201 docs)                                       │
│  ┌─────────────┬──────────┬──────────────────────────┬──────────┐│
│  │ Field       │ Type     │ Sample (latest row)      │ Visible? ││
│  ├─────────────┼──────────┼──────────────────────────┼──────────┤│
│  │ _id         │ ObjectId │ 6621b5a1c9d3...          │ [✓]      ││
│  │ user_id     │ ObjectId │ 6621a3f4e8b2...          │ [✓]      ││
│  │ amount      │ Number   │ 149.99                   │ [✓]      ││
│  │ status      │ String   │ completed                │ [✓]      ││
│  │ billing_email│ String  │ sarah@acmecorp.com       │ [ ]  ⚠  ││
│  │ created_at  │ Date     │ 2026-04-01T09:15:00Z     │ [✓]      ││
│  └─────────────┴──────────┴──────────────────────────┴──────────┘│
│                                                                   │
│  ► 👁 products (342 docs)        all fields visible               │
│  ► 👁 campaigns (128 docs)       all fields visible               │
│  ► 👁 subscriptions (8,901 docs) 1 field hidden                   │
│  ► 🚫 _migrations (47 docs)     [entire table hidden]             │
│  ► 🚫 _sessions (12,003 docs)   [entire table hidden]             │
│                                                                   │
│  ────────────────────────────────────────────────────             │
│  Summary: 7 tables visible, 2 hidden | 6 fields hidden (all PII) │
│                                                                   │
│  ┌─────────────────────────┐                                      │
│  │   Save & Deploy MCP  →  │                                      │
│  └─────────────────────────┘                                      │
└───────────────────────────────────────────────────────────────────┘
```

**Key UX details:**
- CTO sees **real data** from the latest row — they need to see actual values to decide what to hide
- PII fields are auto-detected and **pre-unchecked** (hidden by default). CTO can override.
- Internal tables (`_migrations`, `_sessions`) are auto-hidden
- Each table has a master toggle to hide the entire table
- Sync schedule dropdown right on this page: Manual / Every 6h / Every 12h / Daily / Weekly
- Config is saved to the app DB. Takes effect immediately for all MCP queries.
- **Changing a toggle doesn't require re-sync** — it's applied at query time

### Step 4: MCP URL ready
Connection instructions with copy buttons for Claude Desktop, ChatGPT, Cursor.

---

## MCP Server Spec

### Endpoint
- Cloud: `https://{org-slug}.dbgate.dev/mcp`
- Self-hosted: `http://<VPS_IP>/mcp` (or `https://your-domain.com/mcp` after adding custom domain)
- Auth: Bearer token (per-user API key)

### 4 MCP Tools

| Tool | Input | Description |
|------|-------|-------------|
| `list_tables` | (none) | Returns only visible tables/collections with row/document counts, **includes `db_type`** (filtered by role). Hidden tables are not listed. |
| `describe_table` | `table_name` | Returns only visible field names, types, and sample values. Hidden fields are not listed. **Includes `db_type`** so agent knows query syntax. |
| `query` | `query` (string) | **DB-type-aware:** Postgres/MySQL = SQL SELECT; MongoDB = JSON aggregation pipeline or find query. Read-only enforced. 10s timeout, max 500 rows/docs. Hidden fields stripped from results. |
| `sample_data` | `table_name`, `limit` | Returns random sample rows/documents (max 20). Hidden fields stripped. |

### Query Format by DB Type

**Postgres / MySQL:**
```json
{ "query": "SELECT id, plan, created_at FROM users WHERE created_at > '2025-01-01'" }
```

**MongoDB:**
```json
{ "query": "{ \"collection\": \"users\", \"operation\": \"find\", \"filter\": { \"created_at\": { \"$gt\": \"2025-01-01\" } }, \"projection\": { \"id\": 1, \"plan\": 1, \"created_at\": 1 } }" }
```

The AI agent learns which format to use from the `db_type` field returned by `list_tables` and `describe_table`.

### Query Validation
- **Postgres/MySQL:** Only SELECT allowed (reject INSERT, UPDATE, DELETE, DROP, ALTER)
- **MongoDB:** Only read operations allowed (find, aggregate, count, distinct — reject insert, update, delete, drop)
- 10 second timeout
- Max 500 rows/documents
- Table/collection access checked against user role
- All queries logged to audit trail

### Middleware Pipeline
1. Extract Bearer token
2. Look up API key → get org, role, permissions
3. Load visibility config for this connection (which fields/tables are visible)
4. Initialize MCP server with filtered tools (only visible tables exposed)
5. On query: validate read-only, check table/collection access, execute against sandbox Docker container
6. On response: **strip hidden fields from results**, log to audit trail

---

## API Endpoints (Next.js API Routes)

### Connections
- `POST /api/connections` — Add new DB connection
- `GET /api/connections` — List org's connections
- `GET /api/connections/:id` — Get connection details
- `DELETE /api/connections/:id` — Remove connection
- `POST /api/connections/:id/test` — Test connection (read-only)
- `POST /api/connections/:id/sync` — Trigger manual sync
- `GET /api/connections/:id/status` — Get sync status
- `PATCH /api/connections/:id/schedule` — Set sync schedule (manual/6h/12h/daily/weekly)

### Schema
- `GET /api/connections/:id/schema` — Full schema tree with sample data from latest row
- `PATCH /api/connections/:id/schema/tables/:tableId` — Toggle table visibility (visible/hidden)
- `PATCH /api/connections/:id/schema/columns/:columnId` — Toggle field visibility (visible/hidden)
- `POST /api/connections/:id/schema/auto-detect` — Run PII auto-detection

### API Keys
- `POST /api/keys` — Create new API key
- `GET /api/keys` — List org's API keys
- `DELETE /api/keys/:id` — Revoke API key
- `PATCH /api/keys/:id` — Update key (role, tables)

### Team
- `POST /api/team/invite` — Send invite email
- `GET /api/team` — List team members
- `PATCH /api/team/:userId` — Update member role
- `DELETE /api/team/:userId` — Remove member

### Audit
- `GET /api/audit` — List audit logs (paginated)
- `GET /api/audit/stats` — Query stats (top users, tables)

### MCP
- `ALL /mcp` — MCP server endpoint (Streamable HTTP)

---

## Pages & UI

### Page Map

**First-run flow (self-hosted — shown once on first visit):**
| Route | Purpose |
|-------|---------|
| `/setup` | First-run setup — create admin account (email + password) |

**Auth:**
| Route | Purpose |
|-------|---------|
| `/login` | Sign in (Clerk for cloud, built-in for self-hosted) |
| `/signup` | Sign up (Clerk for cloud, invite-only for self-hosted) |

**Dashboard (after login):**
| Route | Purpose |
|-------|---------|
| `/dashboard` | Overview (connections, team, recent queries) |
| `/dashboard/connect` | New connection wizard (select DB type, paste URL, configure) |
| `/dashboard/connections/:id` | Connection detail + schema browser |
| `/dashboard/connections/:id/schema` | Schema browser with sample data + visibility toggles |
| `/dashboard/team` | Team management + invites |
| `/dashboard/keys` | API key management |
| `/dashboard/audit` | Audit log viewer |
| `/dashboard/settings` | Org settings, sync schedules |
| `/dashboard/settings/domain` | Custom domain setup (self-hosted: enter domain, auto-SSL via Caddy) |
| `/dashboard/settings/billing` | Billing (cloud only, Stripe) |
| `/dashboard/setup/:keyId` | Personal setup page (MCP connection instructions) |

**Public:**
| Route | Purpose |
|-------|---------|
| `/` | Marketing landing page (cloud) or redirect to `/login` (self-hosted) |
| `/docs` | Public documentation |

### Key UI Components
- **First-Run Setup Page** (self-hosted only) — "Welcome to dbgate" → create admin account → redirects to dashboard.
- **Connection Wizard** — Select DB type → paste connection string → validate → create Docker sandbox → schema browser with sample data and visibility toggles → deploy MCP endpoint
- **Schema Browser** — Table showing each field with its type, **sample value from the latest row** (real data), and a **visible/hidden toggle**. PII fields auto-detected and pre-set to hidden. Sync schedule dropdown. Changes take effect immediately (no re-sync needed).
- **Domain Settings** (self-hosted) — Enter custom domain, auto-SSL via Caddy/Let's Encrypt.
- **Setup Page** — MCP URL + API key + platform-specific instructions (Claude Desktop, ChatGPT, Cursor) with copy buttons.
- **Audit Table** — Log viewer (shows SQL or MongoDB queries depending on connection type)

---

## Auth & Permissions

### Authentication (two modes)

| | Self-Hosted | Cloud (dbgate.dev) |
|---|---|---|
| **Provider** | Built-in (email + password) | Clerk (OAuth with GitHub, Google, email) |
| **First run** | `/setup` page creates admin account | Standard Clerk signup |
| **Team invites** | Email with invite link + password setup | Clerk invite flow |
| **Sessions** | JWT stored in httpOnly cookie | Clerk session |
| **External deps** | None | Clerk |

**Self-hosted auth flow:**
1. First visit to `http://<VPS_IP>` → `/setup` page (only shown if no admin exists)
2. Create admin account (email + password, bcrypt-hashed)
3. Admin can invite team members from dashboard (sends email with setup link)
4. Team members create account via invite link (email + password)
5. Sessions managed via JWT in httpOnly cookies (signed with `JWT_SECRET`)

### Roles
| Role | Schema UI | Invite | Query | Tables |
|------|-----------|--------|-------|--------|
| Owner | Edit | Yes | All visible | All |
| Admin | Edit | Yes | All visible | All |
| Analyst | View only | No | All visible | All |
| Limited | View only | No | Restricted | Subset only |

### API Key Format
```
dbg_sk_{random_32_chars}
```
- Prefix stored in DB for display: `dbg_sk_a1b2...`
- Full key hashed with bcrypt and stored
- Key shown once on creation, never again

---

## Repo Structure (Turborepo monorepo)

```
dbgate/
  apps/web/                 # Next.js 15 dashboard
    app/
      setup/                # First-run admin account creation (self-hosted)
      (auth)/               # Login/signup (adapts to Clerk or built-in)
      dashboard/
        connect/            # Connection wizard
        connections/[id]/   # Connection detail + schema browser
        team/               # Team management
        keys/               # API keys
        audit/              # Audit logs
        settings/
          domain/           # Custom domain setup (self-hosted)
          billing/          # Stripe billing (cloud only)
    lib/
      auth/
        clerk.ts            # Clerk adapter (cloud)
        builtin.ts          # Built-in email/password adapter (self-hosted)
        index.ts            # Auth interface — picks adapter based on env
  packages/
    core/                   # Shared business logic
      src/
        adapters/           # Database adapter pattern
          types.ts          # Common adapter interface
          postgres.ts       # Postgres: pg_dump/pg_restore to Docker container
          mongodb.ts        # MongoDB: mongodump/mongorestore to Docker container
          mysql.ts          # MySQL: mysqldump/restore to Docker container
        sandbox.ts          # Docker container management for sandboxes
        field-filter.ts     # Strips hidden fields from query results
        pii-detect.ts       # PII detection (column name pattern matching)
        query-validator.ts  # Read-only enforcement (SQL + MongoDB)
        encryption.ts       # Connection string encryption
    mcp-server/             # MCP server (the core product)
    a2a-server/             # A2A agent server (post-MVP)
    db/                     # Shared DB schema + Drizzle migrations
  plugins/paperclip/        # Paperclip skill adapter (post-MVP)
  docker/
    docker-compose.yml      # Self-hosted: all services
    Caddyfile               # Reverse proxy config (auto-SSL, custom domains)
    Dockerfile.web          # Dashboard container
    Dockerfile.mcp          # MCP server container
  scripts/
    install.sh              # Remote bash installer (curl | bash)
  doc/                      # Operational and product docs
  examples/                 # Example configs for Claude, ChatGPT, etc.
```

---

## MVP Scope

### Phase 1: Core (Weeks 1-3)
- Project scaffolding (Turborepo, pnpm, packages)
- **Database adapter interface** (common abstraction for all DB types)
- **Postgres adapter** — pg_dump/pg_restore to Docker Postgres container
- **MongoDB adapter** — mongodump/mongorestore to Docker MongoDB container
- **MySQL adapter** — mysqldump/restore to Docker MySQL container
- **Dynamic sandbox container management** — spin up/down Docker containers via Docker API
- **PII auto-detection** (column/field name pattern matching — flags fields as "recommended to hide")
- **Field filter** — strips hidden fields from query results at response time
- MCP server with 4 DB-aware tools (list_tables, describe_table, query, sample_data)
- API key auth for MCP server
- Query validation — read-only enforcement for SQL (SELECT only) and MongoDB (find/aggregate only)
- Connection string encryption

### Phase 2: Dashboard + Installer (Weeks 3-5)
- **Coolify-style bash installer** (`curl -sSL https://get.dbgate.dev | bash`)
- **First-run setup page** (create admin account on first visit)
- **Built-in auth** for self-hosted (email/password, bcrypt + JWT)
- Clerk auth for cloud version
- Connection wizard (select DB type → paste URL → validate → create Docker sandbox)
- **Schema browser with real sample data** and visible/hidden toggles per field and per table
- **Sync schedule configuration** (manual / 6h / 12h / daily / weekly)
- **Domain settings page** (enter custom domain, auto-SSL via Caddy)
- API key management (create, revoke, copy)
- Setup instructions page (Claude, ChatGPT, Cursor configs)
- Team invite flow (email + role)
- Basic audit log viewer

### Phase 3: Polish & Launch (Weeks 5-6)
- Manual sync trigger + sync status indicators
- Landing page
- README for GitHub repo
- Basic rate limiting on MCP server
- Example configs in /examples
- Publish `dbgate` npm package

### Post-MVP Backlog
- Additional DB adapters (Redis, ClickHouse, DynamoDB, etc.)
- Claude Desktop Extension (.mcpb package)
- "Add to Claude" deep link / OAuth flow
- ChatGPT App Directory listing
- Paperclip plugin, Hermes Agent skill
- A2A protocol server
- Row-level filtering ("only last 90 days of orders")
- Query cost estimation
- Dashboard analytics, Stripe billing
- SSO/SAML for enterprise
- Webhook notifications (sync complete, error alerts)

---

## Sync & Refresh

### How Sync Works
1. dbgate connects to prod (read-only)
2. Runs dump tool (pg_dump / mongodump / mysqldump)
3. Restores into the existing sandbox Docker container (replaces old data)
4. MCP server continues serving during sync (queries hit old data until restore completes, then switches)
5. Dashboard shows: last sync time, next scheduled sync, sync status

### Sync Schedule Options
| Schedule | When it runs |
|----------|-------------|
| Manual | Only when CTO clicks "Sync Now" |
| Every 6h | 00:00, 06:00, 12:00, 18:00 UTC |
| Every 12h | 00:00, 12:00 UTC |
| Daily | 00:00 UTC |
| Weekly | Sunday 00:00 UTC |

CTO can change the schedule anytime from the schema browser page or connection settings. Can always trigger a manual sync regardless of schedule.

---

## Open Source vs Cloud

### Open Source (MIT License)
Everything in the repo: core engine, MCP server, A2A server, dashboard UI, Docker self-hosting, plugins.

Self-hosted users just need **a VPS with Docker**. One command installs everything. All sandbox databases, the MCP server, and the dashboard run as Docker containers on the same machine.

### Cloud (dbgate.dev)
Managed version: sandbox provisioning (all DB types), MCP server hosting (per-org), backups, monitoring, uptime.

---

## Self-Hosted Setup (Coolify-Style)

### Philosophy
Like Coolify, Plausible, or Gitea — one command on a VPS, then everything is configured through the web UI. The bash script just installs Docker (if needed) and deploys the platform. All real configuration (databases, field visibility, team, domain) happens in the browser. **Docker is the only dependency. Nothing else is installed on the host.**

### One-Command Install
```bash
curl -sSL https://get.dbgate.dev | bash
```

### The Actual Script (`scripts/install.sh`)

```bash
#!/bin/bash
set -e

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; NC='\033[0m'; BOLD='\033[1m'

INSTALL_DIR="/opt/dbgate"
DBGATE_VERSION="${DBGATE_VERSION:-latest}"

echo -e "\n${CYAN}${BOLD}"
echo "  ┌─────────────────────────────────────┐"
echo "  │   dbgate — Self-Hosted Installer    │"
echo "  └─────────────────────────────────────┘"
echo -e "${NC}"

# ── Check OS ──
OS="$(uname -s)"; ARCH="$(uname -m)"
case "$ARCH" in
  x86_64)  ARCH="amd64" ;; aarch64|arm64) ARCH="arm64" ;;
  *) echo -e "${RED}Unsupported architecture: $ARCH${NC}"; exit 1 ;;
esac
echo -e "${BOLD}Checking system...${NC}"
[ -f /etc/os-release ] && . /etc/os-release && echo -e "  ${GREEN}✓${NC} OS: $PRETTY_NAME ($ARCH)"

# ── Install Docker if needed ──
if command -v docker &> /dev/null; then
  echo -e "  ${GREEN}✓${NC} Docker installed"
else
  echo -e "  ${YELLOW}✗${NC} Docker not found — installing..."
  [ "$OS" = "Darwin" ] && echo -e "  ${RED}Install Docker Desktop: docker.com${NC}" && exit 1
  curl -fsSL https://get.docker.com | sh
  sudo usermod -aG docker "$USER" 2>/dev/null || true
  echo -e "  ${GREEN}✓${NC} Docker installed"
fi
docker compose version &> /dev/null || { echo -e "${RED}Docker Compose required${NC}"; exit 1; }

# ── Setup ──
sudo mkdir -p "$INSTALL_DIR" && sudo chown "$USER":"$USER" "$INSTALL_DIR" 2>/dev/null || true
cd "$INSTALL_DIR"

generate_secret() { openssl rand -hex 32 2>/dev/null || head -c 64 /dev/urandom | od -An -tx1 | tr -d ' \n'; }
ENCRYPTION_KEY=$(generate_secret); DB_PASSWORD=$(generate_secret | head -c 32); JWT_SECRET=$(generate_secret)
PUBLIC_IP=$(curl -4 -sSf https://ifconfig.me 2>/dev/null || curl -4 -sSf https://api.ipify.org 2>/dev/null || echo "localhost")
echo -e "  ${GREEN}✓${NC} Secrets generated\n  ${GREEN}✓${NC} Public IP: $PUBLIC_IP"

# ── Write .env ──
cat > .env <<EOF
ENCRYPTION_KEY=$ENCRYPTION_KEY
JWT_SECRET=$JWT_SECRET
DB_PASSWORD=$DB_PASSWORD
AUTH_MODE=builtin
APP_URL=http://$PUBLIC_IP
DOCKER_SOCKET=/var/run/docker.sock
DBGATE_VERSION=$DBGATE_VERSION
EOF

# ── Write docker-compose.yml ──
cat > docker-compose.yml <<'COMPOSE'
services:
  caddy:
    image: caddy:2-alpine
    restart: unless-stopped
    ports: ["80:80", "443:443"]
    volumes: [./Caddyfile:/etc/caddy/Caddyfile, caddy-data:/data]
    depends_on: [web, mcp-server]
  web:
    image: dbgate/web:${DBGATE_VERSION:-latest}
    restart: unless-stopped
    environment:
      - DATABASE_URL=postgres://dbgate:${DB_PASSWORD}@app-db:5432/dbgate
      - ENCRYPTION_KEY=${ENCRYPTION_KEY}
      - JWT_SECRET=${JWT_SECRET}
      - AUTH_MODE=${AUTH_MODE:-builtin}
      - APP_URL=${APP_URL}
      - MCP_SERVER_URL=http://mcp-server:3100
      - DOCKER_SOCKET=/var/run/docker.sock
    volumes: [/var/run/docker.sock:/var/run/docker.sock]
    depends_on:
      app-db: { condition: service_healthy }
  mcp-server:
    image: dbgate/mcp-server:${DBGATE_VERSION:-latest}
    restart: unless-stopped
    environment:
      - DATABASE_URL=postgres://dbgate:${DB_PASSWORD}@app-db:5432/dbgate
      - ENCRYPTION_KEY=${ENCRYPTION_KEY}
    depends_on:
      app-db: { condition: service_healthy }
  app-db:
    image: postgres:16-alpine
    restart: unless-stopped
    environment: { POSTGRES_DB: dbgate, POSTGRES_USER: dbgate, POSTGRES_PASSWORD: "${DB_PASSWORD}" }
    volumes: [app-db-data:/var/lib/postgresql/data]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U dbgate"]
      interval: 5s
      timeout: 5s
      retries: 5
volumes:
  caddy-data:
  app-db-data:
networks:
  default: { name: dbgate }
COMPOSE

# ── Write Caddyfile ──
cat > Caddyfile <<'CADDY'
:80 {
    handle /mcp* { reverse_proxy mcp-server:3100 }
    handle { reverse_proxy web:3000 }
}
CADDY

# ── Pull and start ──
echo -e "\n${BOLD}Pulling images...${NC}"
docker compose pull
echo -e "\n${BOLD}Starting dbgate...${NC}"
docker compose up -d --wait
echo -e "  ${GREEN}✓${NC} All services started"

echo -e "\n${CYAN}${BOLD}"
echo "  ┌──────────────────────────────────────────────┐"
echo "  │  dbgate is running!                          │"
echo "  │  Open: http://$PUBLIC_IP                     │"
echo "  │  Create your admin account to get started.   │"
echo "  └──────────────────────────────────────────────┘"
echo -e "${NC}"
echo "  Manage: cd $INSTALL_DIR"
echo "    docker compose logs -f     # view logs"
echo "    docker compose down        # stop"
echo "    docker compose pull && docker compose up -d  # update"
```

### What Runs on the VPS
**Only Docker containers. Nothing else.**
```
$ docker ps

CONTAINER ID  IMAGE                      STATUS   PORTS
a1b2c3d4e5f6  caddy:2-alpine            Up       0.0.0.0:80->80, 0.0.0.0:443->443
f6g7h8i9j0k1  dbgate/web:latest         Up       3000/tcp
l2m3n4o5p6q7  dbgate/mcp-server:latest  Up       3100/tcp
x4y5z6a7b8c9  postgres:16-alpine        Up       5432/tcp

# After user connects a MongoDB database via dashboard:
d0e1f2g3h4i5  mongo:7                   Up       27017/tcp  (sandbox)
```

4 containers at install. Sandbox containers appear dynamically when databases are connected.

### Dynamic Sandbox Containers

**Sandbox containers are NOT in docker-compose.yml.** They are created dynamically by the web app when a user connects a database through the dashboard. The web container has access to the Docker socket and manages sandbox lifecycle via the Docker API.

```
User clicks "Connect MongoDB" in dashboard
  → web app validates connection string (read-only test against prod)
  → web app calls Docker API: create container (mongo:7) on dbgate network
  → web app runs mongodump from prod → mongorestore into sandbox container
  → sandbox ready, MCP server can query it
```

---

## Pricing

| | Free (OSS) | Starter ($29/mo) | Team ($99/mo) | Enterprise (Custom) |
|---|---|---|---|---|
| Deployment | Self-hosted | Cloud | Cloud | Self-hosted / VPC |
| Databases | 1 | 1 | 5 | Unlimited |
| Team members | 1 | 3 | 15 | Unlimited |
| API keys | 1 | 3 | 15 | Unlimited |
| Sync | Manual | Manual + daily | Manual + 6h | Custom |
| Roles | No | No | Yes | Yes |
| Audit logs | No | No | Yes | Yes |
| SSO/SAML | No | No | No | Yes |

### Unit Economics (Cloud, typical 5GB startup DB)
- Sandbox container (Docker on Fly.io/Railway): ~$5-8/mo per customer
- MCP server: ~$2-3/mo (Fly.io)
- **Total cost: ~$7-11/mo per customer**
- Starter $29/mo → ~65% margin
- Team $99/mo → ~89% margin

---

## Competitors

| Competitor | Gap | dbgate Advantage |
|---|---|---|
| **Ardent** | CLI-only, no field filtering, no AI integration, hosts user data | Field-level control, MCP native, UI, open source, no data hosting |
| **Google MCP Toolbox** | Connects AI directly to prod, no sandbox/filtering, developer-only | Sandbox + field filtering + UI, non-technical setup |
| **Metabase/Looker** | Weeks to setup, not agent-compatible, needs data team | Works inside AI tools people already use, 5 min setup |
| **Paperclip** | No database access layer | Complementary — dbgate is a skill/plugin for Paperclip agents |
| **Hermes Agent** | No built-in safe database access | Complementary — dbgate is a skill/plugin/MCP server for Hermes |

---

## Integrations (Post-MVP)

- **Paperclip:** Skill + Plugin adapter for AI agent companies
- **Hermes Agent:** MCP server, skill on agentskills.io, Python plugin with `/data` slash command
- **A2A Protocol:** Agent Card for discoverability, NL question → SQL → plain answer pipeline
- **Claude Desktop Extension:** .mcpb package for one-click install
- **ChatGPT App Directory:** Custom MCP app for Business/Enterprise
- **LangChain / LlamaIndex / OpenAI Agents SDK:** Standard MCP, no custom integration needed

---

## Launch Plan

### Pre-launch
1. Build MVP (6 weeks)
2. Dogfood internally
3. 3-5 beta users from Berlin startup network
4. Paperclip integration partnership

### Launch Week
1. Ship GitHub repo with clean README
2. "Show HN: Give AI agents safe access to your database" post
3. Twitter/X thread showing 5-minute setup
4. Product Hunt launch
5. Reddit posts (r/selfhosted, r/ChatGPT, r/ClaudeAI)

### Success Metrics (3 months)
- 500+ GitHub stars
- 50+ self-hosted installs
- 10+ paying cloud customers
- Listed in Claude + ChatGPT app directories

---

## Key Invariants

These must ALWAYS hold true:
1. Production databases are NEVER written to (read-only connections, regardless of DB type)
2. Hidden fields must NEVER appear in any MCP tool response (`list_tables`, `describe_table`, `query`, `sample_data`)
3. Hidden tables must NEVER be listed or queryable via MCP
4. Every MCP query must be logged to the audit trail
5. API keys are hashed with bcrypt, shown once on creation, never again
6. All queries must be validated as read-only before execution (SQL SELECT or MongoDB find/aggregate only)
7. The database adapter interface must be consistent — adding a new DB type should not require changing MCP server or field-filter logic

---

## Appendix A: Environment Variables

```bash
# ── Core (both self-hosted and cloud) ──
DATABASE_URL=postgres://dbgate:pass@app-db:5432/dbgate  # dbgate's own metadata store
ENCRYPTION_KEY=...                       # 256-bit key (auto-generated by installer)
JWT_SECRET=...                           # JWT signing key (auto-generated by installer)

# ── Auth mode ──
AUTH_MODE=builtin                        # "builtin" (self-hosted) or "clerk" (cloud)

# ── Clerk (cloud only) ──
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_...
CLERK_SECRET_KEY=sk_...
CLERK_WEBHOOK_SECRET=whsec_...

# ── MCP Server ──
MCP_SERVER_PORT=3100
MCP_SERVER_HOST=0.0.0.0

# ── Docker (for sandbox management) ──
DOCKER_SOCKET=/var/run/docker.sock       # For dynamic sandbox container creation

# ── Domain (self-hosted, set via dashboard settings) ──
CUSTOM_DOMAIN=                           # e.g., dbgate.mycompany.com (blank = use IP)
APP_URL=http://203.0.113.42              # Auto-detected by installer, updated when domain is set

# ── Stripe (cloud only) ──
STRIPE_SECRET_KEY=sk_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_STARTER_PRICE_ID=price_...
STRIPE_TEAM_PRICE_ID=price_...
```

## Appendix B: PII Detection Patterns

Auto-detection flags fields as "recommended to hide" based on column/field name patterns:

**High confidence** (pre-set to hidden):
- email, e_mail, email_address
- ssn, social_security, sin, tax_id, national_id
- password, passwd, pass_hash, pwd
- credit_card, card_number, cc_num, pan
- phone, mobile, cell, telephone, fax
- address, street, zip, postal, city
- dob, date_of_birth, birth_date, birthday
- ip_address, ip, user_ip, client_ip

**Medium confidence** (pre-set to hidden):
- first_name, last_name, full_name, name, username, display_name
- api_key, secret, token, auth_token, access_token, refresh_token
- bank_account, iban, routing, swift
- passport, license_number, driver_license
- lat, lng, latitude, longitude, location, geo

**Low confidence** (flagged with warning, left visible by default):
- avatar, photo, image, picture (might contain face data)
- bio, about, description (might contain PII in text)
- notes, comments, memo (might contain PII in text)
