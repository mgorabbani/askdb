#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────
# askdb uninstaller
#
# Default (safe): stop containers, keep data volume + .env.
#   sudo bash uninstall.sh
#
# Remove everything (containers, volumes, install dir, images):
#   sudo bash uninstall.sh --purge
#
# Non-interactive:
#   sudo ASKDB_UNATTENDED=1 bash uninstall.sh --purge
#
# Take a backup tarball before removing anything:
#   sudo bash uninstall.sh --purge --backup /root/askdb-backup.tgz
# ─────────────────────────────────────────────────────────────

INSTALL_DIR=${INSTALL_DIR:-/opt/askdb}
DATA_VOLUME=${ASKDB_DATA_VOLUME:-askdb-data}
EXTRA_VOLUMES=(caddy-data caddy-config)
ASKDB_UNATTENDED=${ASKDB_UNATTENDED:-0}

PURGE=0
REMOVE_IMAGES=0
BACKUP_PATH=""

log()  { printf '\033[0;36m[askdb]\033[0m %s\n' "$*"; }
warn() { printf '\033[0;33m[askdb]\033[0m %s\n' "$*" >&2; }
err()  { printf '\033[0;31m[askdb]\033[0m %s\n' "$*" >&2; exit 1; }

usage() {
  sed -n '3,18p' "$0"
  exit 0
}

while [ $# -gt 0 ]; do
  case "$1" in
    --purge)         PURGE=1 ;;
    --remove-images) REMOVE_IMAGES=1 ;;
    --backup)        shift; BACKUP_PATH=${1:-} ;;
    --backup=*)      BACKUP_PATH=${1#--backup=} ;;
    -h|--help)       usage ;;
    *)               err "Unknown flag: $1 (use --help)" ;;
  esac
  shift
done

confirm() {
  local message=$1
  if [ "$ASKDB_UNATTENDED" = "1" ]; then return 0; fi
  read -rp "  $message [y/N] " ans
  case "${ans:-}" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}

if [ "$(id -u)" -ne 0 ]; then
  err "Must run as root. Re-run with sudo."
fi

if [ ! -d "$INSTALL_DIR" ]; then
  warn "No install found at $INSTALL_DIR. Nothing to do."
  exit 0
fi

command -v docker >/dev/null 2>&1 || err "docker not found; cannot proceed."

echo ""
echo "  ────────────────────────────────────────────────────────────"
echo "  askdb uninstaller"
echo "  ────────────────────────────────────────────────────────────"
echo "  Install dir:    $INSTALL_DIR"
echo "  Data volume:    $DATA_VOLUME"
if [ "$PURGE" = "1" ]; then
  echo "  Mode:           PURGE (containers + volumes + install dir)"
  [ "$REMOVE_IMAGES" = "1" ] && echo "                  + docker images"
else
  echo "  Mode:           stop only (data preserved)"
fi
[ -n "$BACKUP_PATH" ] && echo "  Backup to:      $BACKUP_PATH"
echo "  ────────────────────────────────────────────────────────────"
echo ""

if [ "$PURGE" = "1" ] && [ -z "$BACKUP_PATH" ]; then
  warn "Purge mode will DELETE your database and all askdb config."
  confirm "Proceed without a backup?" || err "Aborted. Re-run with --backup /path/to/backup.tgz"
fi

# 1. Optional backup (before anything destructive)
if [ -n "$BACKUP_PATH" ]; then
  log "Backing up volume '$DATA_VOLUME' to $BACKUP_PATH..."
  mkdir -p "$(dirname "$BACKUP_PATH")"
  if docker volume inspect "$DATA_VOLUME" >/dev/null 2>&1; then
    docker run --rm -v "$DATA_VOLUME:/data:ro" -v "$(dirname "$BACKUP_PATH"):/backup" \
      alpine tar czf "/backup/$(basename "$BACKUP_PATH")" -C /data .
    log "Backup written: $BACKUP_PATH"
  else
    warn "Volume '$DATA_VOLUME' not found; skipping backup."
  fi
fi

# 2. Stop containers
cd "$INSTALL_DIR"
if [ -f docker-compose.yml ]; then
  if [ "$PURGE" = "1" ]; then
    log "Stopping containers and removing volumes..."
    docker compose down --volumes --remove-orphans 2>&1 || warn "docker compose down reported errors."
  else
    log "Stopping containers (volumes preserved)..."
    docker compose down --remove-orphans 2>&1 || warn "docker compose down reported errors."
    log "askdb stopped. Data volume '$DATA_VOLUME' is preserved."
    log "Re-start anytime:  cd $INSTALL_DIR && docker compose up -d"
    exit 0
  fi
else
  warn "No docker-compose.yml at $INSTALL_DIR; attempting manual container cleanup."
  docker ps -a --filter "name=askdb" --format '{{.ID}}' | xargs -r docker rm -f
fi

# 3. Purge volumes (in case compose down didn't catch named volumes used by other projects)
for vol in "$DATA_VOLUME" "${EXTRA_VOLUMES[@]}"; do
  if docker volume inspect "$vol" >/dev/null 2>&1; then
    log "Removing volume: $vol"
    docker volume rm "$vol" 2>&1 || warn "Could not remove volume $vol (still in use?)"
  fi
done

# 4. Remove install directory
if confirm "Delete $INSTALL_DIR (compose file, .env, certs)?"; then
  log "Removing $INSTALL_DIR"
  rm -rf "$INSTALL_DIR"
else
  log "Kept $INSTALL_DIR. Remove manually with: rm -rf $INSTALL_DIR"
fi

# 5. Optional: remove images
if [ "$REMOVE_IMAGES" = "1" ]; then
  log "Removing askdb docker images..."
  docker images --format '{{.Repository}}:{{.Tag}}' \
    | grep -E '(^|/)askdb(:|$)|mgorabbani/askdb' \
    | xargs -r docker rmi 2>&1 || warn "Some images could not be removed."
fi

echo ""
log "askdb has been uninstalled."
echo ""
