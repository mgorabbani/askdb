# Changelog

All notable changes to askdb are documented here.

This project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **One-command installer (`install.sh`).** Three profiles: `caddy` (auto-TLS), `proxyless` (for Coolify/Traefik/nginx in front), and `tunnel` (Cloudflare Tunnel). Installs Docker if missing (after asking), prompts for domain + email, generates secrets, waits for health, prints MCP URL.
- **Docker socket hardening.** `tecnativa/docker-socket-proxy` sidecar. askdb no longer has direct `/var/run/docker.sock` access; the proxy exposes only the API endpoints askdb actually needs.
- **Auto-generated secrets.** `BETTER_AUTH_SECRET` and `ENCRYPTION_KEY` are generated on first container boot into `/app/data/.secrets` (mode 600). User-provided env vars take precedence.
- **OAuth hardening.** Per-path rate limiting on `/authorize`, `/token`, `/register`, `/revoke` (30/min). CSRF double-submit token on consent POST. Redirect-URI validation for DCR (rejects wildcards, non-HTTPS except localhost, lists >5). MCP session-transport map capped at 1000.
- **Dockerfile `HEALTHCHECK`** on `/api/health`.
- **Community files.** AGPLv3 `LICENSE`, `CODE_OF_CONDUCT.md` (Contributor Covenant 2.1), `CONTRIBUTING.md`, `SECURITY.md`, this `CHANGELOG.md`.

### Changed

- **Unified the MCP server into the main server on port 3100.** No more two-process, two-port deployment. `/mcp` is served by the same Express app as the dashboard and OAuth router. The `packages/mcp-server` workspace is now a library exporting `createMcpRouter` and `createMcpTokenVerifier`.
- **Reverse proxy bundled.** `docker-compose.yml` now includes a Caddy sidecar behind a `caddy` profile (auto-HTTPS). `proxyless` and `tunnel` profiles are available for alternative setups.
- **`trust proxy` narrowed** from `1` to the Docker bridge + loopback CIDR list. Closes a class of spoofable-rate-limit bugs.
- **`/api/setup-status` no longer leaks** whether an admin account exists. Returns `{"ok":true}` to non-same-origin callers.
- **MCP OAuth tokens now carry `resource=${BETTER_AUTH_URL}/mcp`.** Local-dev tokens issued against the old `localhost:3001/mcp` resource will fail validation; clients must re-authorize. API-key auth is unaffected.
- **Installer rewritten.** README's install section is now a single `curl | sudo bash` command plus a 4-step DNS guide.

### Removed

- Standalone `@askdb/mcp-server` process, port 3001, `MCP_PORT` env variable.
- Duplicate OAuth metadata routes.
- Inlined `getOAuthIssuerUrl` / `getMcpPublicUrl` helpers — moved to `@askdb/shared`.
- Traefik path-stripping workarounds.

### Fixed

- `packages/mcp-server/scripts/test-code-mode-e2e.ts` now runs against the unified server (in-process) instead of spawning the deleted standalone.
- Rate-limit cross-endpoint DoS: each OAuth path now has its own 30/min budget instead of sharing one.
- CSRF cookie: `secure` flag now conditional on `BETTER_AUTH_URL` scheme (was unconditionally `true`, which broke local HTTP dev).

### Security

- `install.sh` refuses to run as non-root. OS is validated before doing anything.
- Secrets file is written with `umask 077`.
- `.env.example` no longer ships dev-default secret values.
