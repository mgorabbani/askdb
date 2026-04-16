# Plan: post-unify hardening for dbgate-agent

## Context

`docs/plans/unify-mcp-server.md` collapses the two-process split (`:3100` + `:3001`) into one Express app behind a single Traefik rule. It's the right architectural move, but it is deliberately scoped to plumbing: it does **not** close the security and PII gaps that were already present in the two-process era and will still be present after merge.

This plan captures those gaps as four atomic follow-up PRs that land **after** the unify refactor merges. The unify PR itself stays byte-identical to the existing doc — no edits. Every finding below was verified by reading the source at the cited `file:line`.

**What this plan is NOT doing:**
- Not modifying `docs/plans/unify-mcp-server.md`.
- Not adding microVMs, per-session sandboxes, or replica-based data scrubbing (see memory `project_dbgate_agent_security_model` — the VPS boundary holds for self-hosted).
- Not introducing DPoP, mTLS, or Resource Owner Password flows. Overkill for a single-tenant self-hosted product.

**What this plan IS doing:**
- Stopping the diagnostic token/params leaks that are live in prod right now (commits `65bbaf2`, `af276b4`).
- Closing two real PII escape hatches: aggregation-pipeline aliasing and `save-insight` storing raw agent text forever.
- Adding the standard-issue OAuth hardening (consent CSRF, helmet, DCR size caps, TTL, redirect-uri undefined case).
- Adding a SIGTERM handler and SSE keepalive that the unify plan doesn't mention.

Research basis: MCP authorization spec (2026 draft), Cloudflare `workers-oauth-provider` patterns, Anthropic's remote-connector guidance. Core consensus: OAuth 2.1 + PKCE S256, RFC 8707 resource indicators, pino-style path-redacted logging, column allow-lists as primary PII defense.

---

## Decisions already made (from in-session Q&A)

| Decision | Chosen |
|---|---|
| Sequencing | Ship unify clean; this plan is all post-unify follow-up |
| `save-insight` PII policy | Reject by default, with per-user disable flag |
| Structured logger | `pino` with redact paths |
| Aggregation aliasing defense | Walk pipeline AST, deny hidden-field references |

---

## PR 1 — Stop the live log leaks + adopt pino

**Why first:** The CRITICAL findings are not architectural. They are `console.log` lines added during the week's OAuth debugging that are currently shipping to prod stdout. Lowest-complexity, highest-immediate-impact change.

**Files:**
- `packages/mcp-server/src/index.ts:163-211` — the MCP server's token verifier with `tokenPrefix` logs on both hit and miss paths (lines 168, 181, 187, 190).
- `server/src/lib/mcp-oauth.ts:69,74,80,156,159,172,175,190,193,208,211` — every OAuth provider hook has a `console.log`/`console.error` that echoes params, redirect URIs, resource URLs, and a token prefix.
- `packages/mcp-server/src/index.ts:1244-1250` — the request logger in the MCP server's own Express app. This one is *already* correctly redacted (last 8 chars). Keep as model.
- `server/src/index.ts:41-48` — the main server's equivalent request logger. Also already correctly redacted.

**Approach:**
1. Add `pino` and `pino-http` as dependencies at the workspace root. Create `packages/shared/src/logging/index.ts` exporting a preconfigured logger:
   ```ts
   export const logger = pino({
     level: process.env.LOG_LEVEL ?? "info",
     redact: {
       paths: [
         "req.headers.authorization",
         "req.headers.cookie",
         "*.token",
         "*.access_token",
         "*.refresh_token",
         "*.code",
         "*.code_verifier",
         "*.code_challenge",
         "*.client_secret",
         "tokenPrefix",
       ],
       censor: "[REDACTED]",
     },
   });
   ```
