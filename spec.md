# askdb — Product Specification

> **One-liner:** Ask your database anything. Data stays protected, team stays in control.

## What It Is

askdb is an **open-source, database-agnostic bridge** between company databases and AI agents (Claude, ChatGPT, Cursor, etc.). It supports **PostgreSQL, MongoDB, and MySQL** from day one.

- **Sandbox isolation** — data is cloned from production into isolated containers. AI never touches prod.
- **Dynamic field filtering** — CTO sees real sample data, toggles fields/tables visible or hidden. Hidden fields are stripped from AI responses at query time. No fake data, no masking engine — just omit what shouldn't be seen.
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
CTO pastes DB URL → askdb clones to sandbox → CTO sees real sample rows
→ CTO toggles which fields/tables to hide → saves config → invites team
→ each member gets MCP URL → pastes into Claude → done
```

**Key principles:**
- **Database-agnostic** — works with Postgres, MongoDB, MySQL (and extensible to more)
- **Two simple policies** — visible (AI sees real data) or hidden (field stripped entirely)
- Zero data on askdb servers (sandbox lives in containers alongside the app)
- Only stores: configs, user accounts, API keys, audit logs
- One MCP server works across all AI platforms
- Non-technical setup (no CLI, no YAML, no SQL required for end users)
- **One-command self-hosted install** — `curl -sSL https://get.askdb.dev | bash`
- **Configurable sync schedule** — manual, every 6h, 12h, daily, or weekly

---

## Target Users

| Tier | Who | Need |
|------|-----|------|
| **Primary** | Startup CTO (5-50 person company) | Connect any database (Postgres, MongoDB, MySQL), give team self-serve data access in 10 minutes |
| **Secondary** | Team members (sales, marketing, ops) | Ask questions in Claude/ChatGPT, zero technical skill required |
| **Tertiary** | Enterprise (future) | Self-hosted, SSO/SAML, audit logs, data stays in VPC |

---

## Architecture (Conceptual)

### Data Flow
```
User's Prod DB ──> dump ──> restore to sandbox container ──> ready
   |                              |
   ├─ Postgres                Sandbox Postgres
   ├─ MongoDB                 Sandbox MongoDB
   └─ MySQL                   Sandbox MySQL
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
- Validate connection
- Dump from production (read-only)
- Restore to sandbox container
- Introspect schema (tables, fields, types)
- Execute read-only queries
- Validate query is read-only
- Refresh sandbox (re-dump/restore)

Adding a new database type means implementing this interface — nothing else changes.

### What We Store vs. Don't Store
- **Store:** User accounts, org settings, visibility configs, API keys (hashed), audit logs, sync schedules
- **Never store:** Database content, query results, connection strings (encrypted at rest, never logged), user's production data

---

## CTO Setup Flow (the core UX)

### Step 1: Connect database
CTO selects DB type, pastes connection string, validates (read-only test).

### Step 2: Sandbox created
askdb spins up a container, runs dump/restore. CTO sees a progress bar.

### Step 3: Schema browser with sample data

**This is the key screen.** CTO sees every table/collection with a sample of the latest row from each, and toggles visibility per field and per table.

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
- Cloud: `https://{org-slug}.askdb.dev/mcp`
- Self-hosted: `http://<VPS_IP>/mcp` (or `https://your-domain.com/mcp` after adding custom domain)
- Auth: Bearer token (per-user API key)

### 4 MCP Tools

| Tool | Input | Description |
|------|-------|-------------|
| `list_tables` | (none) | Returns only visible tables/collections with row/document counts, **includes `db_type`**. Hidden tables are not listed. |
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
{ "query": "{ \"collection\": \"users\", \"operation\": \"find\", \"filter\": { \"created_at\": { \"$gt\": \"2025-01-01\" } } }" }
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
5. On query: validate read-only, check table/collection access, execute against sandbox container
6. On response: **strip hidden fields from results**, log to audit trail

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
| `/login` | Sign in |
| `/signup` | Sign up (invite-only for self-hosted) |

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
| `/dashboard/settings/domain` | Custom domain setup (self-hosted: enter domain, auto-SSL) |
| `/dashboard/settings/billing` | Billing (cloud only) |
| `/dashboard/setup/:keyId` | Personal setup page (MCP connection instructions) |

**Public:**
| Route | Purpose |
|-------|---------|
| `/` | Marketing landing page (cloud) or redirect to `/login` (self-hosted) |
| `/docs` | Public documentation |

### Key UI Components
- **First-Run Setup Page** (self-hosted only) — "Welcome to askdb" → create admin account → redirects to dashboard.
- **Connection Wizard** — Select DB type → paste connection string → validate → create sandbox → schema browser with sample data and visibility toggles → deploy MCP endpoint
- **Schema Browser** — Table showing each field with its type, **sample value from the latest row** (real data), and a **visible/hidden toggle**. PII fields auto-detected and pre-set to hidden. Sync schedule dropdown. Changes take effect immediately (no re-sync needed).
- **Domain Settings** (self-hosted) — Enter custom domain, auto-SSL.
- **Setup Page** — MCP URL + API key + platform-specific instructions (Claude Desktop, ChatGPT, Cursor) with copy buttons.
- **Audit Table** — Log viewer (shows SQL or MongoDB queries depending on connection type)

---

## API Endpoints

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

## Auth & Permissions

### Authentication (two modes)

| | Self-Hosted | Cloud (askdb.dev) |
|---|---|---|
| **First run** | `/setup` page creates admin account | Standard signup |
| **Team invites** | Email with invite link + password setup | Invite flow |
| **Sessions** | JWT in httpOnly cookie | Managed sessions |
| **External deps** | None | Auth provider |

