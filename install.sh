#!/usr/bin/env bash
#
# askdb installer
#   curl -fsSL https://raw.githubusercontent.com/mgorabbani/askdb/main/install.sh | sudo bash
#
# Pin a release:       sudo ASKDB_VERSION=v1.2.3 bash install.sh
# Non-interactive:     sudo ASKDB_PROFILE=caddy ASKDB_DOMAIN=askdb.example.com ASKDB_ACME_EMAIL=ops@example.com bash install.sh
#
# The entire installer is wrapped in __askdb_install() and only called at the
# very end of the file. That guards against the classic curl|bash failure mode
# where a dropped connection delivers a truncated script and half of it runs.
# bash won't invoke the function until the whole file is parsed.

set -eEuo pipefail

__askdb_install() {
  local INSTALL_DIR ASKDB_VERSION REPO_RAW MIN_COMPOSE
  INSTALL_DIR=${INSTALL_DIR:-/opt/askdb}
  ASKDB_VERSION=${ASKDB_VERSION:-main}
  REPO_RAW=${REPO_RAW:-https://raw.githubusercontent.com/mgorabbani/askdb/${ASKDB_VERSION}}
  MIN_COMPOSE="2.17.0"

  log()  { printf '\033[0;36m[askdb]\033[0m %s\n' "$*"; }
  err()  { printf '\033[0;31m[askdb]\033[0m %s\n' "$*" >&2; exit 1; }

  trap 'err "Install failed at line $LINENO (exit $?). Check output above."' ERR

  log "askdb installer ($ASKDB_VERSION)"

  [ "$(id -u)" -eq 0 ] || err "Run as root (sudo)."

  if [ -f /etc/os-release ]; then
    # shellcheck disable=SC1091
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

  # Compose 2.17+ is required for `--wait`. Ubuntu 22.04+/Debian 12+ with a
  # fresh Docker install via get.docker.com satisfies this. Pinned hosts may not.
  local compose_ver
  compose_ver=$(docker compose version --short 2>/dev/null || echo "0.0.0")
  if ! printf '%s\n%s\n' "$MIN_COMPOSE" "$compose_ver" | sort -V -C; then
    err "Docker Compose $compose_ver is too old (need $MIN_COMPOSE+). Upgrade with: apt update && apt install --only-upgrade docker-compose-plugin"
  fi

  mkdir -p "$INSTALL_DIR"
  cd "$INSTALL_DIR"

  local PROFILE DOMAIN ACME_EMAIL CF_TUNNEL_TOKEN
  if [ ! -f .env ]; then
    PROFILE=${ASKDB_PROFILE:-}
    DOMAIN=${ASKDB_DOMAIN:-}
    ACME_EMAIL=${ASKDB_ACME_EMAIL:-}
    CF_TUNNEL_TOKEN=${ASKDB_CF_TUNNEL_TOKEN:-}

    # When piped (curl | bash), stdin is the script itself — `read` would see EOF.
    # Reattach stdin to the controlling terminal so prompts work. Skip in true
    # non-interactive runs where every value comes from ASKDB_* env vars.
    local needs_tty=0
    if [ -z "$PROFILE" ]; then needs_tty=1; fi
    if [ "$PROFILE" = "caddy" ] && { [ -z "$DOMAIN" ] || [ -z "$ACME_EMAIL" ]; }; then needs_tty=1; fi
    if [ "$PROFILE" = "proxyless" ] && [ -z "$DOMAIN" ]; then needs_tty=1; fi
    if [ "$PROFILE" = "tunnel" ] && { [ -z "$CF_TUNNEL_TOKEN" ] || [ -z "$DOMAIN" ]; }; then needs_tty=1; fi
    if [ "$needs_tty" = "1" ] && [ ! -t 0 ]; then
      if [ -r /dev/tty ]; then
        exec </dev/tty
      else
        err "No terminal available for prompts. Re-run non-interactively with ASKDB_PROFILE / ASKDB_DOMAIN / ASKDB_ACME_EMAIL env vars, or download install.sh first and run: sudo bash install.sh"
      fi
    fi

    if [ -z "$PROFILE" ]; then
      echo ""
      echo "  How would you like to expose askdb?"
      echo "    1) Caddy + automatic HTTPS (needs DNS + ports 80/443)"
      echo "    2) Behind your own reverse proxy (Coolify / Traefik / nginx)"
      echo "    3) Cloudflare Tunnel"
      echo "    4) Quick test: auto HTTPS via nip.io (uses VPS public IP, no DNS setup)"
      local choice
      read -rp "  Choose [1/2/3/4, default 1]: " choice
      case "${choice:-1}" in
        1) PROFILE=caddy ;;
        2) PROFILE=proxyless ;;
        3) PROFILE=tunnel ;;
        4) PROFILE=quicktest ;;
        *) err "Invalid choice." ;;
      esac
    fi

    case "$PROFILE" in
      caddy)
        [ -n "$DOMAIN" ]     || read -rp "  Domain (e.g. askdb.example.com): " DOMAIN
        [ -n "$ACME_EMAIL" ] || read -rp "  Let's Encrypt email: " ACME_EMAIL
        [ -n "$DOMAIN" ] && [ -n "$ACME_EMAIL" ] || err "Domain and email are required."
        ;;
      quicktest)
        log "Detecting public IP..."
        local IP
        IP=$(curl -fsS https://api.ipify.org 2>/dev/null || curl -fsS https://ifconfig.me 2>/dev/null || true)
        [ -n "$IP" ] || err "Could not detect public IP. Use profile 1 with your own domain."
        DOMAIN="${IP//./-}.nip.io"
        ACME_EMAIL=${ACME_EMAIL:-admin@${DOMAIN}}
        PROFILE=caddy
        log "Using hostname: $DOMAIN"
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

  # shellcheck disable=SC1091
  . ./.env

  log "Pulling images..."
  docker compose pull

  log "Starting containers (waiting for healthy state)..."
  # --wait blocks until every service is either running (no healthcheck) or
  # healthy (with healthcheck). Replaces hand-rolled polling loops.
  if ! docker compose up -d --wait --wait-timeout 180 --remove-orphans; then
    err "Stack failed to become healthy within 180s. Check: cd $INSTALL_DIR && docker compose logs"
  fi

  local URL
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
}

__askdb_install "$@"
