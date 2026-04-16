#!/usr/bin/env bash
set -euo pipefail
mkdir -p /app/data
exec pnpm --filter @askdb/server start
