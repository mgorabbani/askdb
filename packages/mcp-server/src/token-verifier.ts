import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";

import {
  MCP_OAUTH_SUPPORTED_SCOPES,
  db,
  schema,
  hashKey,
  eq,
  and,
  isNull,
  verifyOAuthAccessToken,
} from "@askdb/shared";

const { apiKeys, connections } = schema;

export interface AccessibleConnection {
  id: string;
  name: string;
  description: string | null;
  databaseName: string;
  sandboxPort: number;
  dbType: "mongodb" | "postgresql";
}

export interface AuthContext {
  userId: string;
  apiKeyId: string;
  // Default connection id to use when a tool call omits `connectionId`.
  // For OAuth tokens this is the connection the token was issued for;
  // for API keys it's the first active sandbox (preserves legacy behavior
  // when the user only has one DB connected).
  defaultConnectionId: string;
  connections: AccessibleConnection[];
  authType: "api_key" | "oauth";
  clientId: string;
  scopes: string[];
}

function loadAccessibleConnections(userId: string): AccessibleConnection[] {
  return db
    .select()
    .from(connections)
    .where(eq(connections.userId, userId))
    .all()
    .filter((row) => typeof row.sandboxPort === "number")
    .map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description ?? null,
      databaseName: row.databaseName,
      sandboxPort: row.sandboxPort!,
      dbType: normalizeDbType(row.dbType),
    }));
}

export function normalizeDbType(value: unknown): "mongodb" | "postgresql" {
  switch (value) {
    case "postgresql":
      return "postgresql";
    case "mongodb":
      return "mongodb";
    default:
      return "mongodb";
  }
}

function authenticateApiKeyToken(token: string): AuthContext | null {
  if (!token.startsWith("ask_sk_")) return null;

  const hash = hashKey(token);

  const keyRow = db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.keyHash, hash), isNull(apiKeys.revokedAt)))
    .get();

  if (!keyRow) return null;

  const accessible = loadAccessibleConnections(keyRow.userId);
  if (accessible.length === 0) return null;

  return {
    userId: keyRow.userId,
    apiKeyId: keyRow.id,
    defaultConnectionId: accessible[0]!.id,
    connections: accessible,
    authType: "api_key",
    clientId: `legacy-api-key:${keyRow.id}`,
    scopes: [...MCP_OAUTH_SUPPORTED_SCOPES],
  };
}

export function createMcpTokenVerifier(deps: {
  mcpPublicUrl: URL;
}): OAuthTokenVerifier {
  const { mcpPublicUrl } = deps;

  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      const tokenPrefix = token.slice(0, 10);
      const legacyAuth = authenticateApiKeyToken(token);
      if (legacyAuth) {
        console.log(
          `[mcp] verifyAccessToken api_key prefix=${tokenPrefix} ok user=${legacyAuth.userId} dbs=${legacyAuth.connections.length}`
        );
        return {
          token,
          clientId: legacyAuth.clientId,
          scopes: legacyAuth.scopes,
          expiresAt: 4102444800,
          resource: mcpPublicUrl,
          extra: { ...legacyAuth },
        };
      }

      const verified = verifyOAuthAccessToken(db, token);
      if (!verified) {
        console.warn(`[mcp] verifyAccessToken oauth MISS prefix=${tokenPrefix}`);
        throw new InvalidTokenError("Invalid or expired token");
      }

      // OAuth tokens are issued per-connection, but we still expose all of the
      // user's active sandboxes so multi-DB-aware agents can pivot. The token's
      // original connection stays as the default.
      const accessible = loadAccessibleConnections(verified.userId);
      const primary = accessible.find((c) => c.id === verified.connectionId);

      if (!primary) {
        console.warn(
          `[mcp] verifyAccessToken oauth NO_CONNECTION user=${verified.userId} connectionId=${verified.connectionId}`
        );
        throw new InvalidTokenError(
          "No active sandbox connection found for this token"
        );
      }
      console.log(
        `[mcp] verifyAccessToken oauth ok user=${verified.userId} client=${verified.clientId} resource=${verified.resource}`
      );

      const auth: AuthContext = {
        userId: verified.userId,
        apiKeyId: verified.apiKeyId,
        defaultConnectionId: primary.id,
        connections: accessible,
        authType: "oauth",
        clientId: verified.clientId,
        scopes: verified.scopes,
      };

      return {
        token,
        clientId: verified.clientId,
        scopes: verified.scopes,
        expiresAt: Math.floor(verified.expiresAt.getTime() / 1000),
        resource: new URL(verified.resource),
        extra: { ...auth },
      };
    },
  };
}
