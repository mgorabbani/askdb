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

export interface AuthContext {
  userId: string;
  apiKeyId: string;
  connectionId: string;
  sandboxPort: number;
  authType: "api_key" | "oauth";
  clientId: string;
  scopes: string[];
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

  const conn = db
    .select()
    .from(connections)
    .where(eq(connections.userId, keyRow.userId))
    .all()
    .find((row) => typeof row.sandboxPort === "number");

  if (!conn || !conn.sandboxPort) {
    return null;
  }

  return {
    userId: keyRow.userId,
    apiKeyId: keyRow.id,
    connectionId: conn.id,
    sandboxPort: conn.sandboxPort,
    authType: "api_key",
    clientId: `legacy-api-key:${keyRow.id}`,
    scopes: [...MCP_OAUTH_SUPPORTED_SCOPES],
  };
}

function getConnectionContext(connectionId: string) {
  const conn = db
    .select()
    .from(connections)
    .where(eq(connections.id, connectionId))
    .get();

  if (!conn || !conn.sandboxPort) return null;
  return conn;
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
          `[mcp] verifyAccessToken api_key prefix=${tokenPrefix} ok user=${legacyAuth.userId}`
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

      const conn = getConnectionContext(verified.connectionId);
      if (!conn) {
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
        connectionId: verified.connectionId,
        sandboxPort: conn.sandboxPort!,
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
