# Agent Guidelines

## Environment

- Use **pnpm** for everything
- Node.js 22+
- Use latest stable versions of all libraries

## How to Run

```bash
pnpm install
pnpm dev          # starts server + vite dev middleware on http://localhost:3100
pnpm build        # production build
```

Requires Docker running for sandbox containers.

## Project Structure

```
server/         → Express API + MCP server (src/index.ts)
ui/             → React dashboard (Vite + TypeScript)
packages/
  shared/       → DB schema (Drizzle/SQLite), adapters, sync logic, memory system
  mcp-server/   → MCP protocol tools
cli/            → CLI entry point
```

## Code Style

- Comments explain **why**, not **what**
- Don't add comments on self-explaining code
- Follow existing patterns in the codebase
- Keep it concise — no boilerplate, no over-abstraction