**Self-hosted auth flow:**
1. First visit to `http://<VPS_IP>` → `/setup` page (only shown if no admin exists)
2. Create admin account (email + password, hashed)
3. Admin can invite team members from dashboard (sends email with setup link)
4. Team members create account via invite link (email + password)
5. Sessions managed via JWT in httpOnly cookies

### Roles
| Role | Schema UI | Invite | Query | Tables |
|------|-----------|--------|-------|--------|
| Owner | Edit | Yes | All visible | All |
| Admin | Edit | Yes | All visible | All |
| Analyst | View only | No | All visible | All |
| Limited | View only | No | Restricted | Subset only |

### API Key Format
```
ask_sk_{random_32_chars}
```
- Prefix stored in DB for display: `ask_sk_a1b2...`
- Full key hashed and stored
- Key shown once on creation, never again

---

## Data Model

### Core Tables
- **users** — User accounts (email, hashed password for self-hosted)
- **organizations** — Tenant, has plan tier
- **connections** — Database connections (encrypted), db_type (postgres/mongodb/mysql), sandbox container ID, sync_schedule, last_sync_at
- **schema_tables** — Cached table metadata (name, row count, `is_visible` boolean)
- **schema_columns** — Column metadata with PII auto-detection flag, `is_visible` boolean (visible = AI sees it, hidden = stripped from responses)
- **api_keys** — Per-user keys with role (admin/analyst/limited), allowed_tables restriction, hashed
- **audit_logs** — Every MCP query logged with action, query text, tables accessed, execution time, row count, IP

---

## Self-Hosted Setup

### Philosophy
Like Coolify, Plausible, or Gitea — one command on a VPS, then everything is configured through the web UI. The bash script just installs the platform. All real configuration (databases, field visibility, team, domain) happens in the browser.

### One-Command Install
```bash
curl -sSL https://get.askdb.dev | bash
```

### What the installer does:
1. Checks OS and architecture
2. Installs Docker if not present
3. Generates secrets
4. Detects public IP
5. Pulls and starts all containers
6. Prints the URL to open in browser

### What runs on the VPS
- Reverse proxy (auto-SSL, custom domains)
- Web dashboard
- MCP server
- App database (metadata only)
- Sandbox containers appear dynamically when databases are connected via the dashboard

---

## Sync & Refresh

### How Sync Works
1. askdb connects to prod (read-only)
2. Dumps data using the appropriate tool for the DB type
3. Restores into the existing sandbox container (replaces old data)
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

CTO can change the schedule anytime. Can always trigger a manual sync regardless of schedule.

---

## MVP Scope

### Phase 1: Core
- Project scaffolding (monorepo)
- Database adapter interface (common abstraction for all DB types)
- Postgres adapter (dump/restore to sandbox container)
- MongoDB adapter (dump/restore to sandbox container)
- MySQL adapter (dump/restore to sandbox container)
- Dynamic sandbox container management
- PII auto-detection (field name pattern matching)
- Field filter — strips hidden fields from query results at response time
- MCP server with 4 DB-aware tools (list_tables, describe_table, query, sample_data)
- API key auth for MCP server
- Query validation — read-only enforcement for SQL and MongoDB
- Connection string encryption

### Phase 2: Dashboard + Installer
- Coolify-style bash installer (`curl | bash`)
- First-run setup page (create admin account on first visit)
- Built-in auth for self-hosted (email/password, JWT)
- Connection wizard (select DB type → paste URL → validate → create sandbox)
- Schema browser with real sample data and visible/hidden toggles
- Sync schedule configuration
- Domain settings page (custom domain, auto-SSL)
- API key management (create, revoke, copy)
- Setup instructions page (Claude, ChatGPT, Cursor configs)
- Team invite flow (email + role)
- Basic audit log viewer

### Phase 3: Polish & Launch
- Manual sync trigger + sync status indicators
- Landing page
- README for GitHub repo
- Basic rate limiting on MCP server
- Example configs

### Post-MVP Backlog
- Additional DB adapters (Redis, ClickHouse, DynamoDB, etc.)
- Claude Desktop Extension
- ChatGPT App Directory listing
- A2A protocol server
- Row-level filtering ("only last 90 days of orders")
- Query cost estimation
- Dashboard analytics, billing
- SSO/SAML for enterprise
- Webhook notifications (sync complete, error alerts)

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

---

## Competitors

| Competitor | Gap | askdb Advantage |
|---|---|---|
| **Ardent** | CLI-only, no field filtering, no AI integration, hosts user data | Field-level control, MCP native, UI, open source, no data hosting |
| **Google MCP Toolbox** | Connects AI directly to prod, no sandbox/filtering, developer-only | Sandbox + field filtering + UI, non-technical setup |
| **Metabase/Looker** | Weeks to setup, not agent-compatible, needs data team | Works inside AI tools people already use, 5 min setup |

---

## Key Invariants

These must ALWAYS hold true:
1. Production databases are NEVER written to (read-only connections, regardless of DB type)
2. Hidden fields must NEVER appear in any MCP tool response (`list_tables`, `describe_table`, `query`, `sample_data`)
3. Hidden tables must NEVER be listed or queryable via MCP
4. Every MCP query must be logged to the audit trail
5. API keys are hashed, shown once on creation, never again
6. All queries must be validated as read-only before execution
7. The database adapter interface must be consistent — adding a new DB type should not require changing MCP server or field-filter logic

---

## PII Detection Patterns

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

---

## Launch Plan

### Pre-launch
1. Build MVP
2. Dogfood internally
3. 3-5 beta users from Berlin startup network

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