2. Replace every `console.log`/`console.warn`/`console.error` in `server/src/lib/mcp-oauth.ts` with a structured `logger.info({ clientId, scopes, resourceAllowed }, "oauth.authorize")`-style call. Drop `JSON.stringify(params.scopes)` — the redact paths catch them automatically when logged as object keys.
3. In `packages/mcp-server/src/index.ts:163-211`, remove `tokenPrefix` entirely from log output. Log `clientId` and decision (`ok | miss | no_connection`). A token prefix is 40 bits of entropy, more than enough to start narrowing a brute-force.
4. Error paths (`challengeForAuthorizationCode`, `exchangeAuthorizationCode`, etc.) must log `error.message` only, not the error object. `logger.error({ clientId, err: err.message }, "oauth.exchange.failed")`. Pino serializes Error objects safely, but the current code passes the raw `error`, which gets stringified and may include DB query text.
5. Gate verbose per-hook logs behind `LOG_LEVEL=debug`, not `DEBUG_MCP`. Consistent with pino conventions.

**Verification:**
- `pnpm --filter @askdb/server start`, then trigger a full OAuth dance from a client. `jq` the stdout JSON — no `Bearer `, no `tokenPrefix=`, no `scopes=["askdb:...`, no `code=`.
- `grep -nE "console\.(log|warn|error).*(token|code|challenge|verifier|secret|Authorization|Bearer)" server packages` returns nothing.
- Unit test on the redact config: pass a known-PII object through the logger and assert the serialized output has `[REDACTED]` at every configured path.

---

## PR 2 — OAuth hardening

**Why second:** These are real gaps — not "bug is firing right now" severity, but each is a credible attack surface on a public-facing OAuth endpoint. Batching them into one focused PR keeps the review tight.

**Work items:**

### 2.1 Fix `redirect_uri` undefined gap
- File: `packages/shared/src/auth/oauth.ts:250-252`
- Current: `if (input.redirectUri && input.redirectUri !== row.redirectUri) throw ...` — when `input.redirectUri` is undefined, validation is skipped silently.
- Per OAuth 2.1 §4.1.3, if `redirect_uri` was included in the authorize request (PKCE requires it), it MUST be present at token exchange. Change to:
  ```ts
  if (input.redirectUri !== row.redirectUri) {
    throw new Error("redirect_uri does not match the authorization request");
  }
  ```
  The row's `redirectUri` is always set (it's non-null at insert time, line 192), so this tightens the check without breaking legitimate flows.
- Apply the same treatment to `input.resource` on line 254.

### 2.2 Cap DCR client metadata size
- File: `server/src/lib/mcp-oauth.ts:72-76` and `packages/shared/src/auth/oauth.ts:136-168` (`storeOAuthClient`).
- Current: `registerClient` accepts arbitrary client metadata. `OAuthClientRecord` has `[key: string]: unknown`. No limits.
- Add validation in `normalizeClientRecord` (line 245 of mcp-oauth.ts):
  - `redirect_uris.length <= 10`
  - `redirect_uris.every(u => u.length <= 2048)`
  - `redirect_uris.every(isHttpsOrLoopback)` — reject `javascript:`, `data:`, `file:`, etc.
  - Serialized client record `<= 16 KB`
- Throw `InvalidRequestError` (from MCP SDK) with a generic message — don't leak which check failed.

### 2.3 Shorten authorization code TTL
- File: `packages/shared/src/auth/oauth.ts:94-96`.
- Current default: 600s (10 min). Longer than OAuth 2.1 recommends (60-120s typical).
- Change default to `120`. Keep env override. Real clients exchange within seconds.

### 2.4 Add consent CSRF token
- File: `server/src/lib/mcp-oauth.ts:79-151` (`authorize` hook) and `:280-366` (`renderConsentPage`).
- Current: relies solely on `SameSite=Lax` on the better-auth session cookie. One defense.
- Add explicit CSRF token:
  - On GET: generate a random nonce, store in the user's better-auth session as `csrf.mcpAuthorize` with a 10-minute TTL, include as hidden form field.
  - On POST: read from form body, compare to session value, invalidate after use. Reject with 403 on mismatch.
  - Also: hard-code `formAction = "/authorize"` (strip query). Currently `req.originalUrl.split("?")[0]` — likely safe but not self-evidently so.

