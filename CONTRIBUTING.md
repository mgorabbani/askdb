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
server/                 Main Express app (port 3100). Serves UI, /api/*,
                        /api/auth/*, OAuth endpoints, and /mcp.
packages/mcp-server/    MCP router factory + tool implementations. Library
                        only — mounted into server/ at /mcp.
packages/shared/        DB schema (drizzle + SQLite), better-auth wiring,
                        DCR OAuth provider, sandbox Docker manager,
                        shared helpers (urls, crypto, PII).
ui/                     React SPA built with Vite.
cli/                    CLI tool.
docker/                 Container entrypoint (auto-secrets generation).
deploy/                 Caddyfile for the bundled reverse proxy.
docs/plans/             Implementation plans for past/current work.
```

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

## Running checks

```bash
pnpm typecheck                          # all workspaces
pnpm build                              # full build (tsc + vite)
pnpm --filter @askdb/mcp-server e2e     # code-mode e2e (in-process)
pnpm --filter @askdb/mcp-server test    # unit tests
```

## Proposing changes

1. Open an issue describing the problem or proposal (for non-trivial work, discuss the approach before writing code).
2. Work on a feature branch off `main`.
3. Open a PR targeting `main`. Rebase onto latest `main` before review.
4. CI (when set up) must pass.

## Security issues

Do **not** open public GitHub issues for security vulnerabilities. See [SECURITY.md](SECURITY.md) for the responsible-disclosure process.

## Code of conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). Unacceptable behavior can be reported to `conduct@askdb.dev`.
