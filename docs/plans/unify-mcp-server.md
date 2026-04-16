# Plan: Unify MCP server into the main server

**Goal:** Run the dashboard, OAuth endpoints, and `/mcp` transport in a single Express app on a single port, on a single public origin. Eliminate the `packages/mcp-server` standalone process and the Traefik path-stripping hack.

**Why:** The current two-port split (`:3100` for UI+OAuth, `:3001` for `/mcp` behind a Traefik path rewrite) is not standard. Every production remote-MCP reference today — Cloudflare's `OAuthProvider` template, the MCP 2026 roadmap, Apigene's hosting guide — runs all OAuth endpoints and `/mcp` on the same origin in the same process. It also caused every bug we hit this week (`ERR_ERL_UNEXPECTED_X_FORWARDED_FOR`, `Cannot POST /`, path-stripped `/` routes).

**Non-goals:**
- Rewriting the MCP tool implementations. They stay byte-identical.
- Swapping the transport. We keep `StreamableHTTPServerTransport`.
- Touching the dashboard UI.
- Adding a reverse proxy inside Node. One Express app, one `app.listen()`.

---

## Current state (as of commit `ba52564`)

```
┌─ container (Coolify) ──────────────────────────────┐
│                                                    │
│  entrypoint.sh                                     │
│    ├── @askdb/server      (tsx src/index.ts)       │
│    │     └── listens :3100                         │
│    │           /api/auth/*     better-auth         │
│    │           /api/*          dashboard API       │
│    │           /authorize      MCP SDK auth router │
│    │           /token          MCP SDK auth router │
│    │           /register       MCP SDK auth router │
│    │           /revoke         MCP SDK auth router │
│    │           /.well-known/*  MCP SDK metadata    │
│    │           /*              static UI           │
│    │                                               │
│    └── @askdb/mcp-server  (tsx src/index.ts)       │
│          └── listens :3001                         │
│                /mcp           StreamableHTTP       │
│                /.well-known/* duplicated metadata  │
│                                                    │
└────────────────────────────────────────────────────┘
        ▲                        ▲
        │                        │
    Traefik /             Traefik /mcp
    (keeps path)          (strips /mcp prefix ← bug magnet)
```

Duplicated helpers across processes:
- `getOAuthIssuerUrl`, `getMcpPublicUrl`, `isLocalHostname` (server/src/lib/mcp-oauth.ts & packages/mcp-server/src/index.ts)
- `verifyAccessToken`-shaped objects (once in the main server's `OAuthServerProvider`, once in mcp-server's `tokenVerifier`)
- OAuth metadata (main server via `mcpAuthRouter`, mcp-server via `mcpAuthMetadataRouter`)

---

## Target state

```
┌─ container ────────────────────────────────────────┐
│  node server.js  (one process, one port: 3100)     │
│    /api/auth/*      better-auth (raw body)         │
│    /api/*           dashboard API                  │
│    /authorize       MCP SDK auth router            │
│    /token           MCP SDK auth router            │
│    /register        MCP SDK auth router            │
│    /revoke          MCP SDK auth router            │
│    /.well-known/*   MCP SDK metadata (single copy) │
│    /mcp             StreamableHTTP transport       │
│    /*               static UI (catchall last)      │
└────────────────────────────────────────────────────┘
        ▲
        │
   Traefik /   (one rule, no prefix tricks)
```

One public URL: `https://<domain>`. MCP endpoint: `https://<domain>/mcp`. No second port, no Coolify Domains gymnastics.

---

## File-level changes

### 1. Turn `packages/mcp-server` into a library

**`packages/mcp-server/src/index.ts`** — refactor so it exports instead of self-starts:

```ts
// New signature. No top-level app, no app.listen.
export function createMcpRouter(options: {
  tokenVerifier: TokenVerifier;      // injected by the host app
  resourceMetadataUrl: URL;
}): { router: express.Router; onShutdown: () => void };
```

- Move every route (`POST /mcp`, `GET /mcp`, `DELETE /mcp`) onto an `express.Router()` and `return` it.
- Keep the `transports: Record<string, StreamableHTTPServerTransport>` map inside the factory closure so sessions are still isolated per instance.
- `createMcpServer(auth)` stays as-is — it's the per-session `McpServer` factory.
- Delete everything in this file below the last handler that exists only to stand the server up: `app.listen`, `app.use(mcpAuthMetadataRouter(...))`, the standalone `tokenVerifier` object, the top-level request-logger middleware, the `getMcpPublicUrl`/`getOAuthIssuerUrl`/`isLocalHostname` helpers (moving them — see step 4).
- Delete the `MCP_ENDPOINT_PATHS = ["/mcp", "/"]` array. Routes become `router.post("/", ...)` etc. — the host app mounts the router at `/mcp`, so inside the router the path is `/`.
- Delete the `"start": "tsx src/index.ts"` script from `packages/mcp-server/package.json`. Leave `"build": "tsc"` for typechecking.

