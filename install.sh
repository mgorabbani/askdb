#!/usr/bin/env bash
set -euo pipefail

# askdb installer
#   curl -fsSL https://raw.githubusercontent.com/mgorabbani/askdb/main/install.sh | sudo bash
#
# Pin a release:       sudo ASKDB_VERSION=v1.2.3 bash install.sh
# Non-interactive:     sudo ASKDB_PROFILE=caddy ASKDB_DOMAIN=askdb.example.com ASKDB_ACME_EMAIL=ops@example.com bash install.sh

INSTALL_DIR=${INSTALL_DIR:-/opt/askdb}
ASKDB_VERSION=${ASKDB_VERSION:-main}
REPO_RAW=${REPO_RAW:-https://raw.githubusercontent.com/mgorabbani/askdb/${ASKDB_VERSION}}

log()  { printf '\033[0;36m[askdb]\033[0m %s\n' "$*"; }
err()  { printf '\033[0;31m[askdb]\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || err "Run as root (sudo)."

if [ -f /etc/os-release ]; then
  . /etc/os-release
  case "${ID:-}" in ubuntu|debian) ;; *) err "Only Ubuntu/Debian supported (detected: ${ID:-unknown})" ;; esac
else
  err "Cannot detect OS."
fi

if ! command -v docker >/dev/null 2>&1; then
  log "Installing Docker via get.docker.com..."
  curl -fsSL https://get.docker.com | sh
fi
docker compose version >/dev/null 2>&1 || err "Docker Compose plugin missing. Run: apt install docker-compose-plugin"

mkdir -p "$INSTALL_DIR"
cd "$INSTALL_DIR"

if [ ! -f .env ]; then
  PROFILE=${ASKDB_PROFILE:-}
  DOMAIN=${ASKDB_DOMAIN:-}
  ACME_EMAIL=${ASKDB_ACME_EMAIL:-}
  CF_TUNNEL_TOKEN=${ASKDB_CF_TUNNEL_TOKEN:-}

  if [ -z "$PROFILE" ]; then
    echo ""
    echo "  How would you like to expose askdb?"
    echo "    1) Caddy + automatic HTTPS (needs DNS + ports 80/443)"
    echo "    2) Behind your own reverse proxy (Coolify / Traefik / nginx)"
    echo "    3) Cloudflare Tunnel"
    read -rp "  Choose [1/2/3, default 1]: " choice
    case "${choice:-1}" in
      1) PROFILE=caddy ;;
      2) PROFILE=proxyless ;;
      3) PROFILE=tunnel ;;
      *) err "Invalid choice." ;;
    esac
  fi

  case "$PROFILE" in
    caddy)
      [ -n "$DOMAIN" ]     || read -rp "  Domain (e.g. askdb.example.com): " DOMAIN
      [ -n "$ACME_EMAIL" ] || read -rp "  Let's Encrypt email: " ACME_EMAIL
      [ -n "$DOMAIN" ] && [ -n "$ACME_EMAIL" ] || err "Domain and email are required."
      ;;
    proxyless)
      [ -n "$DOMAIN" ] || read -rp "  Hostname your proxy serves [localhost]: " DOMAIN
      DOMAIN=${DOMAIN:-localhost}
      ACME_EMAIL=unused@example.com
      ;;
    tunnel)
      [ -n "$CF_TUNNEL_TOKEN" ] || read -rp "  Cloudflare Tunnel token: " CF_TUNNEL_TOKEN
      [ -n "$DOMAIN" ]          || read -rp "  Public hostname configured in the tunnel: " DOMAIN
      [ -n "$CF_TUNNEL_TOKEN" ] && [ -n "$DOMAIN" ] || err "Tunnel token and hostname are required."
      ACME_EMAIL=unused@example.com
      ;;
    *) err "Invalid ASKDB_PROFILE: $PROFILE" ;;
  esac

  umask 077
  {
    echo "COMPOSE_PROFILES=$PROFILE"
    echo "DOMAIN=$DOMAIN"
    echo "ACME_EMAIL=$ACME_EMAIL"
    [ -n "$CF_TUNNEL_TOKEN" ] && echo "CF_TUNNEL_TOKEN=$CF_TUNNEL_TOKEN"
    case "$PROFILE" in
      caddy|tunnel)
        echo "BETTER_AUTH_URL=https://$DOMAIN"
        echo "TRUSTED_ORIGINS=https://$DOMAIN"
        ;;
      proxyless)
        echo "BETTER_AUTH_URL=http://$DOMAIN:3100"
        echo "TRUSTED_ORIGINS=http://$DOMAIN:3100,https://$DOMAIN"
        ;;
    esac
  } > .env
fi

log "Fetching docker-compose.yml and Caddyfile ($ASKDB_VERSION)..."
curl -fsSL "$REPO_RAW/docker-compose.yml" -o docker-compose.yml
mkdir -p deploy
curl -fsSL "$REPO_RAW/deploy/Caddyfile" -o deploy/Caddyfile

log "Starting containers..."
docker compose pull
docker compose up -d --remove-orphans

log "Waiting for askdb to become healthy..."
for _ in $(seq 1 120); do
  status=$(docker compose ps --format '{{.Name}} {{.Health}}' 2>/dev/null | awk '/askdb[^-]/ {print $2}' | head -1)
  [ "$status" = "healthy" ] && break
  sleep 1
done
[ "$status" = "healthy" ] || err "askdb did not become healthy. Check: docker compose logs askdb"

. ./.env
if [ "${COMPOSE_PROFILES:-}" = "proxyless" ]; then
  URL="http://127.0.0.1:3100"
else
  URL="https://$DOMAIN"
fi

cat <<EOF

  ────────────────────────────────────────────────────────────
  askdb is running.

  Dashboard:  $URL
  MCP URL:    $URL/mcp

  Upgrade:    sudo bash <(curl -fsSL $REPO_RAW/install.sh)
  Logs:       cd $INSTALL_DIR && docker compose logs -f askdb
  Uninstall:  sudo bash <(curl -fsSL $REPO_RAW/uninstall.sh)

  Data lives in the 'askdb-data' docker volume.
  ────────────────────────────────────────────────────────────

EOF
