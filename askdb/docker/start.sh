#!/bin/sh
set -e

echo "Starting askdb..."

# Ensure data directory exists
mkdir -p /app/data

# Trap signals to shut down both processes cleanly
cleanup() {
  echo "Shutting down..."
  kill "$MCP_PID" 2>/dev/null || true
  kill "$NEXT_PID" 2>/dev/null || true
  wait "$MCP_PID" 2>/dev/null || true
  wait "$NEXT_PID" 2>/dev/null || true
  exit 0
}
trap cleanup TERM INT

# Start MCP server in background
echo "Starting MCP server on port 3001..."
node_modules/.bin/tsx src/mcp/server.ts &
MCP_PID=$!

# Start Next.js in background (so we can wait on both)
echo "Starting Next.js on port 3000..."
node_modules/.bin/next start &
NEXT_PID=$!

# Wait for both — if either exits, clean up
wait "$MCP_PID" "$NEXT_PID"
cleanup