### 2.5 Add helmet with scoped CSP
- File: `server/src/index.ts:34` (new, before trust-proxy).
- Install `helmet`. Configure:
  ```ts
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        // consent page renders inline <style>; keep it or move to external CSS
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
      },
    },
    strictTransportSecurity: { maxAge: 31536000, includeSubDomains: true },
    referrerPolicy: { policy: "no-referrer" },
  }));
  ```
- Verify the consent page still renders; move inline `<style>` to a static file if CSP rejection is unacceptable.

### 2.6 Explicit rate limits on OAuth endpoints
- File: `server/src/index.ts` — wrap the MCP OAuth router.
- The MCP SDK's `mcpAuthRouter` ships with default `express-rate-limit` windows, but they're not visible from the outside. Add our own per-IP limits on top:
  - `/authorize`: 20/min
  - `/token`: 10/min
  - `/register`: 5/min
- Log rate-limit hits (at `warn`) for anomaly detection.

**Verification:**
- Run the full OAuth dance end-to-end from a Claude connector. Must succeed.
- `curl -X POST https://<domain>/register -d '{"redirect_uris":["javascript:alert(1)"],"client_name":"x"}'` → 400.
- `curl -X POST https://<domain>/token` 15 times quickly → last ones 429.
- Inspect response headers on `/authorize` page: `Content-Security-Policy`, `Strict-Transport-Security`, `X-Frame-Options: DENY` all present.
- Submit a forged POST to `/authorize` from a non-same-site context (evil.example page) → 403.

---

## PR 3 — PII hardening

**Why third:** The two real gaps here — aggregation aliasing and unfiltered `save-insight` — are the only paths by which a hidden column's *values* can reach the MCP client or persist to future agents. Everything else in the PII layer (schema visibility, `stripFields` on top-level results, `execute-typescript` routing through the bridge) already works.

### 3.1 Aggregation pipeline AST walker
- File: `packages/mcp-server/src/index.ts:268-330` (the existing `stripFields` helpers, plus the aggregation entry point around line 614).
- Problem (verified at `packages/mcp-server/src/index.ts:294-308`): `stripFields` only checks top-level keys against a flat `Set<string>`. A pipeline like `[{"$addFields": {"x": "$hidden_field"}}]` produces results with `{x: ...}` where `x` is not hidden, so the stripper passes it through.
- Add `validateAggregationPipeline(pipeline, hiddenFields: Set<string>)` — walks every stage recursively:
  - For value-producing operators (`$project`, `$addFields`, `$set`, `$replaceRoot`, `$replaceWith`, `$group`, `$bucket`, `$bucketAuto`, `$facet`, `$sortByCount`): scan the RHS of every expression for `$<field>` references or `{$literal: ...}`/`{$getField: ...}` — reject if any references a hidden field.
  - For `$lookup`: require the joined collection is also visible; reject if any `let` binding or `pipeline` references a hidden field of either side.
  - For `$redact` and `$function`: reject outright. Arbitrary expression evaluation against documents that contain hidden fields is too dangerous.
  - Unknown operator: reject (fail-closed).
- Call before `executeQueryOperation` and before the `external_aggregate` bridge in `code-mode/`.
- Add a config flag `MCP_AGGREGATION_STRICT` (default `true`) to let advanced users opt out with a documented risk note.

