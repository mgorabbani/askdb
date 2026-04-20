#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────
# askdb installer
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/mgorabbani/askdb/main/install.sh | sudo bash
#
# Non-interactive install (CI / automation):
#   sudo ASKDB_UNATTENDED=1 \
#        ASKDB_PROFILE=caddy \
#        ASKDB_DOMAIN=askdb.example.com \
#        ASKDB_ACME_EMAIL=ops@example.com \
#        bash install.sh
#
# Pin to a specific release:
#   sudo ASKDB_VERSION=v1.2.3 bash install.sh
# ─────────────────────────────────────────────────────────────

INSTALL_DIR=${INSTALL_DIR:-/opt/askdb}
LOG_FILE=${ASKDB_LOG_FILE:-/var/log/askdb-install.log}

# Version/ref to fetch compose + Caddyfile from. Override with ASKDB_VERSION.
# Defaults to `main` until the first tagged release is cut.
ASKDB_VERSION=${ASKDB_VERSION:-main}
REPO_RAW=${REPO_RAW:-https://raw.githubusercontent.com/mgorabbani/askdb/${ASKDB_VERSION}}

# Unattended mode: fail instead of prompting.
ASKDB_UNATTENDED=${ASKDB_UNATTENDED:-0}
ASKDB_PROFILE=${ASKDB_PROFILE:-}
ASKDB_DOMAIN=${ASKDB_DOMAIN:-}
ASKDB_ACME_EMAIL=${ASKDB_ACME_EMAIL:-}
ASKDB_CF_TUNNEL_TOKEN=${ASKDB_CF_TUNNEL_TOKEN:-}

# Preflight thresholds
MIN_DISK_MB=${ASKDB_MIN_DISK_MB:-2048}
MIN_MEM_MB=${ASKDB_MIN_MEM_MB:-1024}

log()  { printf '\033[0;36m[askdb]\033[0m %s\n' "$*" | tee -a "$LOG_FILE"; }
warn() { printf '\033[0;33m[askdb]\033[0m %s\n' "$*" | tee -a "$LOG_FILE" >&2; }
err()  { printf '\033[0;31m[askdb]\033[0m %s\n' "$*" | tee -a "$LOG_FILE" >&2; exit 1; }

# Hardened curl: require HTTPS + TLS 1.2+, fail on HTTP errors, follow redirects.
fetch() { curl --proto '=https' --tlsv1.2 -fsSL "$@"; }

# Prompt helper that respects unattended mode.
prompt() {
  local var=$1 message=$2 default=${3:-} required=${4:-0}
  local current=${!var:-}
  if [ -n "$current" ]; then return 0; fi
  if [ "$ASKDB_UNATTENDED" = "1" ]; then
    if [ -n "$default" ]; then
      printf -v "$var" '%s' "$default"
      return 0
    fi
    [ "$required" = "1" ] && err "Unattended mode: $var is required but not set."
    return 0
  fi
  local ans
  if [ -n "$default" ]; then
    read -rp "  $message [$default]: " ans
    printf -v "$var" '%s' "${ans:-$default}"
  else
    read -rp "  $message: " ans
    printf -v "$var" '%s' "$ans"
  fi
  if [ "$required" = "1" ] && [ -z "${!var}" ]; then err "$message is required."; fi
}

on_error() {
  local exit_code=$?
  warn "Install failed (exit $exit_code). Last 50 log lines:"
  tail -n 50 "$LOG_FILE" >&2 || true
  warn "Full log: $LOG_FILE"
  if command -v docker >/dev/null 2>&1 && [ -d "$INSTALL_DIR" ]; then
    warn "Recent container logs:"
    (cd "$INSTALL_DIR" && docker compose logs --tail 30 2>&1 | tee -a "$LOG_FILE" >&2) || true
  fi
  exit "$exit_code"
}

# Ensure log dir exists before tee redirection kicks in.
mkdir -p "$(dirname "$LOG_FILE")" 2>/dev/null || LOG_FILE=/tmp/askdb-install.log
: > "$LOG_FILE" 2>/dev/null || LOG_FILE=/tmp/askdb-install.log
trap on_error ERR

log "askdb installer — version ref: $ASKDB_VERSION"

# 1. Privilege check
if [ "$(id -u)" -ne 0 ]; then
  err "This installer must run as root. Re-run with sudo."
fi

# 2. OS + arch check
if [ ! -f /etc/os-release ]; then
  err "Cannot detect OS; /etc/os-release not found."
fi
# shellcheck disable=SC1091
. /etc/os-release
case "${ID:-}" in
  ubuntu|debian) : ;;
  *) err "Only Ubuntu 22.04+ and Debian 12+ are supported. Detected: ${ID:-unknown}" ;;
esac

ARCH=$(uname -m)
case "$ARCH" in
  x86_64|aarch64|arm64) : ;;
  *) err "Unsupported architecture: $ARCH (need x86_64 or aarch64)" ;;
esac

# 3. Preflight: disk, memory, tools, network, ports
command -v curl >/dev/null 2>&1 || err "curl is required. Install with: apt-get install -y curl"

free_mb=$(df -Pm "$(dirname "$INSTALL_DIR")" 2>/dev/null | awk 'NR==2 {print $4}')
if [ -n "${free_mb:-}" ] && [ "$free_mb" -lt "$MIN_DISK_MB" ]; then
  err "Need at least ${MIN_DISK_MB}MB free on $(dirname "$INSTALL_DIR"); have ${free_mb}MB."
