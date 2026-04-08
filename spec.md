# askdb — Product Specification (MVP)

> **One-liner:** Ask your database anything. Data stays protected.

## What It Is

askdb is an **open-source, MongoDB-first bridge** between your database and AI agents (Claude, ChatGPT, Cursor, etc.).

- **Sandbox isolation** — data is cloned from production into an isolated Docker container. AI never touches prod.
- **Dynamic field filtering** — see real sample data, toggle fields/collections visible or hidden. Hidden fields are stripped from AI responses at query time. No fake data, no masking — just omit what shouldn't be seen.
- **MCP (Model Context Protocol)** — standard interface for AI agent communication.

It is **NOT** a database, BI tool, dashboard builder, or agent framework. It is the secure bridge between your MongoDB and AI agents.

---

## Problem

Business teams need data answers ("how many users signed up this week?") but currently must wait on engineers to write queries or build APIs. Existing workarounds are all bad:

- Sharing raw DB credentials with AI tools (security risk)
- Exporting CSVs to ChatGPT (stale data, GDPR violations)
- Setting up Metabase/Looker (weeks of work, not agent-compatible)

## Solution

Connect your MongoDB once, configure what data AI agents can see (visible or hidden per field/collection), and get an MCP connection to use in Claude, ChatGPT, or any MCP-compatible tool.

**Core flow:**
```
Paste MongoDB URL → askdb clones to sandbox → see real sample rows
→ toggle which fields/collections to hide → save config
→ get MCP URL → paste into Claude → done
```

**Key principles:**
- **MongoDB-first** (extensible to other DBs via adapter pattern)
- **Two simple policies** — visible (AI sees real data) or hidden (field stripped entirely)
- Zero data on askdb servers (sandbox lives in Docker container alongside the app)
- Only stores: configs, user account, API keys, audit logs
- One MCP server works across all AI platforms
- Non-technical setup (no CLI, no YAML, no MongoDB queries required)
- **One-command self-hosted install** — `curl -sSL https://get.askdb.dev | bash`
- **Single-user** — one admin, no team management (multi-user is post-MVP)

---

## Target Users

| Tier | Who | Need |
|------|-----|------|
| **Primary** | Startup CTO / technical founder | Connect MongoDB, give self (and later team) self-serve data access in 10 minutes |
| **Secondary** | Solo developer with a side project | Ask questions about their data in Claude/ChatGPT |
| **Tertiary** | Enterprise (future) | Self-hosted, SSO/SAML, audit logs, data stays in VPC |

---

## Architecture

### System Diagram
```
┌─────────────────────────────────────────────────┐
│                   VPS (Docker)                    │
│                                                   │
│  ┌──────────────┐       ┌───────────────┐        │
│  │  Next.js App │──────▶│  App Database │        │
│  │  (Dashboard  │       │  (SQLite)     │        │
│  │   + API      │       └───────────────┘        │
│  │   + MCP)     │                                │
│  └──────┬───────┘                                │
│         │                                        │
│   ┌─────▼────────┐                               │
│   │  Sandbox     │◀ ─ ─ mongodump/mongorestore   │
│   │  MongoDB     │      from user's prod         │
│   │  Container   │                               │
│   │  (volume)    │                               │
│   └──────────────┘                               │
└─────────────────────────────────────────────────┘
          ▲
          │ MCP (Streamable HTTP)
    ┌─────┴─────┐
    │  Claude /  │
    │  ChatGPT / │
    │  Cursor    │
    └───────────┘
```

**Key decisions:**
- **Monolith** — Next.js serves dashboard, API, and MCP endpoint. Single process, no reverse proxy.
- **SQLite** — app database. File-based, zero config, perfect for single-user self-hosted. Prisma ORM.
- **Docker volumes** — sandbox MongoDB data persists across container restarts/crashes.
- **Dynamic container** — sandbox MongoDB is created by the app via `dockerode` when user connects a database, not pre-defined in docker-compose.

### Data Flow
```
User's Prod MongoDB ──▶ mongodump ──▶ mongorestore to sandbox container ──▶ ready
                                              │
                                        MCP Server ──▶ strips hidden fields at query time
                                              │
                                  Claude / ChatGPT / Cursor
```

