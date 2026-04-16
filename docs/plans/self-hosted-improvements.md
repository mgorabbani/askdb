# Plan: Self-hosted deployment improvements

**Goal:** Make askdb installable by a stranger with a fresh VPS in under 5 minutes via a single `curl | bash` command, with automatic HTTPS, auto-generated secrets, and hardened defaults — without depending on Coolify, Traefik, or any external PaaS.

**Why:** The current setup works great if you already run Coolify. For anyone else — the actual self-hosted audience — the path is: clone the repo, write a `.env` with unclear defaults, install Docker manually, install a reverse proxy manually, figure out Let's Encrypt manually, hope the `trust proxy` bug we hit doesn't bite them. We want the Plausible / Appwrite / Supabase experience: one command, one domain prompt, working HTTPS URL at the end.

**Depends on:** `docs/plans/unify-mcp-server.md` ships first. This plan assumes `/mcp` is served by the main server on port 3100 in a single process. If the unify plan stalls, this plan still works but the Caddy upstream is `askdb:3100` not `askdb:3100,askdb:3001`.

**Non-goals:**
- Multi-tenant / SaaS hosting. Single-tenant, single-VPS only.
- Kubernetes manifests. A Helm chart is a separate project.
- Windows hosts. Ubuntu 22.04+ / Debian 12+ only.
- Replacing better-auth, the SDK's MCP OAuth router, or any of the MCP tools.

---

## Current state (post-unify-mcp-server)

```
┌─ VPS ──────────────────────────────────────────────┐
│                                                    │
│  user runs:                                        │
│    git clone && cp .env.example .env               │
│    edit .env (BETTER_AUTH_SECRET=???)              │
│    docker compose up -d                            │
│    …install Caddy/Traefik separately…             │
│    …configure Let's Encrypt…                       │
│    …hope X-Forwarded-For trust proxy is right…    │
│                                                    │
│  askdb container :3100 (internal only)             │
│     ↑                                              │
│  external reverse proxy (user's responsibility)    │
│                                                    │
└────────────────────────────────────────────────────┘
```

Operator pain points observed:
- `BETTER_AUTH_SECRET` and `ENCRYPTION_KEY` ship with dev defaults in `.env.example`. People forget to change them.
- `trust proxy=1` trusts any single hop; already caused `ERR_ERL_UNEXPECTED_X_FORWARDED_FOR` (commit `0970e24`).
- No healthcheck in Dockerfile or compose → Docker can't tell if the app is alive.
- OAuth DCR (`/register`) and `/token` have no rate limit → unlimited client records / token-grinding on the open web.
- Redirect-URI validation gap at `packages/shared/src/auth/oauth.ts:216`.
- `GET /api/setup-status` leaks whether an admin exists to anonymous callers.
- `/api/health` returns `{ uiMode, timestamp }` — useful to operators but also leaks build-mode info publicly.
- Session transport `Map` in the MCP router is unbounded.

---

## Target state

```
┌─ VPS (fresh Ubuntu) ───────────────────────────────┐
│                                                    │
│  user runs:                                        │
│    curl -fsSL https://get.askdb.dev | bash         │
│                                                    │
│  installer:                                        │
│    1. installs Docker if missing                   │
│    2. prompts DOMAIN + ACME_EMAIL                  │
│    3. picks profile (caddy | proxyless | tunnel)   │
│    4. generates secrets → /opt/askdb/.env          │
│    5. docker compose up -d                         │
│    6. waits for health + TLS provision             │
│    7. prints https://<domain>/mcp                  │
│                                                    │
│  compose (with COMPOSE_PROFILES=caddy):            │
│    caddy       :80 :443 → askdb:3100               │
│    askdb       :3100 (internal)                    │
│                                                    │
└────────────────────────────────────────────────────┘
```

Three supported install profiles, picked by `install.sh`:

| `COMPOSE_PROFILES` | When to use | Exposes |
|---|---|---|
| `caddy` (default) | Fresh VPS with a domain. Installer handles TLS end-to-end. | 80, 443 |
| `proxyless` | Existing Coolify / Traefik / nginx in front. | 3100 (127.0.0.1 only) |
| `tunnel` | Cloudflare Tunnel user, no open ports. | nothing |

---

## File-level changes

### 1. Compose: bundle Caddy behind a profile

**`docker-compose.yml`** — replace current file:

