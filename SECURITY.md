# Security Policy

## Supported versions

Only the latest release receives security fixes. Run `docker compose pull && docker compose up -d` (or re-run `install.sh`) to stay current.

## Reporting a vulnerability

If you discover a security issue in askdb, please report it **privately**. Do not open a public GitHub issue.

**Email:** `security@askdb.dev`

Please include:

- A description of the vulnerability.
- Steps to reproduce (if known).
- Any suggested remediation.
- Your contact info so we can follow up (PGP not required).

We aim to:

- Acknowledge within 3 business days.
- Provide a remediation timeline within 14 days.
- Credit you in the release notes, unless you prefer anonymity.

## Trust model for self-hosted deployments

askdb is designed for self-hosting. **The VPS is the trust boundary.** Anyone with shell access to the host can read the SQLite database, the auto-generated secrets, and the encrypted connection strings (the decryption key is colocated on the same volume).

To reduce blast radius:

- Keep the host OS patched. Limit SSH access to trusted keys.
- Back up the `askdb-data` Docker volume regularly.
- Don't share the VPS with other production workloads.

## Hardening built into the default install

- **TLS at the edge.** The bundled Caddy sidecar provisions Let's Encrypt certificates automatically.
- **Auto-generated secrets.** `BETTER_AUTH_SECRET` and `ENCRYPTION_KEY` are generated with `openssl rand -hex 32` on first boot and stored mode-600 inside the data volume.
- **Docker socket proxy.** The askdb container never has direct access to `/var/run/docker.sock`. A `tecnativa/docker-socket-proxy` sidecar exposes only the API endpoints askdb actually uses (containers, images, networks, minimal info).
- **Tight `trust proxy`.** Restricted to the Docker bridge and loopback CIDRs — not `1` or `true`. Prevents `X-Forwarded-For` spoofing via direct connections to port 3100.
- **OAuth DCR hardening.** Per-path rate limiting on `/authorize`, `/token`, `/register`, `/revoke` (30/min per IP per endpoint). Redirect URI validation rejects non-HTTPS URIs (except `localhost` for local-dev clients), wildcards, and registrations with more than 5 URIs.
- **CSRF on consent.** Double-submit token on the OAuth consent POST.
- **Session cap.** MCP session-transport map is bounded at 1000 per instance; overflow returns a JSON-RPC 429.
- **`/api/setup-status` locked down.** Returns `{"ok":true}` to non-same-origin callers — external probes cannot tell whether an admin account exists.

## Known limitations

- First-admin-wins signup. The first email to register becomes the admin; subsequent signups are rejected. If your domain is reachable before you finish setup, a stranger could claim the admin account. Run the installer from behind a firewall or create the admin immediately after `docker compose up`.
- No built-in backup automation. Use `docker run --rm -v askdb-data:/data alpine tar czf - /data > askdb-backup.tgz` or your own scheduler.
- Encrypted connection strings are decrypted in-memory when the sandbox manager connects to source databases. If askdb's process is dumped, plaintext credentials may be recoverable.