**No masking step. No fake data.** Sandbox is a clean copy of prod. The MCP server applies the visibility config when returning results — hidden fields are simply omitted from responses.

### How Field Filtering Works (query time)

```
1. AI agent sends query (find/aggregate) via MCP
2. MCP server validates: read-only? collection visible?
3. MCP server executes against sandbox → gets full documents with ALL fields
4. MCP server loads visibility config for this connection
5. Hidden fields are stripped from results
6. Only visible fields returned to AI agent
7. Query + result metadata logged to audit trail
```

The AI never knows hidden fields exist. `list_tables` doesn't list hidden collections. `describe_table` doesn't list hidden fields. `query` results don't include them. `sample_data` omits them.

**When all fields in a collection are hidden, the collection is hidden from `list_tables` entirely.** The AI has no way to know it exists.

### Database Adapter Pattern

Each supported database implements a common interface:
- Validate connection
- Dump from production (read-only)
- Restore to sandbox container
- Introspect schema (collections, fields, types)
- Execute read-only queries
- Validate query is read-only
- Refresh sandbox (re-dump/restore)

Only MongoDB is implemented for MVP. Adding a new database type means implementing this interface — nothing else changes.

### What We Store vs. Don't Store
- **Store:** User account, connection configs, visibility configs, API keys (hashed), audit logs
- **Never store:** Database content, query results, connection strings in plaintext (encrypted at rest via app secret), user's production data

---

## Setup Flow (the core UX)

### Step 1: First run
First visit → `/setup` page → create admin account (email + password).

### Step 2: Connect MongoDB
Paste connection string → validate (read-only test) → check database size (warn >5GB, reject >20GB).

### Step 3: Sandbox created
App spins up sandbox MongoDB container via Docker API, runs mongodump/mongorestore. Progress indicator shown.

### Step 4: Schema browser with sample data

**This is the key screen.** User sees every collection with a sample of the latest document, and toggles visibility per field and per collection.

**Key UX details:**
- User sees **real data** from the latest document — they need to see actual values to decide what to hide
- PII fields are auto-detected and **pre-unchecked** (hidden by default). User can override.
- Internal collections (`system.*`, `_migrations`) are auto-hidden
- Each collection has a master toggle to hide the entire collection
- Config is saved to SQLite. Takes effect immediately for all MCP queries.
- **Changing a toggle doesn't require re-sync** — it's applied at query time

### Step 5: MCP URL ready
Connection instructions with copy buttons for Claude Desktop, ChatGPT, Cursor.

---

## MCP Server Spec

### Endpoint
- `http://<VPS_IP>:3000/mcp`
- Auth: Bearer token (API key)

### 4 MCP Tools

| Tool | Input | Description |
|------|-------|-------------|
| `list_tables` | (none) | Returns only visible collections with document counts. Hidden collections not listed. Collections with all fields hidden are excluded. |
| `describe_table` | `table_name` | Returns only visible field names, types, and sample values. Hidden fields not listed. |
| `query` | `query` (string) | MongoDB JSON query — find or aggregation pipeline. Read-only enforced. 10s timeout, max 500 docs. Hidden fields stripped from results. |
| `sample_data` | `table_name`, `limit` | Returns random sample documents (max 20). Hidden fields stripped. |

### Query Format

```json
{ "query": "{ \"collection\": \"users\", \"operation\": \"find\", \"filter\": { \"created_at\": { \"$gt\": \"2025-01-01\" } } }" }
```

### Query Validation
- **Allowlist only:** `find`, `aggregate`, `count`, `distinct`
- **Reject everything else:** insert, update, delete, drop, createIndex, etc.
- **Aggregation pipeline security:** Reject `$merge`, `$out`, `$collStats`, `$currentOp`, `$listSessions`. Reject `$lookup` if it references a hidden collection.
- 10 second timeout
- Max 500 documents
- Collection access checked against visibility config
- All queries logged to audit trail