```yaml
services:
  askdb:
    build: .
    image: ghcr.io/expatal/askdb:latest
    restart: unless-stopped
    environment:
      NODE_ENV: production
      PORT: 3100
      SERVE_UI: "1"
      BETTER_AUTH_URL: https://${DOMAIN}
      DATABASE_PATH: /app/data/askdb.db
    env_file:
      - .env
    volumes:
      - askdb-data:/app/data
      - /var/run/docker.sock:/var/run/docker.sock
    extra_hosts:
      - "host.docker.internal:host-gateway"
    expose:
      - "3100"
    # proxyless profile binds the port on loopback for external proxies
    ports: !reset []
    healthcheck:
      test: ["CMD-SHELL", "wget -qO- http://127.0.0.1:3100/api/health >/dev/null || exit 1"]
      interval: 30s
      timeout: 5s
      start_period: 20s
      retries: 3

  askdb-proxyless:
    extends: askdb
    profiles: ["proxyless"]
    ports:
      - "127.0.0.1:3100:3100"

  caddy:
    image: caddy:2-alpine
    profiles: ["caddy"]
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    environment:
      DOMAIN: ${DOMAIN:?set DOMAIN in .env}
      ACME_EMAIL: ${ACME_EMAIL:?set ACME_EMAIL in .env}
    volumes:
      - ./deploy/Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy-data:/data
      - caddy-config:/config
    depends_on:
      askdb:
        condition: service_healthy

  cloudflared:
    image: cloudflare/cloudflared:latest
    profiles: ["tunnel"]
    restart: unless-stopped
    command: tunnel --no-autoupdate run --token ${CF_TUNNEL_TOKEN}
    depends_on:
      askdb:
        condition: service_healthy

volumes:
  askdb-data:
  caddy-data:
  caddy-config:
```

Key points:
- `profiles` is the single switch. `docker compose --profile caddy up` or `COMPOSE_PROFILES=caddy` in `.env` both work.
- `askdb` has no host `ports:` by default — only `expose:` to other services on the Docker network.
- `askdb-proxyless` is an `extends` that adds the loopback host port. Activated with `--profile proxyless`.
- `depends_on.askdb.condition: service_healthy` ties Caddy's start to the app being reachable — prevents Caddy from hitting a not-ready backend and failing ACME.

### 2. Caddyfile

**`deploy/Caddyfile`** (new):

```caddy
{
    email {$ACME_EMAIL}
}

{$DOMAIN} {
    encode zstd gzip

    # MCP endpoint (Streamable HTTP, includes SSE)
    reverse_proxy /mcp* askdb:3100 {
        flush_interval -1
        transport http {
            keepalive 120s
        }
    }

    # Everything else (UI, OAuth router, /api/*)
    reverse_proxy askdb:3100
}
```

`flush_interval -1` disables response buffering so SSE streams from `StreamableHTTPServerTransport` arrive in real time.

### 3. App-level hardening

**`server/src/index.ts`** — change `app.set("trust proxy", 1)` to the loopback + Docker bridge range, because Caddy is now on the same Docker network:

```ts
// Trust the Caddy sidecar (Docker bridge) and loopback only. Never `true`,
// never `1` — both allow a client talking directly to port 3100 to forge
// X-Forwarded-For. See commit 0970e24 for prior art.
app.set("trust proxy", ["127.0.0.1/32", "172.16.0.0/12", "10.0.0.0/8"]);
```

**`server/src/index.ts`** — mount a scoped rate limiter *before* the OAuth router:

```ts
import rateLimit from "express-rate-limit";

const oauthLimiter = rateLimit({
  windowMs: 60_000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  // Key by real IP, which trust-proxy above now surfaces correctly.
});
app.use(["/authorize", "/token", "/register", "/revoke"], oauthLimiter);
```

Do NOT apply the limiter to `/mcp` — StreamableHTTP SSE connections are long-lived and would trip the limit.

**`server/src/index.ts:62-64`** — gate `/api/setup-status`:

```ts
app.get("/api/setup-status", async (req, res) => {
  // Only reveal setup status to same-origin callers with no session.
  // Anonymous external probes get a generic 200.
  const origin = req.get("origin");
  const sameOrigin = origin === process.env.BETTER_AUTH_URL;
  if (!sameOrigin) return res.json({ ok: true });
  res.json({ needsSetup: !(await isSignupLocked()) });
});
```

**`server/src/lib/mcp-oauth.ts`** — add CSRF double-submit on the consent POST. Two edits:

1. In the GET branch (lines 114–125), set a cookie and embed it in the form:

