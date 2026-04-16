/**
 * Canonical URL helpers shared by @askdb/server and @askdb/mcp-server.
 * Single source of truth — do not duplicate these in other packages.
 */

export function getOAuthIssuerUrl(): URL {
  const raw =
    process.env.MCP_OAUTH_ISSUER_URL ??
    process.env.BETTER_AUTH_URL ??
    `http://localhost:${process.env.PORT ?? "3100"}`;
  const url = new URL(raw);
  return new URL(url.origin);
}

export function getMcpPublicUrl(): URL {
  const configured = process.env.MCP_PUBLIC_URL;
  if (configured) return new URL(configured);

  const base = process.env.BETTER_AUTH_URL
    ? new URL(process.env.BETTER_AUTH_URL)
    : new URL(`http://localhost:${process.env.PORT ?? "3100"}`);

  return new URL("/mcp", base);
}