### Middleware Pipeline
1. Extract Bearer token
2. Look up API key → validate
3. Load visibility config (which fields/collections are visible)
4. On query: validate read-only (allowlist), check collection access, execute against sandbox
5. On response: strip hidden fields from results, log to audit trail

---

## Pages & UI

### Tech Stack
- Next.js (App Router) + TypeScript
- shadcn/ui (with `shadcn apply` for design presets)
- Prisma + SQLite

### Page Map

| Route | Purpose |
|-------|---------|
| `/setup` | First-run: create admin account (shown once, only if no admin exists) |
| `/login` | Sign in |
| `/dashboard` | Overview (connections, recent queries) |
| `/dashboard/connect` | Connect MongoDB wizard |
| `/dashboard/connections/:id/schema` | Schema browser with sample data + visibility toggles |
| `/dashboard/keys` | API key management |
| `/dashboard/audit` | Audit log viewer |
| `/dashboard/setup/:keyId` | MCP connection instructions (copy buttons for Claude, ChatGPT, Cursor) |

### Key UI Components
- **First-Run Setup Page** — "Welcome to askdb" → create admin account → redirect to dashboard
- **Connection Wizard** — Paste MongoDB URL → validate → size check → create sandbox → schema browser
- **Schema Browser** — Table showing each field with type, sample value from latest document, and visible/hidden toggle. PII fields auto-detected and pre-set to hidden. Changes take effect immediately.
- **Setup Page** — MCP URL + API key + platform-specific instructions with copy buttons
- **Audit Table** — Log viewer (query, timestamp, execution time, rows returned)
- **Container Health** — Green/red indicator showing sandbox MongoDB is alive

---

## API Endpoints

### Connections
- `POST /api/connections` — Add new MongoDB connection
- `GET /api/connections` — List connections
- `GET /api/connections/:id` — Get connection details
- `DELETE /api/connections/:id` — Remove connection + destroy sandbox container
- `POST /api/connections/:id/test` — Test connection (read-only)
- `POST /api/connections/:id/sync` — Trigger manual sync
- `GET /api/connections/:id/status` — Get sync/container status

### Schema
- `GET /api/connections/:id/schema` — Full schema tree with sample data
- `PATCH /api/connections/:id/schema/tables/:tableId` — Toggle collection visibility
- `PATCH /api/connections/:id/schema/columns/:columnId` — Toggle field visibility
- `POST /api/connections/:id/schema/auto-detect` — Run PII auto-detection

### API Keys
- `POST /api/keys` — Create new API key
- `GET /api/keys` — List API keys
- `DELETE /api/keys/:id` — Revoke API key

### Audit
- `GET /api/audit` — List audit logs (paginated)

### MCP
- `ALL /mcp` — MCP server endpoint (Streamable HTTP)

---

## Auth

### Single-user self-hosted auth
1. First visit → `/setup` page (only shown if no admin exists)
2. Create admin account (email + password, bcrypt hashed)
3. Sessions via JWT in httpOnly cookies
4. No team, no roles, no invites (post-MVP)

### API Key Format
```
ask_sk_{random_32_chars}
```
- Prefix stored in DB for display: `ask_sk_a1b2...`
- Full key hashed (SHA-256) and stored
- Key shown once on creation, never again

---

## Data Model

### Tables (SQLite via Prisma)

- **users** — Single admin account (email, bcrypt hashed password)
- **connections** — MongoDB connections (encrypted connection string, sandbox container ID, last_sync_at, sync_status)
- **schema_tables** — Cached collection metadata (name, document count, `is_visible` boolean)
- **schema_columns** — Field metadata with PII auto-detection flag, `is_visible` boolean
- **api_keys** — API keys with hashed value, prefix for display, created_at
- **audit_logs** — Every MCP query: action, query text, collection accessed, execution time, document count, timestamp

---

## Self-Hosted Setup

### One-Command Install
```bash
curl -sSL https://get.askdb.dev | bash
```

### What the installer does:
1. Checks OS (Linux) and architecture
2. Installs Docker if not present
3. Generates secrets (JWT signing key, encryption key) → `.env`
4. Pulls app Docker image
5. Starts container via `docker compose up -d`
6. Prints: `Open http://<detected-IP>:3000`