```ts
const csrfToken = randomBytes(16).toString("hex");
res.cookie("askdb_csrf", csrfToken, { sameSite: "lax", httpOnly: false, secure: true, maxAge: 10 * 60_000 });
return res.send(renderConsent({ /* existing fields */, csrfToken }));
```

2. In the POST branch (wherever `action=approve` is handled):

```ts
const formToken = readFormValue(req, "csrf");
const cookieToken = req.cookies?.askdb_csrf;
if (!formToken || formToken !== cookieToken) {
  return res.status(403).send("CSRF token mismatch");
}
```

Requires `cookie-parser` middleware if not already present. Add `app.use(cookieParser())` once, before the OAuth router mount.

**`packages/shared/src/auth/oauth.ts`** — fix the redirect-URI validation gap at line 216. Reject DCR requests where:
- `redirect_uris` is missing, empty, or non-array
- Any URI is not `https://…` (except `http://localhost:*` / `http://127.0.0.1:*` for local Claude Code clients)
- Any URI contains `*` or other wildcards
- The list has more than 5 URIs

**`packages/mcp-server/src/index.ts`** (or wherever the transport map lands after the unify refactor) — cap the session map:

```ts
const MAX_SESSIONS = 1000;
if (!sessionId && Object.keys(transports).length >= MAX_SESSIONS) {
  res.status(429).json({ error: "Too many active sessions" });
  return;
}
```

### 4. Auto-generate secrets

**`docker/entrypoint.sh`** — replace current content:

```bash
#!/usr/bin/env bash
set -euo pipefail

SECRETS_FILE=/app/data/.secrets
mkdir -p /app/data

if [ ! -f "$SECRETS_FILE" ]; then
  umask 077
  {
    echo "BETTER_AUTH_SECRET=$(openssl rand -hex 32)"
    echo "ENCRYPTION_KEY=$(openssl rand -hex 32)"
  } > "$SECRETS_FILE"
  echo "[entrypoint] generated new secrets at $SECRETS_FILE"
fi

# shellcheck disable=SC1090
set -a; . "$SECRETS_FILE"; set +a

exec pnpm --filter @askdb/server start
```

**`.env.example`** — remove the dev-secret lines entirely. Replace with a comment:

```
# BETTER_AUTH_SECRET and ENCRYPTION_KEY are auto-generated on first run
# and stored in the askdb-data volume at /app/data/.secrets. To rotate,
# stop the container, delete the file, and restart — all existing
# sessions and encrypted connection strings will be invalidated.
```

### 5. Dockerfile

**`Dockerfile`** — add a healthcheck for `docker run` users:

```dockerfile
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3100/api/health >/dev/null || exit 1
```