**`packages/mcp-server/src/token-verifier.ts`** (new file) — extract the verifier so both the router and the main server can share it:

```ts
export interface VerifiedMcpAuth { /* shape of AuthContext */ }
export function createMcpTokenVerifier(deps: { db: AskDb; mcpPublicUrl: URL }): TokenVerifier;
```

This contains the legacy-API-key check and the OAuth-token check, returning the `AuthInfo` shape the MCP SDK expects. Main server imports this and passes it to both `requireBearerAuth` (for `/mcp`) and, if needed, the OAuth provider's `verifyAccessToken` hook.

### 2. Mount `/mcp` on the main server

**`server/src/index.ts`** — add two lines where the rest of the routes are wired:

```ts
import { createMcpRouter, createMcpTokenVerifier } from "@askdb/mcp-server";
import { getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";

const mcpPublicUrl = getMcpPublicUrl();                      // from @askdb/shared after step 4
const tokenVerifier = createMcpTokenVerifier({ db, mcpPublicUrl });
const resourceMetadataUrl = new URL(
  getOAuthProtectedResourceMetadataUrl(mcpPublicUrl)
);
const { router: mcpRouter } = createMcpRouter({ tokenVerifier, resourceMetadataUrl });

app.use(
  "/mcp",
  requireBearerAuth({ verifier: tokenVerifier, resourceMetadataUrl }),
  express.json({ limit: "4mb" }),
  mcpRouter
);
```

**Ordering matters.** It must go:

1. `app.set("trust proxy", 1)` (already there, keep)
2. `app.use("/api/auth", authRouter)` — better-auth first, it needs the raw stream
3. `app.use(createMcpOAuthRouter())` — the SDK's auth router (`/authorize`, `/token`, `/register`, `/revoke`, `/.well-known/*`). Its handlers parse their own bodies.
4. `app.use("/mcp", requireBearerAuth, express.json({limit}), mcpRouter)` — **new**. Mounted with its own JSON parser scoped to this path so it doesn't interfere with better-auth or the SDK's urlencoded parser.
5. `app.use(express.json({ limit: "1mb" }))` — global JSON for `/api/*`.
6. `/api/health`, `/api/*` routes.
7. Static UI catchall last.

The `requireBearerAuth` middleware must come **before** `express.json` in that chain? No — it doesn't read the body, just the `Authorization` header. Order between them within the `/mcp` mount doesn't matter; the form above is fine.

### 3. Drop the mcp-server standalone plumbing

**`docker/entrypoint.sh`** — collapse to a single child:

```bash
#!/usr/bin/env bash
set -euo pipefail
mkdir -p /app/data
exec pnpm --filter @askdb/server start
```

No more `wait -n`, no trap/cleanup, no dual PIDs. `tini` (installed in the Dockerfile) becomes the PID-1 reaper for the single Node process.

**`Dockerfile`** — remove `EXPOSE 3001`. Keep `EXPOSE 3100`.

**`docker-compose.yml`** — remove the `3001:3001` port mapping. Update the comment block to describe single-port routing.

**`package.json` (root)** — if `dev` runs `concurrently` on both, drop the mcp-server half. Dashboard dev stays as-is.

**`.env.example`** — remove `MCP_PORT`. `MCP_OAUTH_ISSUER_URL`, `MCP_PUBLIC_URL`, and the TTL vars stay.

### 4. Consolidate helpers

**`packages/shared/src/mcp/urls.ts`** (new file):

```ts
export function getOAuthIssuerUrl(): URL;
export function getMcpPublicUrl(): URL;
```

- `getMcpPublicUrl()` becomes `new URL("/mcp", BETTER_AUTH_URL)` with no localhost branching. The only env override is `MCP_PUBLIC_URL`.
- `isLocalHostname` becomes an internal helper inside this module or is deleted entirely (the only reason it existed was to derive a second port for local dev, which no longer applies).

Re-export from `packages/shared/src/index.ts`. Both the OAuth router and `createMcpTokenVerifier` import from there. Delete the two inlined copies.

### 5. MCP public URL and `.env.example`

**`.env.example`** — one new line of guidance under the existing `MCP_PUBLIC_URL` comment:

> For the default self-hosted setup, leave this unset. The server will
> advertise `${BETTER_AUTH_URL}/mcp` as the MCP endpoint and clients will
> connect to it directly. Only set this if you front `/mcp` on a different
> hostname (rare).

### 6. README "Connecting Your AI Agent" section

Rewrite to a single paragraph:

> Claude, Cursor, and any other remote-MCP client connect to
> `https://<your-domain>/mcp`. Paste that URL as a custom connector and
> complete the OAuth approval in your browser. No port, no path rewriting,
> no API key.

Keep the separate "API key for local clients" block — that's still useful for Claude Code / Cursor local configs that want a fixed bearer.

### 7. Docker Compose comment

Replace the multi-paragraph Traefik note with:

