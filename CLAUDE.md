@AGENTS.md

## Key Paths

| What | Where |
|------|-------|
| Server entry | `server/src/index.ts` |
| DB schema | `packages/shared/src/db/schema.ts` |
| Sync scheduler | `packages/shared/src/adapters/mongodb/scheduler.ts` |
| Sync logic | `packages/shared/src/adapters/sync.ts` |
| DB adapters | `packages/shared/src/adapters/{mongodb,postgresql}/` |
| Dashboard pages | `ui/src/pages/dashboard/` |
| MCP tools | `packages/mcp-server/src/index.ts` |

## Tech Stack

Express, React, TypeScript, Drizzle ORM (SQLite), Better Auth, Docker API

## Rules

- SQLite via Drizzle — no migrations framework, schema changes are additive with safe defaults
- Connection strings and passwords are AES-256-GCM encrypted
- Sandbox containers are managed via Docker socket proxy
- All AI queries go through MCP — never expose raw DB access