Add `wget` to the runtime apt install (it's tiny and more reliable than `curl` for healthchecks). Remove `EXPOSE 3001` (already in the unify plan).

### 6. `install.sh`

**`install.sh`** (repo root, published at `https://get.askdb.dev`):

```bash
#!/usr/bin/env bash
set -euo pipefail

INSTALL_DIR=${INSTALL_DIR:-/opt/askdb}
REPO_RAW=https://raw.githubusercontent.com/expatal/dbgate-agent/main

log()  { printf '\033[0;36m[askdb]\033[0m %s\n' "$*"; }
err()  { printf '\033[0;31m[askdb]\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || err "Run as root (or with sudo)."

# 1. OS check
if ! grep -qE 'Ubuntu|Debian' /etc/os-release; then
  err "Only Ubuntu 22.04+ / Debian 12+ are supported right now."
fi

# 2. Docker
if ! command -v docker >/dev/null; then
  log "Installing Docker…"
  curl -fsSL https://get.docker.com | sh
fi
docker compose version >/dev/null 2>&1 || err "Docker Compose plugin missing. Re-run after installing it."

# 3. Collect config
mkdir -p "$INSTALL_DIR"
cd "$INSTALL_DIR"

if [ -f .env ]; then
  log "Existing install detected. Re-using $INSTALL_DIR/.env"
else
  read -rp "Domain (e.g. askdb.example.com), or 'proxyless' / 'tunnel': " DOMAIN_INPUT

  case "$DOMAIN_INPUT" in
    proxyless)
      PROFILE=proxyless
      DOMAIN=localhost
      ACME_EMAIL=unused@example.com
      ;;
    tunnel)
      PROFILE=tunnel
      read -rp "Cloudflare Tunnel token: " CF_TUNNEL_TOKEN
      read -rp "Public hostname configured in the tunnel: " DOMAIN
      ACME_EMAIL=unused@example.com
      ;;
    *)
      PROFILE=caddy
      DOMAIN=$DOMAIN_INPUT
      read -rp "Email for Let's Encrypt (recovery): " ACME_EMAIL
      ;;
  esac

  cat > .env <<EOF
COMPOSE_PROFILES=$PROFILE
DOMAIN=$DOMAIN
ACME_EMAIL=$ACME_EMAIL
${CF_TUNNEL_TOKEN:+CF_TUNNEL_TOKEN=$CF_TUNNEL_TOKEN}
TRUSTED_ORIGINS=https://$DOMAIN
EOF
  chmod 600 .env
fi

# 4. Fetch compose + Caddyfile
curl -fsSL "$REPO_RAW/docker-compose.yml" -o docker-compose.yml
mkdir -p deploy
curl -fsSL "$REPO_RAW/deploy/Caddyfile" -o deploy/Caddyfile

# 5. Start
log "Starting containers…"
docker compose pull
docker compose up -d

# 6. Wait for health
log "Waiting for askdb to be healthy (up to 2 minutes, TLS provision is slow on first run)…"
for i in $(seq 1 120); do
  if docker compose ps askdb --format json | grep -q '"Health":"healthy"'; then
    break
  fi
  sleep 1
done

# 7. Print result
. ./.env
cat <<EOF

  ─────────────────────────────────────────────
  askdb is running.

  Dashboard:  https://$DOMAIN
  MCP URL:    https://$DOMAIN/mcp

  First run?  Open the dashboard to create your admin account.
  Upgrade:    cd $INSTALL_DIR && docker compose pull && docker compose up -d
  Logs:       cd $INSTALL_DIR && docker compose logs -f askdb
  ─────────────────────────────────────────────

EOF
```

Idempotent: re-running it against an existing install upgrades in place. Never touches `/app/data/.secrets`.

### 7. README: rewrite the install section

**`README.md`** — replace the current "Install" / "Quickstart" section with exactly:

```markdown
## Install on a VPS (one command)

On a fresh Ubuntu 22.04+ or Debian 12+ VPS:

    curl -fsSL https://get.askdb.dev | sudo bash

The installer asks for your domain and a Let's Encrypt email, generates
all secrets, and has you running on HTTPS in 2–3 minutes.

### Set up your domain

1. In your DNS provider, add an A record pointing to your VPS IP:
     name:   askdb         (or any subdomain)
     value:  <VPS public IP>
     proxy:  **OFF**       (Cloudflare users: grey cloud, not orange —
                            the orange proxy blocks Let's Encrypt HTTP-01)
2. Verify propagation: `dig +short askdb.example.com`
3. Open ports 80 and 443 on your VPS firewall.
4. Run the installer above.

### Connect Claude or Cursor

Paste `https://<your-domain>/mcp` as a custom connector and approve OAuth
in your browser. No API key needed for remote clients.

### Other install modes

- **Existing reverse proxy (Coolify, Traefik, nginx):** enter `proxyless`
  when the installer asks for a domain. askdb binds 127.0.0.1:3100 and
  you point your proxy at it.
- **Cloudflare Tunnel (no open ports):** enter `tunnel` and paste your
  tunnel token.
- **Local dev (API key, no OAuth):** see [docs/local-dev.md](docs/local-dev.md).
```

---

## Verification at each step

### After step 1–2 (compose + Caddyfile)
```bash
# Caddy profile, local test (use a real domain you own, or override with a fake one and skip TLS)
DOMAIN=localhost ACME_EMAIL=test@example.com \
COMPOSE_PROFILES=proxyless docker compose up -d
curl -s http://127.0.0.1:3100/api/health | jq .   # {ok:true,...}
docker compose down -v
```

### After step 3 (hardening)
```bash
pnpm --filter @askdb/server dev &
# rate limit
for i in {1..35}; do curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3100/register -X POST -d '{}'; done
# expect: first 30 return 400/401, next 5 return 429

# trust proxy
curl -s http://localhost:3100/api/health -H 'X-Forwarded-For: 1.2.3.4'
# expect: no error about forwarded headers, req.ip shows 127.0.0.1 (not 1.2.3.4)

# setup-status
curl -s http://localhost:3100/api/setup-status
# expect: {ok:true}  (NOT {needsSetup:...})

# CSRF: curl POST /authorize without cookie → 403
```

### After step 4 (auto-secrets)
```bash
docker compose run --rm askdb cat /app/data/.secrets
# expect: BETTER_AUTH_SECRET=<64 hex>\nENCRYPTION_KEY=<64 hex>
# re-run: same values (idempotent)
```

### After step 5 (Dockerfile healthcheck)
```bash
docker build -t askdb-test .
docker run -d --name askdb-hc askdb-test
sleep 30
docker inspect askdb-hc --format='{{.State.Health.Status}}'   # "healthy"
docker rm -f askdb-hc
```

### After step 6 (installer)
On a throwaway VPS (Hetzner CX22 / DigitalOcean $4 droplet):
```bash
# from local machine:
scp install.sh root@$VPS:/tmp/
ssh root@$VPS 'DOMAIN=askdb-test.example.com ACME_EMAIL=me@example.com bash /tmp/install.sh'
# then, from local:
curl -s https://askdb-test.example.com/api/health | jq .      # ok
curl -s -X POST https://askdb-test.example.com/mcp            # 401 with WWW-Authenticate
curl -s https://askdb-test.example.com/.well-known/oauth-protected-resource/mcp | jq .
```

Success = all three calls return expected shapes within 2 minutes of `bash install.sh` returning.

### End-to-end
Reconnect Claude's custom connector. Observe in `docker compose logs askdb`:
- Exactly one `registerClient` call
- `authorize → exchangeAuthorizationCode → verifyAccessToken ok → [MCP] Session initialized`
- No retry loops, no 429s on real traffic.

---

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Caddy fails ACME because port 80 is blocked / DNS hasn't propagated. | `install.sh` waits up to 2 minutes for healthcheck; if timeout, prints `docker compose logs caddy` hint and exits non-zero. README explicitly covers "Cloudflare orange cloud" as the top cause. |
| Existing Coolify users upgrade and find Caddy fighting Traefik for port 80. | `proxyless` profile exists *specifically* for them. The `curl \| bash` prompts before touching anything; upgrade path is `docker compose pull` on the same profile. |
| Docker socket mount gives askdb root-equivalent on the host. | Already true today; this plan doesn't change it. Document loudly in README security section. Future work: optional `tecnativa/docker-socket-proxy` opt-in. |
| `get.docker.com` is a large external script the operator didn't explicitly approve. | Installer prompts for y/N before running it, and prints the command it's about to run. Matches Coolify behavior. |
| Auto-generated secrets live in the data volume. If the volume is lost, sessions + encrypted connection strings are unrecoverable. | README "Backups" section: `docker run --rm -v askdb-data:/data alpine tar czf - /data > askdb-backup.tgz`. Standard SQLite backup story. |
| Users run the installer twice and expect a fresh install. | Idempotent by design: `.env` and `.secrets` are preserved. Uninstall requires `docker compose down -v` + `rm -rf /opt/askdb` and is documented. |

---

## Not in scope (again)

Same "parked" list as `unify-mcp-server.md`, plus:

- **Windows / macOS host support.** Docker works, but install.sh is bash-only. Separate PowerShell installer is a future project.
- **Multi-node deployments.** Single VPS only. Scaling the MCP transport requires sticky sessions or DB-backed session state.
- **Automated SQLite backups to S3.** Users do this with `cron` + their preferred tool.
- **First-run dashboard wizard.** Real UX win (would replace "log in" with "create your admin and first connection in one screen"), but orthogonal to deployment. Separate plan.

---

## Commit shape

Three commits, landing after `unify-mcp-server.md` is merged:

1. **`feat(deploy): bundle Caddy sidecar and add compose profiles`**
   Steps 1, 2, 5. Ships the compose/Caddyfile/Dockerfile changes. No code changes in `server/` or `packages/`.

2. **`feat(security): rate-limit OAuth, CSRF on consent, redirect-uri validation, narrow trust proxy, cap sessions, gate setup-status`**
   Step 3. All app-level hardening. One commit because the CSRF, rate limit, and trust-proxy fix interlock — splitting them leaves an intermediate commit with a half-trusted proxy.

3. **`feat(deploy): install.sh, entrypoint secret auto-gen, README rewrite`**
   Steps 4, 6, 7. Ships the installer, auto-secrets, and the rewritten README. After this lands, `curl -fsSL https://get.askdb.dev | sudo bash` is the canonical install instruction.

Publish `install.sh` to a stable URL (`get.askdb.dev` as a Cloudflare Worker or gh-pages) in the same PR as commit 3.