```yaml
ports:
  - "127.0.0.1:3100:3100"   # API + UI + MCP (single port)
```

---

## Verification at each step

Every step must pass before moving on. No "I'll fix it in the next step."

### After step 1 (library extraction)
```bash
(cd packages/mcp-server && npx tsc --noEmit)
```
The package should typecheck but no longer have a runnable entry. `pnpm --filter @askdb/mcp-server start` should fail with a missing-script error — that's correct.

### After step 2 (main server mounts /mcp)
```bash
(cd server && npx tsc --noEmit)
pnpm --filter @askdb/server start &
# wait for "[server] listening"
curl -s http://localhost:3100/.well-known/oauth-protected-resource/mcp | jq .
curl -s -X POST http://localhost:3100/mcp | jq .
# expect 401 with WWW-Authenticate header, not "Cannot POST /mcp"
```
The `401 + WWW-Authenticate: Bearer realm=...` response proves the MCP route is wired and bearerAuth is reachable.

### After step 3 (docker plumbing)
```bash
docker build --target build -t askdb-build-test .
docker compose up --build
# in another shell:
curl -sv http://localhost:3100/mcp   # → 401
curl -sv http://localhost:3001/mcp   # → connection refused (port is gone)
```

### After step 4 (helper consolidation)
```bash
pnpm -r build            # full workspace build; must be clean
git grep -n isLocalHostname
# → only in packages/shared/src/mcp/urls.ts (or gone entirely)
```

### After step 5–7 (env, README, compose cleanup)
Visual review only — no runtime change.

### Full end-to-end (before commit)
```bash
docker compose up --build -d
# From a client:
curl -s https://askdb.talt.ai/.well-known/oauth-authorization-server | jq .
curl -s https://askdb.talt.ai/.well-known/oauth-protected-resource/mcp | jq .
```
Both must return JSON metadata with `https://askdb.talt.ai` origins. Then reconnect the Claude connector once. Success criterion: in the server logs, exactly **one** `registerClient` call followed by `authorize → challengeForAuthorizationCode → exchangeAuthorizationCode → verifyAccessToken ok → [MCP] Session initialized`. No retry loop, no fresh re-registrations.

---

## Risks and how to avoid them

| Risk | Mitigation |
|---|---|
| Body-parser ordering breaks better-auth or the SDK's token endpoint. | Mount `/api/auth` first (raw), then `createMcpOAuthRouter()` (handles its own urlencoded internally), then `/mcp` with its own scoped `express.json()`, then the global `express.json()`. Verified by curl-ing `/api/auth/sign-in/email`, `/token`, and `/mcp` after each step. |
| Shared `db` has not bootstrapped when the first `/mcp` request hits. | Not a concern after merge — bootstrap runs synchronously at main-server startup before `app.listen`. |
| Dashboard `dev` scripts break. | Delete `concurrently`/dual-child logic in root `package.json` `dev`. Single `pnpm --filter @askdb/server dev` is the new entry. |
| Existing deployments break on upgrade because they still have port 3001 mapped. | Leave `MCP_PORT` in the env as a no-op for one release cycle, and add a one-line note in the CHANGELOG: "port 3001 is no longer used; update your reverse proxy to forward `/mcp` to port 3100." |
| Diagnostic `console.log`s from the last debugging session clutter prod output. | Convert them to a single `DEBUG_MCP=1`-gated request logger as part of step 2. Default off. |

---

## What is explicitly NOT in scope

These came up in conversation and should **not** be bundled in:

- **CSRF token on consent POST.** SameSite=Lax on the better-auth cookie mitigates it. Orthogonal to this refactor, parked.
- **Redirect-uri validation gap** when `input.redirectUri` is undefined (`packages/shared/src/auth/oauth.ts:216`). Worth fixing, but as a separate small commit *after* the refactor is green.
- **Expired OAuth row cleanup cron.** Same — separate follow-up commit. Current stale rows are harmless.
- **Switching to a gateway pattern** (one shared auth server fronting multiple MCP servers). Only relevant if askdb grows into multi-tenant/SaaS. Not for a self-hosted single-tenant product.
- **Horizontally scaling `/mcp`.** Requires sticky sessions or moving transport state to the DB — a different project.

---

## Commit shape

Two commits, maybe three. Nothing bigger.

1. **`refactor(mcp): unify mcp-server into main server (single port)`**
   Everything from steps 1–4. Atomic: if you split this across commits, intermediate commits don't build.
2. **`chore(mcp): drop port 3001 from docker compose and README`**
   Steps 5–7. Pure docs + compose; no code.
3. *(optional)* **`chore(mcp): gate diagnostic logs behind DEBUG_MCP`**
   If the log-cleanup ends up noisy in the first commit, split it out here.

Push to `main`, redeploy on Coolify, update Coolify's Domains field to drop the `:3001/mcp` half, reconnect the Claude connector once to sanity-check, done.
