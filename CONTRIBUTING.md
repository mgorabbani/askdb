# Contributing to askdb

Thanks for your interest in improving askdb. This doc covers local development, conventions, and how to propose changes.

## Development setup

```bash
git clone git@github.com:mgorabbani/askdb.git
cd askdb
corepack enable
corepack prepare pnpm@10.33.0 --activate
pnpm install
cp .env.example .env
# Edit .env: set BETTER_AUTH_URL=http://localhost:3100 if you want.
# BETTER_AUTH_SECRET and ENCRYPTION_KEY are auto-generated at runtime
# if unset — you can leave them blank for dev.
pnpm dev
```

`pnpm dev` starts the unified server on port 3100 (API + UI + `/mcp`) alongside the Vite dev middleware.

## Project layout

```
askdb/
├── server/              # @askdb/server — Express API + UI host + MCP endpoint on :3100
├── ui/                  # @askdb/ui — Vite React SPA
├── cli/                 # @askdb/cli — askdb CLI
├── packages/
│   ├── shared/          # @askdb/shared — DB schema, adapters, crypto, sandbox Docker manager
│   └── mcp-server/      # @askdb/mcp-server — MCP router factory + tool implementations
├── scripts/
│   └── dev-runner.ts    # Zero-dep orchestrator: spawns server + UI watcher
├── docker/
│   └── entrypoint.sh    # Runtime entrypoint (single server process under tini)
├── deploy/              # Caddyfile for the bundled reverse proxy
├── Dockerfile           # Multi-stage: deps → build → runtime
├── docker-compose.yml   # One-command self-host
└── data/                # SQLite database (gitignored, mounted as volume in prod)
```

## Tech stack

- [Vite](https://vite.dev) + [React](https://react.dev) — Dashboard UI
- [Express](https://expressjs.com) — API server
- [Drizzle ORM](https://orm.drizzle.team) — Database (SQLite)
- [Better Auth](https://better-auth.com) — Authentication
- [shadcn/ui](https://ui.shadcn.com) — UI components
- [MCP SDK](https://github.com/modelcontextprotocol/sdk) — AI agent protocol
- [dockerode](https://github.com/apocas/dockerode) — Container management

## Conventions

### Commit messages

We follow [Conventional Commits](https://www.conventionalcommits.org/):

- `feat(scope): …` — user-facing addition
- `fix(scope): …` — bug fix
- `refactor(scope): …` — no behavior change
- `chore(scope): …` — tooling, deps
- `docs: …` — docs only

Keep commits atomic. One logical change per commit.

### TypeScript

- Strict mode in every package.
- Prefer `zod` for runtime validation at boundaries (HTTP bodies, env vars, MCP tool inputs).
- Avoid `any`. When unavoidable, add a comment explaining why.

### Database

- SQLite via drizzle-orm. Schema lives in `packages/shared/src/schema.ts`.
- Migrations apply on startup via `ensureDatabaseSchema(db)`.
- When adding a column, update the schema and test against a fresh database path.

### MCP tools

Tool handlers live in `packages/mcp-server/src/index.ts`. A new tool must:

1. Validate inputs with zod.
2. Check scope authorization via the `AuthContext`.
3. Strip hidden fields/collections based on the visibility rules in `schemaTables` / `schemaFields`.
4. Write an `auditLogs` row describing the call.

## Development commands

```bash
pnpm dev              # Full dev (API + UI + file watching)
pnpm build            # Build all packages
pnpm typecheck        # Type check all packages
pnpm db:generate      # Generate DB migration
pnpm db:migrate       # Apply migrations
```

## Running tests

```bash
pnpm --filter @askdb/mcp-server test    # Unit tests (sandbox isolation, bridge, runtime)
pnpm --filter @askdb/mcp-server e2e     # End-to-end test against real MongoDB (requires Docker)
```

The `e2e` script boots a throwaway MongoDB container, seeds two collections, spins up a temporary AskDB MCP server pointed at a temp SQLite DB, and walks through the full Streamable HTTP transport with the official MCP client. It asserts that hidden fields are stripped before data crosses into the Code Mode sandbox.

## Proposing changes

1. Open an issue describing the problem or proposal (for non-trivial work, discuss the approach before writing code).
2. Work on a feature branch off `main`.
3. Open a PR targeting `main`. Rebase onto latest `main` before review.
4. CI (when set up) must pass.

## Security issues

Do **not** open public GitHub issues for security vulnerabilities. See [SECURITY.md](SECURITY.md) for the responsible-disclosure process.

## Code of conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). Unacceptable behavior can be reported to `conduct@askdb.dev`.