fi

mem_mb=$(awk '/MemTotal/ {printf "%d", $2/1024}' /proc/meminfo 2>/dev/null || echo 0)
if [ "$mem_mb" -gt 0 ] && [ "$mem_mb" -lt "$MIN_MEM_MB" ]; then
  warn "Only ${mem_mb}MB RAM detected (recommended: ${MIN_MEM_MB}MB+). Continuing."
fi

if ! fetch -o /dev/null -I https://registry-1.docker.io/v2/ 2>/dev/null; then
  warn "Could not reach registry-1.docker.io; image pulls may fail."
fi

port_in_use() { ss -ltnH 2>/dev/null | awk '{print $4}' | grep -Eq "[:.]$1\$"; }

# 4. Docker
if ! command -v docker >/dev/null 2>&1; then
  log "Docker is not installed. Will install via get.docker.com (requires network access)."
  if [ "$ASKDB_UNATTENDED" = "1" ]; then
    ans=y
  else
    read -rp "  Continue? [y/N] " ans
  fi
  case "${ans:-}" in
    y|Y|yes|YES) fetch https://get.docker.com | sh 2>&1 | tee -a "$LOG_FILE" ;;
    *) err "Docker install declined. Please install Docker manually and re-run." ;;
  esac
fi
if ! docker compose version >/dev/null 2>&1; then
  err "Docker Compose plugin missing. On Debian/Ubuntu: apt install docker-compose-plugin"
fi

# 5. Install dir + config
mkdir -p "$INSTALL_DIR"
cd "$INSTALL_DIR"

PROFILE=caddy
DOMAIN=localhost
ACME_EMAIL=unused@example.com
CF_TUNNEL_TOKEN=

if [ -f .env ]; then
  log "Existing install detected at $INSTALL_DIR — reusing .env (backup: .env.bak)"
  cp -a .env .env.bak
  # shellcheck disable=SC1091
  . ./.env
else
  if [ -n "$ASKDB_PROFILE" ]; then
    PROFILE=$ASKDB_PROFILE
    DOMAIN=${ASKDB_DOMAIN:-$DOMAIN}
    ACME_EMAIL=${ASKDB_ACME_EMAIL:-$ACME_EMAIL}
    CF_TUNNEL_TOKEN=${ASKDB_CF_TUNNEL_TOKEN:-}
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
    if [ "$ASKDB_UNATTENDED" = "1" ]; then
      err "Unattended mode: set ASKDB_PROFILE=caddy|proxyless|tunnel."
    fi
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
      prompt DOMAIN "Domain (e.g. askdb.example.com)" "" 1
      prompt ACME_EMAIL "Email for Let's Encrypt (recovery notices)" "" 1
      for p in 80 443; do
        port_in_use "$p" && warn "Port $p is already in use — Caddy may fail to bind."
      done
      ;;
    proxyless)
      prompt DOMAIN "Hostname your proxy serves (default localhost)" "localhost" 0
      ACME_EMAIL=unused@example.com
      ;;
    tunnel)
      prompt CF_TUNNEL_TOKEN "Cloudflare Tunnel token" "" 1
      prompt DOMAIN "Public hostname configured in the tunnel" "" 1
      ACME_EMAIL=unused@example.com
      ;;
    *) err "Invalid ASKDB_PROFILE: $PROFILE (expected caddy|proxyless|tunnel)" ;;
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

# 6. Fetch compose + Caddyfile (always, to upgrade in place)
log "Fetching docker-compose.yml and Caddyfile from $ASKDB_VERSION..."
fetch "$REPO_RAW/docker-compose.yml" -o docker-compose.yml.new
mv docker-compose.yml.new docker-compose.yml
mkdir -p deploy
fetch "$REPO_RAW/deploy/Caddyfile" -o deploy/Caddyfile.new
mv deploy/Caddyfile.new deploy/Caddyfile

# 7. Start
log "Pulling images..."
docker compose pull 2>&1 | tee -a "$LOG_FILE"
log "Starting containers..."
docker compose up -d --remove-orphans 2>&1 | tee -a "$LOG_FILE"

# 8. Wait for health
log "Waiting for askdb to become healthy (TLS provisioning on first run can take ~60s)..."
HEALTHY=0
for _ in $(seq 1 120); do
  status=$(docker compose ps --format '{{.Name}} {{.Health}}' 2>/dev/null | awk '/askdb[^-]/ {print $2}' | head -1)
  if [ "$status" = "healthy" ]; then
    HEALTHY=1
    break
  fi
  sleep 1
done

if [ "$HEALTHY" -ne 1 ]; then
  warn "askdb did not become healthy within 2 minutes."
  warn "Check: cd $INSTALL_DIR && docker compose logs askdb"
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
  Uninstall:  sudo bash <(curl -fsSL $REPO_RAW/uninstall.sh) --purge --backup /root/askdb-backup.tgz
  Install log: $LOG_FILE

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
  Uninstall:  sudo bash <(curl -fsSL $REPO_RAW/uninstall.sh) --purge --backup /root/askdb-backup.tgz
  Install log: $LOG_FILE

  Your data lives in the docker volume 'askdb-data' — back it up with:
    docker run --rm -v askdb-data:/data alpine tar czf - /data > askdb-backup.tgz
  ────────────────────────────────────────────────────────────

EOF
fi
