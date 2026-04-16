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

# Load secrets from file, but don't clobber env vars the user explicitly set.
while IFS='=' read -r key value; do
  [ -z "${key:-}" ] && continue
  [[ "$key" =~ ^# ]] && continue
  # Only export if not already set in the environment
  if [ -z "${!key:-}" ]; then
    export "$key=$value"
  fi
done < "$SECRETS_FILE"

exec pnpm --filter @askdb/server start