### Docker Compose
```yaml
services:
  app:
    image: askdb/askdb:latest
    ports: ["3000:3000"]
    volumes:
      - ./data:/app/data                              # SQLite DB
      - /var/run/docker.sock:/var/run/docker.sock      # manage sandbox containers
    env_file: .env
```

Sandbox MongoDB container is created dynamically by the app (not in compose). Uses Docker named volumes for data persistence.

### Sync (Manual Only)
1. User clicks "Sync Now" on dashboard
2. App connects to prod MongoDB (read-only)
3. Runs `mongodump` → streams to disk
4. Runs `mongorestore` into sandbox container (replaces old data)
5. MCP server continues serving old data until restore completes, then switches
6. Dashboard shows: last sync time, sync status, any error

---

## Security

### Invariants (must ALWAYS hold)
1. Production MongoDB is NEVER written to (read-only connections)
2. Hidden fields must NEVER appear in any MCP tool response
3. Hidden collections must NEVER be listed or queryable via MCP
4. Collections with all fields hidden must NOT appear in `list_tables`
5. Every MCP query must be logged to audit trail
6. API keys are hashed, shown once on creation, never again
7. All queries validated as read-only before execution (allowlist: find, aggregate, count, distinct)
8. Connection strings encrypted at rest, never in logs/errors/responses

### MongoDB-specific security
- **Aggregation pipeline:** Reject `$merge`, `$out`, `$collStats`, `$currentOp`, `$listSessions`
- **$lookup:** Reject if referencing a hidden collection
- **Write operations:** Strict allowlist — only `find`, `aggregate`, `count`, `distinct` permitted
- **Query parsing:** Parse JSON pipeline before execution, reject on any disallowed stage

### Connection string handling
- Encrypted at rest in SQLite using app secret (from `.env`)
- Never logged, never returned in API responses
- Only decrypted in memory when connecting to prod for sync

---

## PII Detection Patterns

Auto-detection flags fields as "recommended to hide" based on field name patterns:

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

## MVP Scope

### Phase 1: Core Engine
- Project scaffolding (Next.js + shadcn + Prisma + SQLite)
- Database adapter interface
- MongoDB adapter (dump/restore via mongodump/mongorestore)
- Dynamic sandbox container management (dockerode + volumes)
- Schema introspection
- PII auto-detection (field name pattern matching)
- Field filter — strips hidden fields at query time
- MCP server with 4 tools (list_tables, describe_table, query, sample_data)
- API key auth for MCP
- MongoDB query validation (read-only allowlist + pipeline security)
- Connection string encryption

### Phase 2: Dashboard
- `curl | bash` installer
- First-run setup page (create admin account)
- Auth (email/password, JWT)
- Connection wizard (paste MongoDB URL → validate → size check → sandbox)
- Schema browser with real sample data and visible/hidden toggles
- API key management (create, revoke, copy)
- MCP setup instructions page (Claude, ChatGPT, Cursor)
- Audit log viewer
- Sandbox health indicator
- Manual sync trigger + status

### Phase 3: Polish & Launch
- README for GitHub repo
- Basic rate limiting on MCP
- Error handling polish
- Example configs

### Post-MVP Backlog
- Postgres adapter
- MySQL adapter
- Multi-user / team management / roles
- Sync schedules (6h, 12h, daily, weekly)
- Cloud hosted version (askdb.dev)
- Custom domain + auto-SSL
- Row-level filtering
- Query cost estimation
- SSO/SAML for enterprise
- Landing page + billing

---

## Launch Plan

### Pre-launch
1. Build MVP
2. Dogfood internally
3. 3-5 beta users from Berlin startup network

### Launch Week
1. Ship GitHub repo with clean README
2. "Show HN: Give AI agents safe access to your MongoDB" post
3. Twitter/X thread showing 5-minute setup
4. Product Hunt launch
5. Reddit posts (r/selfhosted, r/ChatGPT, r/ClaudeAI)

### Success Metrics (3 months)
- 500+ GitHub stars
- 50+ self-hosted installs
- Listed in Claude + ChatGPT app directories
