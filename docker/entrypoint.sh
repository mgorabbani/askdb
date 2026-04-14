#!/usr/bin/env bash
# askdb runtime entrypoint — spawns server (with embedded UI) and mcp-server.
# Exits non-zero if either child dies, so the container restarts as a unit.
set -euo pipefail

cleanup() {
  trap - TERM INT
  if [[ -n "${SERVER_PID:-}" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill -TERM "$SERVER_PID" 2>/dev/null || true
  fi
  if [[ -n "${MCP_PID:-}" ]] && kill -0 "$MCP_PID" 2>/dev/null; then
    kill -TERM "$MCP_PID" 2>/dev/null || true
  fi
  wait || true
}
trap cleanup TERM INT

mkdir -p /app/data

pnpm --filter @askdb/server start &
SERVER_PID=$!

pnpm --filter @askdb/mcp-server start &
MCP_PID=$!

# Wait for either child to exit, then propagate.
wait -n "$SERVER_PID" "$MCP_PID"
EXIT_CODE=$?
cleanup
exit "$EXIT_CODE"