### 3.2 `save-insight` PII filter with policy flag
- File: `packages/mcp-server/src/index.ts:1150-1213`.
- Problem: `insight` and `exampleQuery` are persisted verbatim to `agentInsights` (line 1185) and surfaced to all future agents via `guide://usage`. No content filter.
- Add `detectPotentialPii(text: string, hiddenFieldNames: Set<string>): string[]` that returns a list of offenders:
  - Email: `/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/`
  - US SSN: `/\b\d{3}-\d{2}-\d{4}\b/`
  - Credit-card-shaped (Luhn-valid 13–19 digits): run Luhn on any digit-only substring
  - E.164 phone: `/\+?\d{10,15}\b/`
  - Long digit runs ≥ 9: `/\b\d{9,}\b/`
  - Any hidden field name appearing as a bare word
- Default behavior: if hits → return tool error `"Insights must describe patterns, not specific data points. Rephrase to remove: <kinds>."`. Do NOT echo the matched substring.
- Add user-scoped setting `insightPiiPolicy: "reject" | "disabled"` (stored in the user's dashboard settings, default `"reject"`). When `"disabled"`, skip the check but log `{userId, kinds}` at warn for audit. This respects the solo self-hosted operator who owns the data.
- Expose in the dashboard Settings page so the user can flip it from the UI, not from env vars.

### 3.3 Sanitize DB errors returned to MCP client
- File: `packages/mcp-server/src/index.ts:632-634` and all similar `toolError(toolName, \`Query error: ${msg}\`)` patterns.
- Problem: MongoDB errors often echo the failing query/pipeline. If the pipeline referenced a hidden field name that later got blocked, or if an invalid filter key was from a hidden column, the error text leaks the name.
- Wrap with `sanitizeDbError(err, hiddenFields)`: redact any hidden field name substring, strip anything matching MongoDB-internal paths (`db.collection.{name}`), and cap total error length at 512 chars.
- Log the raw error at `debug` (redacted by pino) for operator diagnosis.

### 3.4 Audit log query field truncation
- File: `packages/mcp-server/src/index.ts:333-352` (`writeAuditLog`).
- Current: `query` field stores the raw user-provided JSON including any filter values. A query `{email: "user@example.com"}` ends up in SQLite verbatim.
- Decision: truncate to 2 KB and apply the same PII detector at write time. When detected, replace with `"<redacted: <hash>>"`. Keep the hash so operators can still correlate.

**Verification:**
- Pipeline unit test suite: 12 cases from "clean projection" to "$addFields alias of hidden" to "$lookup into hidden collection". Asserts strict mode blocks aliasing, non-strict logs-and-allows.
- `save-insight` tests: raw email/SSN/phone/CC → reject; hidden-field name in text → reject; pattern-only text ("`users.email` is indexed") → allow; each case exercises both `reject` and `disabled` policies.
- End-to-end: from the Claude desktop connector, run `aggregate users [{$addFields: {x: "$email"}}]` where `email` is hidden → tool returns an error; no document with `x` field is returned.

---

## PR 4 — Unify-plan gaps + polish

**Why last:** These are items the unify doc doesn't cover. None urgent, but leaving them open means the first incident is a handwritten postmortem. Grouped because they're small and related.

### 4.1 SIGTERM handler
- File: `server/src/index.ts:106-108` (the `app.listen` call).
- Current: no signal handler. After unify, the entrypoint sends `SIGTERM` to the single process and gets an abrupt exit. In-flight MCP SSE streams drop uncleanly.
- Add:
  ```ts
  const server = app.listen(PORT, () => { /* ... */ });
  const shutdown = (signal: string) => {
    logger.info({ signal }, "shutting down");
    server.close((err) => process.exit(err ? 1 : 0));
    // Hard-kill after 10s if `server.close` hangs on long-lived SSE
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  ```

### 4.2 SSE keepalive
- File: `packages/mcp-server/src/index.ts:1383-1397` (GET `/mcp`).
- Current: long-lived stream with no keepalive. Reverse proxies (Traefik, CloudFront) idle-timeout at 60–120s by default.
- Add a 25-second heartbeat per active transport: `res.write(":heartbeat\n\n")` on a `setInterval`, cleared on `res.close`.

### 4.3 Static UI catchall ordering
- File: `server/src/index.ts:99`.
- Current: `app.get("/*splat", ...)` runs only in `static` mode and only after all other routes.
- After unify, verify the new `/mcp` mount is added **before** the `uiMode === "static"` block. The unify doc implies this via step ordering but doesn't enforce it at review time. Action: add a comment at the catchall `// keep this last — must run after /mcp and /api` so future edits don't shuffle.

### 4.4 Dead code from the two-port era
- File: `packages/mcp-server/src/index.ts` — after unify, `MCP_ENDPOINT_PATHS = ["/mcp", "/"]` (line 1317) is dead; the `/` fallback existed only for the Traefik path-strip quirk. Delete.
- File: `packages/shared/src/mcp/urls.ts` (new from unify step 4) — ensure `isLocalHostname` and `DEFAULT_MCP_PORT` are fully gone, not stubbed.

### 4.5 `/health` alias
- Current: `/api/health` exists (`server/src/index.ts:57`). Coolify's default health check hits `/health` without the prefix.
- Add `app.get("/health", ...)` as a tiny aliased handler returning `{ok:true}`. Not worth env-gating.

---

## Non-goals (explicit)

- **DPoP / mTLS client binding** — overkill for public-client Claude connector flows on a single-tenant VPS.
- **Token hashing migration** — tokens and auth codes ARE already hashed at rest (verified at `oauth.ts:188, 290`, and client records encrypted at `:147`). No work needed.
- **Replacing better-auth** — it handles the dashboard session layer correctly; the concerns are all in the MCP auth router.
- **Rewriting the MCP tools** — `find`/`aggregate`/etc. stay as-is; PR 3 wraps them with additional checks, doesn't replace them.
- **Adding data-scrubbing / synthetic data** — the visibility model (allow-list columns, block aliasing, reject PII in insights) is the right tradeoff for self-hosted per-user.
- **Horizontal scaling / sticky sessions for `/mcp`** — same trade as unify doc: out of scope for single-tenant.

---

## Critical files reference

| File | Purpose |
|---|---|
| `server/src/index.ts` | Main Express app; PRs 1, 2.5, 2.6, 4.1, 4.3, 4.5 edit here |
| `server/src/lib/mcp-oauth.ts` | OAuth provider hooks + consent form; PRs 1, 2.2, 2.4 edit here |
| `packages/shared/src/auth/oauth.ts` | DB-backed OAuth primitives; PRs 2.1, 2.3 edit here |
| `packages/mcp-server/src/index.ts` | Tool surface + token verifier; PRs 1, 3.1, 3.2, 3.3, 3.4, 4.2, 4.4 edit here |
| `packages/shared/src/logging/index.ts` | New in PR 1 (pino + redact) |
| `scripts/dev-runner.ts` | Drop the mcp child after unify lands (not in this plan's scope) |

---

## Verification summary

Each PR has its own verification block above. For the full sequence, the end-to-end proof that PRs 1–4 all landed cleanly:

```bash
# PR 1
grep -rnE "console\.(log|warn|error).*(token|code|challenge|secret|Bearer)" server packages  # no matches

# PR 2
curl -s -D- https://<domain>/authorize | grep -i 'strict-transport-security\|x-frame-options\|content-security-policy'  # all present
for i in {1..20}; do curl -sX POST https://<domain>/token; done | tail -5  # some 429s

# PR 3
# From a Claude connector:
# aggregate users [{"$addFields":{"exposed":"$ssn"}}]  → tool error, not leaked data
# save-insight "john.doe@example.com failed login"     → tool error asking for abstraction

# PR 4
curl -s https://<domain>/health                        # {ok:true}
docker compose kill -s TERM askdb; docker compose logs --tail 5 askdb  # graceful "shutting down" log
```

Then connect a fresh Claude connector; success criterion is exactly one `registerClient → authorize → challengeForAuthorizationCode → exchangeAuthorizationCode → verifyAccessToken ok → Session initialized` trace with no retry loop.
