<p align="center">
  <img src="doc/assets/header.png" alt="askdb — ask your database anything" width="720" />
</p>

<p align="center">
  <a href="#quickstart"><strong>Quickstart</strong></a> &middot;
  <a href="#how-it-works"><strong>How It Works</strong></a> &middot;
  <a href="https://github.com/expatal/askdb"><strong>GitHub</strong></a> &middot;
  <a href="https://discord.gg/askdb"><strong>Discord</strong></a>
</p>

<p align="center">
  <a href="https://github.com/expatal/askdb/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT License" /></a>
  <a href="https://github.com/expatal/askdb/stargazers"><img src="https://img.shields.io/github/stars/expatal/askdb?style=flat" alt="Stars" /></a>
  <a href="https://discord.gg/askdb"><img src="https://img.shields.io/discord/000000000?label=discord" alt="Discord" /></a>
</p>

<br/>

## What is askdb?

# Give AI agents safe access to your database

**Your database, sandboxed. Your fields, controlled. One MCP endpoint for every AI tool.**

askdb is a self-hosted bridge between your MongoDB and AI agents. It clones your production data into an isolated sandbox, lets you control exactly which fields AI can see, and exposes a standard [MCP](https://modelcontextprotocol.io) endpoint that works with Claude, ChatGPT, Cursor, and anything else.

No data masking. No fake data. Hidden fields are simply omitted from every response.

**Ask questions about your data, not your engineer's calendar.**

|        | Step            | Example                                                            |
| ------ | --------------- | ------------------------------------------------------------------ |
| **01** | Connect         | Paste your MongoDB URL                                             |
| **02** | Configure       | See real sample data, toggle which fields AI can see               |
| **03** | Query           | Give your AI agent the MCP URL. Done.                              |

<br/>

<div align="center">
<table>
  <tr>
    <td align="center"><strong>Works<br/>with</strong></td>
    <td align="center"><strong>Claude</strong><br/><sub>Desktop & Code</sub></td>
    <td align="center"><strong>ChatGPT</strong><br/><sub>MCP Plugin</sub></td>
    <td align="center"><strong>Cursor</strong><br/><sub>IDE</sub></td>
    <td align="center"><strong>Any MCP</strong><br/><sub>Client</sub></td>
  </tr>
</table>

<em>If it speaks MCP, it works with askdb.</em>

</div>

<br/>

## askdb is right for you if

- You need **business answers from your database** without writing queries
- You want AI agents to **query real data**, not stale CSV exports
- You refuse to **share raw database credentials** with AI tools
- You need **field-level control** over what AI can see (GDPR, PII, compliance)
- You want **one MCP endpoint** that works across Claude, ChatGPT, and Cursor
- You want **audit logs** for every AI query against your data
- You want to **self-host** everything — your server, your data, your rules

<br/>

## Features

<table>
<tr>
<td align="center" width="33%">
<h3>Sandbox Isolation</h3>
Production data cloned into a Docker container. AI reads the copy, never the original.
</td>
<td align="center" width="33%">
<h3>Field-Level Control</h3>
Toggle any field or collection visible/hidden. Changes take effect immediately &mdash; no re-sync needed.
</td>
<td align="center" width="33%">
<h3>PII Auto-Detection</h3>
Fields like <code>email</code>, <code>password</code>, <code>ssn</code>, <code>phone</code> are detected and pre-hidden automatically.
</td>
</tr>
<tr>
<td align="center">
<h3>MongoDB-Style MCP</h3>
Resources plus tools like <code>list-collections</code>, <code>collection-schema</code>, <code>find</code>, <code>aggregate</code>, <code>count</code>, <code>distinct</code>, <code>sample-documents</code>, <code>execute-typescript</code>, and <code>save-insight</code>.
</td>
<td align="center">
<h3>Query Validation</h3>
Allowlist-only: <code>find</code>, <code>aggregate</code>, <code>count</code>, <code>distinct</code>. Write operations rejected. Dangerous pipeline stages blocked.
</td>
<td align="center">
<h3>Audit Trail</h3>
Every MCP query logged with timestamp, execution time, collection, and document count.
</td>
</tr>
<tr>
<td align="center">
<h3>API Key Auth</h3>
Bearer token authentication. Keys shown once on creation, stored hashed (SHA-256). Revoke anytime.
</td>
<td align="center">
<h3>Agent Memory</h3>
Common query patterns are tracked automatically. Agents learn your database over time.
</td>
<td align="center">
<h3>Schema Cache</h3>
Full schema summary with field types, relationships, and descriptions &mdash; agents understand your data without querying every time.
</td>
</tr>
</table>

<br/>

## Code Mode

The `execute-typescript` MCP tool lets the AI write a small TypeScript program that composes multiple Mongo queries inside a sandboxed [QuickJS](https://bellard.org/quickjs/) WebAssembly isolate. One round trip in, one structured result out &mdash; instead of N+1 separate tool calls.

Why it matters:

- **Math is correct.** Sums, averages, percentages run as actual JavaScript inside the sandbox. The model decides what to compute; the sandbox computes it.
- **Token cost drops.** A query that touches 500 documents lives and dies inside the isolate. Only the final result crosses the wire to the model.
- **Security is unchanged.** Every `external_*` call inside the sandbox routes through the same `executeQueryOperation` that the direct `find`/`aggregate`/`count`/`distinct` tools use. Hidden fields are stripped before data crosses into the sandbox. The isolate has no `fs`, no `process`, no `require`, no `fetch`, no globals at all beyond the four bridge functions.

Example program the model writes:

```ts
const top = await external_find({ collection: "products", limit: 5 });
const ratings = await Promise.all(
  top.map((p) =>
    external_find({ collection: "ratings", filter: { productId: p._id } })
  )
);
return top.map((p, i) => ({
  name: p.name,
  avgRating: ratings[i].reduce((s, r) => s + r.score, 0) / ratings[i].length,
}));
```

Limits per execution: 30s wall-clock timeout, 128MB memory, 50 bridge calls, 256KB serialized result. Disable the tool entirely by adding `execute-typescript` to `ASKDB_MCP_DISABLED_TOOLS`.

<br/>

## Problems askdb solves

| Without askdb | With askdb |
|---|---|
| You share raw MongoDB credentials with AI tools and hope nothing gets written. | Sandbox isolation. AI queries a read-only copy. Production is never touched. |
| You export CSVs to ChatGPT. Data is stale within hours, and you just violated GDPR. | Real-time queries against live sandbox data. Fields with PII are auto-hidden. |
| You set up Metabase/Looker for weeks, and your AI agent still can't use it. | One MCP endpoint. Works with Claude, ChatGPT, Cursor in minutes. |
| Business team asks "how many pro users signed up this week?" and waits for an engineer. | They ask the AI agent directly. It queries askdb. Answer in seconds. |
| You have no idea what your AI agent queried or when. | Full audit trail. Every query, every timestamp, every result count. |
| You want AI to see `orders` but not `email` or `credit_card` inside orders. | Field-level toggles. Hide specific fields, not entire collections. |

<br/>

## How It Works

```
Your Prod MongoDB ──> mongodump ──> Sandbox Container
                                         │
                                    MCP Server ──> strips hidden fields
                                         │
                                  Claude / ChatGPT / Cursor
```

```
┌─────────────────────────────────────────────────┐
│                   Your Server                     │
│                                                   │
│  ┌──────────────┐       ┌───────────────┐        │
│  │  Dashboard    │──────>│  SQLite       │        │
│  │  + API        │       │  (config only) │        │
│  └──────────────┘       └───────────────┘        │
│                                                   │
│  ┌──────────────┐       ┌───────────────┐        │
│  │  MCP Server  │──────>│  Sandbox      │        │
│  │  :3001       │       │  MongoDB      │<── clone from prod
│  └──────────────┘       └───────────────┘        │
└─────────────────────────────────────────────────┘
         ^
         | MCP (Streamable HTTP)
   Claude / ChatGPT / Cursor
```

1. **Connect** &mdash; paste your MongoDB connection string
2. **Clone** &mdash; askdb runs `mongodump`/`mongorestore` into an isolated Docker container
3. **Configure** &mdash; browse your schema with real sample data, toggle fields visible or hidden
4. **Query** &mdash; give your AI agent the MCP URL &mdash; hidden fields are stripped from every response

The AI never knows hidden fields exist. Hidden collections are excluded from metadata tools and hidden fields are stripped from resources and query results.

<br/>

## What askdb is not

|                              |                                                                                                |
| ---------------------------- | ---------------------------------------------------------------------------------------------- |
| **Not a database.**          | askdb stores configs and audit logs. Your data stays in MongoDB.                               |
| **Not a BI tool.**           | No dashboards, no charts. askdb gives AI agents structured access to your data.                |
| **Not an agent framework.**  | We don't build agents. We give them safe, controlled access to your database.                  |
| **Not a data masking tool.** | No fake data, no tokenization. Hidden fields are simply omitted from responses.                |
| **Not multi-tenant.**        | Single-user, self-hosted. Multi-user and teams are on the roadmap.                             |

<br/>

## Quickstart

Open source. Self-hosted. No askdb account required.

### Local (recommended for trying it out)

```bash
npx askdb onboard --yes
```

Checks prerequisites, generates secrets, installs dependencies, and starts askdb. Open `http://localhost:3100` to create your admin account.

> **Requirements:** Node.js 20+, pnpm 9+, Docker

### VPS (self-hosted production)

```bash
curl -sSL https://get.askdb.dev | bash
```

Installs Docker (if needed), generates secrets, and starts askdb via Docker Compose.

### Manual

```bash
git clone https://github.com/expatal/askdb.git
cd askdb
pnpm install
pnpm dev
```

This starts the API server + dashboard at `http://localhost:3100` with Vite hot reload.

<br/>

## Connecting Your AI Agent

After setup, create an API key in the dashboard, then add to your AI tool:

### Claude Desktop / Claude Code

Add to MCP config:

```json
{
  "askdb": {
    "type": "streamable-http",
    "url": "http://YOUR_SERVER:3001/mcp",
    "headers": {
      "Authorization": "Bearer ask_sk_YOUR_KEY"
    }
  }
}
```

### Cursor

```json
{
  "mcpServers": {
    "askdb": {
      "url": "http://YOUR_SERVER:3001/mcp",
      "headers": {
        "Authorization": "Bearer ask_sk_YOUR_KEY"
      }
    }
  }
}
```

<br/>

## FAQ

**How long does setup take?**
Under 10 minutes. Paste your MongoDB URL, configure visibility, copy the MCP URL into your AI tool.

**Does askdb write to my production database?**
Never. It connects read-only to run `mongodump`, then all queries go against the sandbox copy.

**How is field filtering different from data masking?**
Data masking replaces values with fakes. askdb simply omits hidden fields entirely &mdash; the AI doesn't know they exist.

**Can I use this with databases other than MongoDB?**
Not yet. PostgreSQL and MySQL adapters are on the roadmap. The adapter interface is ready.

**How does the sandbox stay fresh?**
Manual sync &mdash; click "Sync Now" in the dashboard. Scheduled sync is on the roadmap.

**Is this secure enough for production data?**
askdb enforces read-only access, field stripping at query time, query validation (allowlist only), encrypted connection strings, and full audit logging. See the [Security](#security) section.

<br/>

## Security

These invariants always hold:

1. **Production databases are never written to** &mdash; read-only connections only
2. **Hidden fields never appear in MCP responses** &mdash; stripped at query time
3. **Hidden collections are never listed or queryable**
4. **All queries are validated** &mdash; only `find`, `aggregate`, `count`, `distinct` allowed
5. **Dangerous aggregation stages are blocked** &mdash; `$merge`, `$out`, `$collStats`, `$currentOp`, `$listSessions`
6. **`$lookup` on hidden collections is rejected**
7. **Connection strings are encrypted at rest** (AES-256-GCM), never logged
8. **API keys are hashed** (SHA-256), shown once, never stored in plaintext
9. **Every MCP query is logged** to the audit trail

<br/>

## Development

```bash
pnpm dev              # Full dev (API + UI + file watching)
pnpm dev:once         # Full dev without file watching
pnpm dev:mcp          # MCP server only
pnpm build            # Build all packages
pnpm typecheck        # Type check all packages
pnpm db:generate      # Generate DB migration
pnpm db:migrate       # Apply migrations

# Tests
pnpm --filter @askdb/mcp-server test    # Unit tests (sandbox isolation, bridge, runtime)
pnpm --filter @askdb/mcp-server e2e     # End-to-end test against real MongoDB (requires Docker)
```

The `e2e` script boots a throwaway MongoDB container, seeds two collections, spins up a temporary askdb MCP server pointed at a temp SQLite DB, and walks through the full Streamable HTTP transport with the official MCP client. It asserts that hidden fields are stripped before data crosses into the Code Mode sandbox &mdash; the cleanest way to verify nothing has regressed end to end.

### Project Structure

```
askdb/
├── server/              # Express API server (@askdb/server)
├── ui/                  # Vite React dashboard (@askdb/ui)
├── packages/
│   ├── shared/          # DB schema, adapters, crypto (@askdb/shared)
│   ├── mcp-server/      # MCP server (@askdb/mcp-server)
│   └── cli/             # CLI tool (askdb-cli)
├── scripts/
│   └── dev-runner.ts    # Dev orchestration (watch + restart)
└── data/                # SQLite database (local)
```

### Tech Stack

- [Vite](https://vite.dev) + [React](https://react.dev) &mdash; Dashboard UI
- [Express](https://expressjs.com) &mdash; API server
- [Drizzle ORM](https://orm.drizzle.team) &mdash; Database (SQLite)
- [Better Auth](https://better-auth.com) &mdash; Authentication
- [shadcn/ui](https://ui.shadcn.com) &mdash; UI components
- [MCP SDK](https://github.com/modelcontextprotocol/sdk) &mdash; AI agent protocol
- [dockerode](https://github.com/apocas/dockerode) &mdash; Container management

<br/>

## Roadmap

- [x] MongoDB adapter with sandbox isolation
- [x] Field-level visibility toggles
- [x] PII auto-detection
- [x] MCP server with 4 tools
- [x] API key auth + audit logging
- [x] Query validation + pipeline security
- [x] Agent memory (query pattern tracking)
- [x] Schema cache for agent context
- [x] CLI tool
- [x] Code Mode (`execute-typescript` MCP tool with QuickJS-WASM sandbox)
- [ ] PostgreSQL adapter
- [ ] MySQL adapter
- [ ] Multi-user / team management
- [ ] Sync schedules (6h, 12h, daily, weekly)
- [ ] Cloud hosted version
- [ ] Row-level filtering
- [ ] SSO/SAML

<br/>

## Community

- [Discord](https://discord.gg/askdb) &mdash; Join the community
- [GitHub Issues](https://github.com/expatal/askdb/issues) &mdash; Bugs and feature requests
- [GitHub Discussions](https://github.com/expatal/askdb/discussions) &mdash; Ideas and RFCs

<br/>

## Contributing

We welcome contributions. See the [contributing guide](CONTRIBUTING.md) for details.

<br/>

## License

MIT &copy; 2025 Expatal

## Star History

[![Star History Chart](https://api.star-history.com/image?repos=expatal/askdb&type=date&legend=top-left)](https://www.star-history.com/?repos=expatal%2Faskdb&type=date&legend=top-left)

<br/>

---

<p align="center">
  <sub>Open source under MIT. Built for people who want AI to understand their data, not own it.</sub>
</p>
