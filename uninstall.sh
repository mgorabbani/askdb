#!/usr/bin/env bash
set -euo pipefail

# askdb uninstaller
#   sudo bash uninstall.sh            # stop containers, keep data
#   sudo bash uninstall.sh --purge    # also remove volumes + install dir

INSTALL_DIR=${INSTALL_DIR:-/opt/askdb}
PURGE=0
[ "${1:-}" = "--purge" ] && PURGE=1

log() { printf '\033[0;36m[askdb]\033[0m %s\n' "$*"; }
err() { printf '\033[0;31m[askdb]\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || err "Run as root (sudo)."
[ -d "$INSTALL_DIR" ] || { log "Nothing to uninstall at $INSTALL_DIR."; exit 0; }
command -v docker >/dev/null 2>&1 || err "docker not found."

cd "$INSTALL_DIR"

if [ "$PURGE" -eq 1 ]; then
  read -rp "This will DELETE askdb data. Continue? [y/N] " ans
  case "${ans:-}" in y|Y|yes|YES) ;; *) err "Aborted." ;; esac
  log "Stopping containers and removing volumes..."
  docker compose down --volumes --remove-orphans || true
  log "Removing $INSTALL_DIR"
  rm -rf "$INSTALL_DIR"
  log "askdb removed."
else
  log "Stopping containers (data preserved)..."
  docker compose down --remove-orphans || true
  log "Restart with: cd $INSTALL_DIR && docker compose up -d"
fi
