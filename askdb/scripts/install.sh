#!/bin/sh
set -e

# ── Banner ───────────────────────────────────────────────────────────
echo ""
echo "  ╔══════════════════════════════════════╗"
echo "  ║         Installing askdb             ║"
echo "  ║   Self-hosted database explorer      ║"
echo "  ╚══════════════════════════════════════╝"
echo ""

# ── OS check ─────────────────────────────────────────────────────────
OS="$(uname -s)"
case "$OS" in
  Linux|Darwin) ;;
  *)
    echo "Error: Unsupported operating system: $OS"
    echo "askdb supports Linux and macOS only."
    exit 1
    ;;
esac
echo "[ok] Operating system: $OS"

# ── Docker check ─────────────────────────────────────────────────────
if ! command -v docker >/dev/null 2>&1; then
  echo ""
  echo "Error: Docker is not installed."
  echo ""
  echo "Install Docker:"
  echo "  Linux:  curl -fsSL https://get.docker.com | sh"
  echo "  macOS:  https://docs.docker.com/desktop/install/mac-install/"
  echo ""
  exit 1
fi
echo "[ok] Docker found: $(docker --version)"

# ── Docker Compose check ────────────────────────────────────────────
if docker compose version >/dev/null 2>&1; then
  COMPOSE_CMD="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE_CMD="docker-compose"
else
  echo ""
  echo "Error: Docker Compose is not installed."
  echo ""
  echo "Docker Compose is included with Docker Desktop."
  echo "For Linux standalone: https://docs.docker.com/compose/install/linux/"
  echo ""
  exit 1
fi
echo "[ok] Docker Compose found: $($COMPOSE_CMD version 2>/dev/null || echo 'available')"

# ── Determine install directory ──────────────────────────────────────
INSTALL_DIR="${ASKDB_INSTALL_DIR:-$PWD/askdb}"

if [ ! -d "$INSTALL_DIR" ]; then
  echo ""
  echo "Cloning askdb..."
  git clone https://github.com/expatal/askdb.git "$INSTALL_DIR"
fi

cd "$INSTALL_DIR"
echo "[ok] Install directory: $INSTALL_DIR"

# ── Generate secrets ─────────────────────────────────────────────────
generate_hex() {
  # Generate N random hex characters
  LENGTH=$1
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex $((LENGTH / 2))
  elif [ -r /dev/urandom ]; then
    head -c $((LENGTH / 2)) /dev/urandom | od -An -tx1 | tr -d ' \n' | head -c "$LENGTH"
  else
    echo "Error: Cannot generate random bytes. Install openssl." >&2
    exit 1
  fi
}

detect_public_ip() {
  # Try multiple services
  IP=""
  for URL in "https://ifconfig.me" "https://api.ipify.org" "https://icanhazip.com"; do
    IP=$(curl -sf --max-time 5 "$URL" 2>/dev/null | tr -d '[:space:]') && break
  done
  if [ -z "$IP" ]; then
    IP="localhost"
  fi
  echo "$IP"
}

# ── Write .env file ─────────────────────────────────────────────────
if [ -f ".env" ]; then
  echo ""
  echo "[info] .env file already exists — keeping existing configuration."
  echo "       To regenerate, delete .env and re-run this script."
else
  echo ""
  echo "Generating secrets..."

  BETTER_AUTH_SECRET=$(generate_hex 64)
  ENCRYPTION_KEY=$(generate_hex 64)

  echo "Detecting public IP..."
  PUBLIC_IP=$(detect_public_ip)
  BETTER_AUTH_URL="http://${PUBLIC_IP}:3000"

  cat > .env <<ENVEOF
# Better Auth
BETTER_AUTH_SECRET=${BETTER_AUTH_SECRET}
BETTER_AUTH_URL=${BETTER_AUTH_URL}

# Encryption (for MongoDB connection strings)
ENCRYPTION_KEY=${ENCRYPTION_KEY}

# Database
DATABASE_PATH=./data/askdb.db
ENVEOF

  echo "[ok] .env file created"
  echo "     BETTER_AUTH_URL=${BETTER_AUTH_URL}"
fi

# ── Create data directory ────────────────────────────────────────────
mkdir -p data
echo "[ok] data/ directory ready"

# ── Build and start ─────────────────────────────────────────────────
echo ""
echo "Building and starting containers..."
$COMPOSE_CMD up -d --build

# ── Health check ─────────────────────────────────────────────────────
echo ""
echo "Waiting for askdb to start..."

ATTEMPTS=0
MAX_ATTEMPTS=30
while [ $ATTEMPTS -lt $MAX_ATTEMPTS ]; do
  if curl -sf http://localhost:3000 >/dev/null 2>&1; then
    break
  fi
  ATTEMPTS=$((ATTEMPTS + 1))
  printf "."
  sleep 1
done
echo ""

if [ $ATTEMPTS -lt $MAX_ATTEMPTS ]; then
  # Read the URL from .env
  APP_URL=$(grep BETTER_AUTH_URL .env | cut -d= -f2)

  echo ""
  echo "  ╔══════════════════════════════════════╗"
  echo "  ║       askdb is running!              ║"
  echo "  ╠══════════════════════════════════════╣"
  echo "  ║                                      ║"
  echo "  ║  Dashboard: ${APP_URL}"
  echo "  ║  MCP:       http://localhost:3001     ║"
  echo "  ║                                      ║"
  echo "  ║  Logs: docker compose logs -f        ║"
  echo "  ║  Stop: docker compose down           ║"
  echo "  ║                                      ║"
  echo "  ╚══════════════════════════════════════╝"
  echo ""
else
  echo ""
  echo "Warning: askdb did not respond within 30 seconds."
  echo "Check logs: $COMPOSE_CMD logs -f"
  echo ""
  exit 1
fi
