<p align="center">
  <h1 align="center">askdb</h1>
  <p align="center">Ask your database anything. Data stays protected.</p>
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> &bull;
  <a href="#how-it-works">How It Works</a> &bull;
  <a href="#features">Features</a> &bull;
  <a href="#mcp-tools">MCP Tools</a> &bull;
  <a href="#self-hosting">Self-Hosting</a> &bull;
  <a href="#development">Development</a>
</p>

---

askdb is an open-source, self-hosted bridge between your MongoDB and AI agents (Claude, ChatGPT, Cursor). It clones your production data into a sandboxed container, lets you control exactly which fields AI can see, and exposes a standard [MCP](https://modelcontextprotocol.io) endpoint.

- **Sandbox isolation** &mdash; AI never touches your production database
- **Field-level control** &mdash; toggle any field or collection visible/hidden
- **Works everywhere** &mdash; one MCP endpoint for Claude, ChatGPT, Cursor, and any MCP-compatible tool
- **One-command install** &mdash; `curl | bash` on any VPS, done in minutes

## Quick Start

### One-command install (Linux / macOS)

```bash
curl -sSL https://get.askdb.dev | bash
```

This installs Docker (if needed), generates secrets, and starts askdb. Open the printed URL to create your admin account.

### Or with Docker Compose

```bash
git clone https://github.com/your-org/askdb.git
cd askdb

# Generate secrets
cp .env.example .env
# Edit .env and set BETTER_AUTH_SECRET and ENCRYPTION_KEY to random 64-char hex strings

# Start
docker compose up -d
```

Open `http://localhost:3000` to get started.

## How It Works

```
┌─────────────────────────────────────────────────┐
│                   Your Server                     │
│                                                   │
│  ┌──────────────┐       ┌───────────────┐        │
│  │  Dashboard    │──────>│  SQLite       │        │
│  │  :3000       │       │  (config only) │        │
│  └──────────────┘       └───────────────┘        │
│                                                   │
│  ┌──────────────┐       ┌───────────────┐        │
│  │  MCP Server  │──────>│  Sandbox      │        │
│  │  :3001       │       │  MongoDB      │<── mongodump from prod
│  └──────────────┘       └───────────────┘        │
└─────────────────────────────────────────────────┘
         ^
         | MCP (Streamable HTTP)
   Claude / ChatGPT / Cursor
```

1. **Connect** &mdash; paste your MongoDB connection string
2. **Clone** &mdash; askdb runs `mongodump` / `mongorestore` into an isolated container
3. **Configure** &mdash; browse your schema with real sample data, toggle fields visible or hidden
4. **Query** &mdash; give your AI agent the MCP URL, it queries the sandbox with hidden fields stripped

No data masking, no fake data. Hidden fields are simply omitted from every response.

## Features

| Feature | Description |
|---------|-------------|
| **Sandbox isolation** | Production data cloned into a Docker container. AI reads the copy, never the original. |
| **Field-level visibility** | Toggle any field or collection. Hidden fields are stripped from all MCP responses. |
| **PII auto-detection** | Fields like `email`, `password`, `ssn`, `phone` are auto-detected and pre-hidden. |
| **4 MCP tools** | `list_tables`, `describe_table`, `query`, `sample_data` &mdash; all respect visibility config. |
| **Query validation** | Allowlist-only: `find`, `aggregate`, `count`, `distinct`. Write operations rejected. |
| **Pipeline security** | Rejects `$merge`, `$out`, `$lookup` on hidden collections, and other dangerous stages. |
| **Audit logging** | Every MCP query logged with timestamp, execution time, and document count. |
| **API key auth** | Bearer token authentication. Keys shown once, stored hashed. |
| **Manual sync** | Re-sync from production with one click. Schema changes detected automatically. |
| **Self-hosted** | Your server, your data. Nothing leaves your infrastructure. |

## MCP Tools

The MCP server exposes 4 tools that AI agents can call:

### `list_tables`

Returns all visible collections with document counts. Hidden collections and collections with all fields hidden are excluded.

### `describe_table`

Returns visible fields for a collection: name, BSON type, and a sample value. Hidden fields are not listed.

### `query`

Executes a read-only MongoDB query against the sandbox. Supports `find` and `aggregate` operations.

```json
{
  "collection": "users",
  "operation": "find",
  "filter": { "plan": "pro" },
  "limit": 10
}
```

Hidden fields are stripped from results. 10-second timeout, max 500 documents.

### `sample_data`

Returns random documents from a collection (max 20). Hidden fields stripped.

## Connecting Your AI Agent

After setup, go to **Dashboard > API Keys > Create Key**, then **Dashboard > Setup** for copy-paste configs:

### Claude Desktop

Add to `~/.claude/mcp_servers.json`:

```json
{
  "askdb": {
    "type": "streamable-http",
    "url": "http://YOUR_SERVER:3001/mcp",
    "headers": {
      "Authorization": "Bearer ask_sk_YOUR_KEY_HERE"
    }
  }
}
```

### Cursor

Add to MCP settings:

```json
{
  "mcpServers": {
    "askdb": {
      "url": "http://YOUR_SERVER:3001/mcp",
      "headers": {
        "Authorization": "Bearer ask_sk_YOUR_KEY_HERE"
      }
    }
  }
}
```

## Self-Hosting

### Requirements

- Linux or macOS
- Docker + Docker Compose
- A MongoDB you want to connect (read-only access is sufficient)

### Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `BETTER_AUTH_SECRET` | 64-char hex string for session signing | Yes |
| `BETTER_AUTH_URL` | Public URL of your instance (e.g. `http://your-ip:3000`) | Yes |
| `ENCRYPTION_KEY` | 64-char hex string for encrypting connection strings at rest | Yes |
| `DATABASE_PATH` | Path to SQLite database file (default: `./data/askdb.db`) | No |
| `MCP_PORT` | MCP server port (default: `3001`) | No |

### Ports

| Port | Service |
|------|---------|
| 3000 | Dashboard + API (Next.js) |
| 3001 | MCP server (Express) |
| 27100-27199 | Sandbox MongoDB containers (allocated dynamically) |

### Data Storage

- **SQLite** (`./data/askdb.db`) &mdash; stores user account, configs, API keys, audit logs. No database content is stored here.
- **Docker volumes** &mdash; sandbox MongoDB data persists across container restarts.
- **Connection strings** &mdash; encrypted at rest (AES-256-GCM), never logged.

## Development

### Prerequisites

- Node.js 22+
- pnpm
- Docker (for sandbox containers)
- A MongoDB instance to test with

### Setup

```bash
git clone https://github.com/your-org/askdb.git
cd askdb

pnpm install

cp .env.example .env
# Edit .env with your values

# Push database schema
pnpm db:push

# Start the dashboard (port 3000)
pnpm dev

# In another terminal, start the MCP server (port 3001)
pnpm dev:mcp
```

### Project Structure

```
src/
  app/                  # Next.js App Router
    (auth)/             # Login + setup pages
    (dashboard)/        # Dashboard pages
    api/                # API routes
  lib/
    adapters/           # Database adapter interface + MongoDB implementation
    auth/               # Session helpers, API key generation
    crypto/             # Connection string encryption (AES-256-GCM)
    db/                 # Drizzle ORM schema + client
    docker/             # Sandbox container management (dockerode)
    pii/                # PII auto-detection patterns
  mcp/
    server.ts           # Standalone MCP server (Express)
  components/           # shadcn/ui components
docker/
  Dockerfile            # Multi-stage production build
  start.sh              # Runs both Next.js + MCP server
scripts/
  install.sh            # One-command installer
```

### Scripts

| Command | Description |
|---------|-------------|
| `pnpm dev` | Start Next.js dev server (port 3000) |
| `pnpm dev:mcp` | Start MCP server in dev mode (port 3001) |
| `pnpm build` | Production build |
| `pnpm start` | Start Next.js production server |
| `pnpm start:mcp` | Start MCP server in production |
| `pnpm db:push` | Apply schema changes to SQLite |
| `pnpm db:studio` | Open Drizzle Studio (database browser) |

### Tech Stack

- [Next.js](https://nextjs.org) 16 &mdash; Dashboard + API
- [Drizzle ORM](https://orm.drizzle.team) &mdash; Database (SQLite)
- [Better Auth](https://better-auth.com) &mdash; Authentication
- [shadcn/ui](https://ui.shadcn.com) &mdash; UI components
- [MCP SDK](https://github.com/modelcontextprotocol/sdk) &mdash; AI agent protocol
- [dockerode](https://github.com/apocas/dockerode) &mdash; Container management
- [Express](https://expressjs.com) &mdash; MCP HTTP server

## Security

askdb is designed with these invariants:

1. **Production databases are never written to** &mdash; read-only connections only
2. **Hidden fields never appear in MCP responses** &mdash; stripped from `list_tables`, `describe_table`, `query`, and `sample_data`
3. **Hidden collections are never listed or queryable**
4. **All queries are validated** &mdash; only `find`, `aggregate`, `count`, `distinct` allowed
5. **Dangerous aggregation stages are blocked** &mdash; `$merge`, `$out`, `$collStats`, `$currentOp`, `$listSessions`
6. **Connection strings are encrypted at rest** (AES-256-GCM) and never logged
7. **API keys are hashed** (SHA-256), shown once on creation, never stored in plaintext
8. **Every MCP query is logged** to the audit trail

## Roadmap

- [ ] PostgreSQL adapter
- [ ] MySQL adapter
- [ ] Multi-user / team management
- [ ] Sync schedules (6h, 12h, daily, weekly)
- [ ] Cloud hosted version
- [ ] Row-level filtering
- [ ] SSO/SAML

## License

MIT
