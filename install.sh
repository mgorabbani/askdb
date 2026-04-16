#!/usr/bin/env bash
set -euo pipefail

INSTALL_DIR=${INSTALL_DIR:-/opt/askdb}
# TODO: pin to a specific tag on release. Using main for now.
REPO_RAW=${REPO_RAW:-https://raw.githubusercontent.com/mgorabbani/askdb/main}

log()  { printf '\033[0;36m[askdb]\033[0m %s\n' "$*"; }
warn() { printf '\033[0;33m[askdb]\033[0m %s\n' "$*" >&2; }
err()  { printf '\033[0;31m[askdb]\033[0m %s\n' "$*" >&2; exit 1; }

# 1. Privilege check
if [ "$(id -u)" -ne 0 ]; then
  err "This installer must run as root. Re-run with sudo."
fi

# 2. OS check
if [ -f /etc/os-release ]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  case "$ID" in
    ubuntu|debian) : ;;
    *) err "Only Ubuntu 22.04+ and Debian 12+ are supported. Detected: $ID" ;;
  esac
else
  err "Cannot detect OS; /etc/os-release not found."
fi

# 3. Docker
if ! command -v docker >/dev/null 2>&1; then
  log "Docker is not installed. Installing via get.docker.com (requires network access)..."
  read -rp "Continue? [y/N] " ans
  case "${ans:-}" in
    y|Y|yes|YES) curl -fsSL https://get.docker.com | sh ;;
    *) err "Docker install declined. Please install Docker manually and re-run." ;;
  esac
fi
if ! docker compose version >/dev/null 2>&1; then
  err "Docker Compose plugin missing. On Debian/Ubuntu: apt install docker-compose-plugin"
fi

# 4. Install dir + config
mkdir -p "$INSTALL_DIR"
cd "$INSTALL_DIR"

PROFILE=caddy
DOMAIN=localhost
ACME_EMAIL=unused@example.com
CF_TUNNEL_TOKEN=

if [ -f .env ]; then
  log "Existing install detected at $INSTALL_DIR — reusing .env"
  # shellcheck disable=SC1091
  . ./.env
else
  echo ""
  echo "  ────────────────────────────────────────────────────────────"
  echo "  askdb self-hosted installer"
  echo "  ────────────────────────────────────────────────────────────"
  echo ""
  echo "  How would you like to expose askdb?"
  echo ""
  echo "  1) Automatic HTTPS via Caddy (recommended, needs DNS + ports 80/443)"
  echo "  2) Behind your own reverse proxy (Coolify / Traefik / nginx)"
  echo "  3) Cloudflare Tunnel (no open ports)"
  echo ""
  read -rp "  Choose [1/2/3, default 1]: " choice
  case "${choice:-1}" in
    1)
      PROFILE=caddy
      read -rp "  Domain (e.g. askdb.example.com): " DOMAIN
      [ -z "$DOMAIN" ] && err "Domain is required."
      read -rp "  Email for Let's Encrypt (recovery notices): " ACME_EMAIL
      [ -z "$ACME_EMAIL" ] && err "Email is required."
      ;;
    2)
      PROFILE=proxyless
      ACME_EMAIL=unused@example.com
      read -rp "  Hostname your proxy serves (e.g. askdb.example.com, or localhost): " DOMAIN_INPUT
      DOMAIN=${DOMAIN_INPUT:-localhost}
      ;;
    3)
      PROFILE=tunnel
      read -rp "  Cloudflare Tunnel token: " CF_TUNNEL_TOKEN
      [ -z "$CF_TUNNEL_TOKEN" ] && err "Tunnel token is required."
      read -rp "  Public hostname configured in the tunnel: " DOMAIN
      [ -z "$DOMAIN" ] && err "Hostname is required."
      ACME_EMAIL=unused@example.com
      ;;
    *) err "Invalid choice." ;;
  esac

  umask 077
  {
    echo "COMPOSE_PROFILES=$PROFILE"
    echo "DOMAIN=$DOMAIN"
    echo "ACME_EMAIL=$ACME_EMAIL"
    [ -n "${CF_TUNNEL_TOKEN:-}" ] && echo "CF_TUNNEL_TOKEN=$CF_TUNNEL_TOKEN"
    # BETTER_AUTH_URL must match the origin the browser actually uses.
    # The /api/setup-status same-origin check compares against this.
    case "$PROFILE" in
      caddy|tunnel)
        echo "BETTER_AUTH_URL=https://$DOMAIN"
        echo "TRUSTED_ORIGINS=https://$DOMAIN"
        ;;
      proxyless)
        # User's reverse proxy decides the external scheme/host;
        # default to http://<host>:3100 which matches the loopback binding.
        echo "BETTER_AUTH_URL=http://$DOMAIN:3100"
        echo "TRUSTED_ORIGINS=http://$DOMAIN:3100,https://$DOMAIN"
        ;;
    esac
  } > .env
fi

# 5. Fetch compose + Caddyfile (always, to upgrade in place)
log "Fetching latest docker-compose.yml and Caddyfile..."
curl -fsSL "$REPO_RAW/docker-compose.yml" -o docker-compose.yml
mkdir -p deploy
curl -fsSL "$REPO_RAW/deploy/Caddyfile" -o deploy/Caddyfile

# 6. Start
log "Starting containers..."
docker compose pull
docker compose up -d

# 7. Wait for health
log "Waiting for askdb to become healthy (TLS provisioning on first run can take ~60s)..."
HEALTHY=0
for i in $(seq 1 120); do
  status=$(docker compose ps --format '{{.Name}} {{.Health}}' 2>/dev/null | awk '/askdb[^-]/ {print $2}' | head -1)
  if [ "$status" = "healthy" ]; then
    HEALTHY=1
    break
  fi
  sleep 1
done

if [ "$HEALTHY" -ne 1 ]; then
  warn "askdb did not become healthy within 2 minutes."
  warn "Check: docker compose logs askdb"
  exit 1
fi

# re-load in case .env existed before this run
# shellcheck disable=SC1091
. ./.env

if [ "${PROFILE:-caddy}" = "proxyless" ]; then
  cat <<EOF

  ────────────────────────────────────────────────────────────
  askdb is running.

  Internal endpoint: http://127.0.0.1:3100/mcp
  Point your reverse proxy at http://127.0.0.1:3100

  First run?  Open the dashboard URL to create your admin account.
  Upgrade:    cd $INSTALL_DIR && sudo bash <(curl -fsSL $REPO_RAW/install.sh)
  Logs:       cd $INSTALL_DIR && docker compose logs -f askdb
  Stop:       cd $INSTALL_DIR && docker compose down

  Your data lives in the docker volume 'askdb-data' — back it up with:
    docker run --rm -v askdb-data:/data alpine tar czf - /data > askdb-backup.tgz
  ────────────────────────────────────────────────────────────

EOF
else
  cat <<EOF

  ────────────────────────────────────────────────────────────
  askdb is running.

  Dashboard:  https://$DOMAIN
  MCP URL:    https://$DOMAIN/mcp

  First run?  Open the dashboard URL to create your admin account.
  Upgrade:    cd $INSTALL_DIR && sudo bash <(curl -fsSL $REPO_RAW/install.sh)
  Logs:       cd $INSTALL_DIR && docker compose logs -f askdb
  Stop:       cd $INSTALL_DIR && docker compose down

  Your data lives in the docker volume 'askdb-data' — back it up with:
    docker run --rm -v askdb-data:/data alpine tar czf - /data > askdb-backup.tgz
  ────────────────────────────────────────────────────────────

EOF
fi
