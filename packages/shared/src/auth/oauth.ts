import { createHash, randomBytes } from "node:crypto";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { and, eq, isNull } from "drizzle-orm";
import { decrypt, encrypt } from "../crypto/encryption.js";
import { hashKey } from "./api-keys.js";
import * as schema from "../db/schema.js";

const {
  apiKeys,
  authAuditLogs,
  connections,
  oauthAccessTokens,
  oauthAuthorizationCodes,
  oauthClients,
  oauthRefreshTokens,
} = schema;

type AskDb = BetterSQLite3Database<typeof schema>;

export const MCP_OAUTH_SUPPORTED_SCOPES = ["mcp:resources", "mcp:tools"] as const;

const ACCESS_TOKEN_PREFIX = "ask_at_";
const REFRESH_TOKEN_PREFIX = "ask_rt_";
const AUTHORIZATION_CODE_PREFIX = "ask_code_";

export interface OAuthClientRecord {
  client_id: string;
  client_secret?: string;
  client_id_issued_at?: number;
  client_secret_expires_at?: number;
  redirect_uris: string[];
  token_endpoint_auth_method?: string;
  grant_types?: string[];
  response_types?: string[];
  client_name?: string;
  client_uri?: string;
  logo_uri?: string;
  scope?: string;
  contacts?: string[];
  tos_uri?: string;
  policy_uri?: string;
  jwks_uri?: string;
  jwks?: unknown;
  software_id?: string;
  software_version?: string;
  software_statement?: string;
  [key: string]: unknown;
}

export interface OAuthVerifiedAccessToken {
  apiKeyId: string;
  clientId: string;
  connectionId: string;
  expiresAt: Date;
  resource: string;
  scopes: string[];
  userId: string;
}

interface StoredGrant {
  apiKeyId: string;
  clientId: string;
  connectionId: string;
  resource: string;
  scopes: string[];
  userId: string;
}

interface IssueOAuthTokensInput extends StoredGrant {
  now?: Date;
  familyId?: string;
}

interface IssueOAuthTokensResult {
  accessToken: OAuthVerifiedAccessToken;
  response: {
    access_token: string;
    token_type: "bearer";
    expires_in: number;
    scope: string;
    refresh_token: string;
  };
}

export function getAccessTokenTtlSeconds(): number {
  return parsePositiveInt(process.env.MCP_OAUTH_ACCESS_TOKEN_TTL_SECONDS, 3600);
}

export function getRefreshTokenTtlSeconds(): number {
  // 7 days by default — long enough for well-behaved clients to keep silently
  // refreshing, short enough that a stolen token eventually expires even if
  // reuse detection misses it.
  return parsePositiveInt(
    process.env.MCP_OAUTH_REFRESH_TOKEN_TTL_SECONDS,
    60 * 60 * 24 * 7
  );
}

export function getAuthorizationCodeTtlSeconds(): number {
  return parsePositiveInt(process.env.MCP_OAUTH_CODE_TTL_SECONDS, 600);
}

export function normalizeOAuthScopes(scopes: string[] | undefined): string[] {
  if (!scopes || scopes.length === 0) {
    return [...MCP_OAUTH_SUPPORTED_SCOPES];
  }

  const normalized = uniqueSorted(scopes.filter(Boolean));
  const unsupported = normalized.filter(
    (scope) => !MCP_OAUTH_SUPPORTED_SCOPES.includes(scope as (typeof MCP_OAUTH_SUPPORTED_SCOPES)[number])
  );

  if (unsupported.length > 0) {
    throw new Error(`Unsupported scopes: ${unsupported.join(", ")}`);
  }

  return normalized;
}

export function getDefaultConnectionForUser(database: AskDb, userId: string) {
  const rows = database
    .select()
    .from(connections)
    .where(eq(connections.userId, userId))
    .all();

  return rows.find((row) => typeof row.sandboxPort === "number") ?? null;
}

export function getOAuthClient(database: AskDb, clientId: string): OAuthClientRecord | undefined {
  const row = database
    .select()
    .from(oauthClients)
    .where(eq(oauthClients.id, clientId))
    .get();

  if (!row) return undefined;
  return JSON.parse(decrypt(row.encryptedClient)) as OAuthClientRecord;
}

// RFC 9700 §4.1.3 + OAuth 2.1 §4.1.2.1: redirect_uris must be absolute,
// use https (native apps may use http://localhost or a private-use scheme),
// have no fragment, and no userinfo. Public-internet deployments must also
// reject SSRF-friendly hosts: RFC1918, link-local (169.254/16), loopback
// (when the deployment is not meant to be local), and cloud metadata IPs.
//
// Callers that need to allow loopback (e.g. IDE/CLI flows registering
// http://127.0.0.1:PORT) pass allowLoopback: true.
export function validateRedirectUri(raw: unknown, opts: { allowLoopback?: boolean } = {}): string {
  const allowLoopback = opts.allowLoopback ?? true;
  if (typeof raw !== "string" || raw.includes("*") || raw.length > 2048) {
    throw new Error(`invalid redirect_uri: ${String(raw)}`);
  }

  let parsed: URL;
  try { parsed = new URL(raw); } catch { throw new Error(`invalid redirect_uri: ${raw}`); }

  if (parsed.hash && parsed.hash.length > 0) {
    throw new Error(`redirect_uri must not contain a fragment: ${raw}`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`redirect_uri must not contain userinfo: ${raw}`);
  }

  const isHttps = parsed.protocol === "https:";
  const isHttp = parsed.protocol === "http:";
  const isPrivateUseScheme = /^[a-z][a-z0-9+.-]*:$/i.test(parsed.protocol) && !isHttp && !isHttps;

  if (!isHttps && !isHttp && !isPrivateUseScheme) {
    throw new Error(`redirect_uri must use https or a private-use scheme: ${raw}`);
  }

  if (isHttp) {
    // Only http://localhost / 127.0.0.1 / ::1 are allowed, for loopback flows.
    if (!allowLoopback) {
      throw new Error(`redirect_uri must use https: ${raw}`);
    }
    const host = parsed.hostname.toLowerCase();
    if (host !== "localhost" && host !== "127.0.0.1" && host !== "[::1]" && host !== "::1") {
      throw new Error(`http redirect_uri is only allowed for loopback: ${raw}`);
    }
    return raw;
  }

  if (isHttps) {
    const host = parsed.hostname.toLowerCase();
    // Reject IP literals that would indicate SSRF targets — private ranges,
    // link-local, loopback, cloud metadata. Hostnames are allowed; if an
    // attacker resolves a hostname to a private IP we can't prevent that at
    // registration time, but we close the obvious door.
    if (isIpLiteral(host) && isDisallowedIp(host)) {
      throw new Error(`redirect_uri host is not allowed: ${raw}`);
    }
  }

  return raw;
}

function validateRedirectUris(uris: unknown): string[] {
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > 5) {
    throw new Error("redirect_uris must be an array of 1–5 URIs");
  }
  return uris.map((u) => validateRedirectUri(u));
}

function isIpLiteral(host: string): boolean {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true;
  if (host.startsWith("[") && host.endsWith("]")) return true;
  if (host.includes(":")) return true;
  return false;
}

function isDisallowedIp(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, "");

  // IPv4
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(bare)) {
    const [a, b] = bare.split(".").map((n) => Number.parseInt(n, 10));
    if (a === 10) return true;                               // 10.0.0.0/8
    if (a === 127) return true;                              // loopback
    if (a === 169 && b === 254) return true;                 // link-local, AWS metadata
    if (a === 172 && b! >= 16 && b! <= 31) return true;      // 172.16.0.0/12
    if (a === 192 && b === 168) return true;                 // 192.168.0.0/16
    if (a === 100 && b! >= 64 && b! <= 127) return true;     // CGNAT 100.64/10
    if (a === 0) return true;
    if (a! >= 224) return true;                              // multicast + reserved
    return false;
  }

  // IPv6 — reject loopback, link-local, unique-local.
  const lower = bare.toLowerCase();
  if (lower === "::1") return true;
  if (lower.startsWith("fe80:")) return true;                // link-local
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // ULA fc00::/7
  if (lower === "::") return true;
  return false;
}

export function storeOAuthClient(
  database: AskDb,
  client: OAuthClientRecord,
  now = new Date()
): OAuthClientRecord {
  // Validate redirect URIs before storing — rejects non-https (except localhost),
  // wildcards, empty lists, and lists longer than 5.
  validateRedirectUris(client.redirect_uris);

  const existing = database
    .select({ id: oauthClients.id })
    .from(oauthClients)
    .where(eq(oauthClients.id, client.client_id))
    .get();

  const encryptedClient = encrypt(JSON.stringify(client));

  if (existing) {
    database
      .update(oauthClients)
      .set({
        encryptedClient,
        updatedAt: now,
      })
      .where(eq(oauthClients.id, client.client_id))
      .run();
  } else {
    database.insert(oauthClients).values({
      id: client.client_id,
      encryptedClient,
      createdAt: now,
      updatedAt: now,
    }).run();
  }

  recordAuthAudit(
    database,
    {
      event: existing ? "oauth.client_updated" : "oauth.client_registered",
      outcome: "info",
      clientId: client.client_id,
      details: {
        client_name: client.client_name ?? null,
        redirect_uri_count: client.redirect_uris.length,
      },
    },
    now
  );

  return client;
}

export function createAuthorizationCodeGrant(
  database: AskDb,
  input: {
    clientId: string;
    connectionId: string;
    redirectUri: string;
    codeChallenge: string;
    resource: string;
    scopes: string[];
    userId: string;
    now?: Date;
  }
): string {
  const now = input.now ?? new Date();
  const code = createOpaqueSecret(AUTHORIZATION_CODE_PREFIX);

  database.insert(oauthAuthorizationCodes).values({
    id: createStableId("grant", `${input.clientId}:${now.toISOString()}:${code}`),
    codeHash: hashValue(code),
    clientId: input.clientId,
    userId: input.userId,
    connectionId: input.connectionId,
    redirectUri: input.redirectUri,
    codeChallenge: input.codeChallenge,
    scopes: serializeScopes(input.scopes),
    resource: input.resource,
    expiresAt: new Date(now.getTime() + getAuthorizationCodeTtlSeconds() * 1000),
    createdAt: now,
  }).run();

  return code;
}

export function getAuthorizationCodeChallenge(
  database: AskDb,
  clientId: string,
  code: string
): string {
  const row = database
    .select({
      clientId: oauthAuthorizationCodes.clientId,
      codeChallenge: oauthAuthorizationCodes.codeChallenge,
      expiresAt: oauthAuthorizationCodes.expiresAt,
    })
    .from(oauthAuthorizationCodes)
    .where(eq(oauthAuthorizationCodes.codeHash, hashValue(code)))
    .get();

  if (!row || row.clientId !== clientId || row.expiresAt.getTime() <= Date.now()) {
    throw new Error("Invalid authorization code");
  }

  return row.codeChallenge;
}

export function exchangeAuthorizationCodeGrant(
  database: AskDb,
  input: {
    client: OAuthClientRecord;
    code: string;
    redirectUri?: string;
    resource?: string;
    now?: Date;
  }
) {
  const now = input.now ?? new Date();
  const row = database
    .select()
    .from(oauthAuthorizationCodes)
    .where(eq(oauthAuthorizationCodes.codeHash, hashValue(input.code)))
    .get();

  if (!row || row.expiresAt.getTime() <= now.getTime()) {
    throw new Error("Invalid authorization code");
  }

  if (row.clientId !== input.client.client_id) {
    throw new Error("Authorization code was issued to a different client");
  }

  if (input.redirectUri && input.redirectUri !== row.redirectUri) {
    throw new Error("redirect_uri does not match the authorization request");
  }

  if ((input.resource ?? row.resource) !== row.resource) {
    throw new Error("resource does not match the authorization request");
  }

  database
    .delete(oauthAuthorizationCodes)
    .where(eq(oauthAuthorizationCodes.id, row.id))
    .run();

  return issueOAuthTokens(database, {
    apiKeyId: ensureOAuthAuditApiKeyId(database, row.userId, input.client, now),
    clientId: row.clientId,
    connectionId: row.connectionId,
    resource: row.resource,
    scopes: parseScopes(row.scopes),
    userId: row.userId,
    now,
  }).response;
}

export function exchangeRefreshTokenGrant(
  database: AskDb,
  input: {
    client: OAuthClientRecord;
    refreshToken: string;
    requestedResource?: string;
    requestedScopes?: string[];
    now?: Date;
  }
) {
  const now = input.now ?? new Date();
  const tokenHash = hashValue(input.refreshToken);
  // Fetch the row regardless of revocation so we can detect re-use of an
  // already-rotated refresh token (OAuth 2.1 §4.2.2 / RFC 9700 §4.14).
  const row = database
    .select()
    .from(oauthRefreshTokens)
    .where(eq(oauthRefreshTokens.tokenHash, tokenHash))
    .get();

  if (!row || row.expiresAt.getTime() <= now.getTime()) {
    throw new Error("Invalid refresh token");
  }

  if (row.clientId !== input.client.client_id) {
    throw new Error("Refresh token was issued to a different client");
  }

  if (row.revokedAt !== null) {
    // Reuse detected — invalidate the entire family and any access tokens it
    // minted. The attacker (or benign client with bad retry logic) gets kicked
    // out, and the legitimate holder will be forced to re-authorize.
    if (row.familyId) {
      database
        .update(oauthRefreshTokens)
        .set({ revokedAt: now })
        .where(
          and(
            eq(oauthRefreshTokens.familyId, row.familyId),
            isNull(oauthRefreshTokens.revokedAt)
          )
        )
        .run();
      database
        .update(oauthAccessTokens)
        .set({ revokedAt: now })
        .where(
          and(
            eq(oauthAccessTokens.clientId, row.clientId),
            eq(oauthAccessTokens.userId, row.userId),
            isNull(oauthAccessTokens.revokedAt)
          )
        )
        .run();
    }
    recordAuthAudit(
      database,
      {
        event: "oauth.refresh_reuse_detected",
        outcome: "failure",
        userId: row.userId,
        clientId: row.clientId,
        details: { familyId: row.familyId || null },
      },
      now
    );
    throw new Error("Refresh token reuse detected");
  }

  const originalScopes = parseScopes(row.scopes);
  const nextScopes = input.requestedScopes?.length
    ? uniqueSorted(input.requestedScopes)
    : originalScopes;

  const invalidScopes = nextScopes.filter((scope) => !originalScopes.includes(scope));
  if (invalidScopes.length > 0) {
    throw new Error(`Requested scopes exceed the original grant: ${invalidScopes.join(", ")}`);
  }

  const resource = input.requestedResource ?? row.resource;
  if (resource !== row.resource) {
    throw new Error("Requested resource does not match the original grant");
  }

  database
    .update(oauthRefreshTokens)
    .set({ revokedAt: now })
    .where(eq(oauthRefreshTokens.id, row.id))
    .run();

  return issueOAuthTokens(database, {
    apiKeyId: ensureOAuthAuditApiKeyId(database, row.userId, input.client, now),
    clientId: row.clientId,
    connectionId: row.connectionId,
    resource,
    scopes: nextScopes,
    userId: row.userId,
    familyId: row.familyId || undefined,
    now,
  }).response;
}

export function revokeOAuthToken(
  database: AskDb,
  clientId: string,
  token: string,
  now = new Date()
): void {
  const tokenHash = hashValue(token);

  database
    .update(oauthAccessTokens)
    .set({ revokedAt: now })
    .where(
      and(
        eq(oauthAccessTokens.clientId, clientId),
        eq(oauthAccessTokens.tokenHash, tokenHash),
        isNull(oauthAccessTokens.revokedAt)
      )
    )
    .run();

  database
    .update(oauthRefreshTokens)
    .set({ revokedAt: now })
    .where(
      and(
        eq(oauthRefreshTokens.clientId, clientId),
        eq(oauthRefreshTokens.tokenHash, tokenHash),
        isNull(oauthRefreshTokens.revokedAt)
      )
    )
    .run();
}

export function verifyOAuthAccessToken(
  database: AskDb,
  token: string,
  now = new Date()
): OAuthVerifiedAccessToken | null {
  const row = database
    .select()
    .from(oauthAccessTokens)
    .where(
      and(
        eq(oauthAccessTokens.tokenHash, hashValue(token)),
        isNull(oauthAccessTokens.revokedAt)
      )
    )
    .get();

  if (!row || row.expiresAt.getTime() <= now.getTime()) {
    return null;
  }

  const client = getOAuthClient(database, row.clientId);
  if (!client) {
    return null;
  }

  return {
    apiKeyId: ensureOAuthAuditApiKeyId(database, row.userId, client, now),
    clientId: row.clientId,
    connectionId: row.connectionId,
    expiresAt: row.expiresAt,
    resource: row.resource,
    scopes: parseScopes(row.scopes),
    userId: row.userId,
  };
}

export function getOAuthAuditApiKeyId(userId: string, clientId: string): string {
  return createStableId("oauth_audit", `${userId}:${clientId}`);
}

function issueOAuthTokens(
  database: AskDb,
  input: IssueOAuthTokensInput
): IssueOAuthTokensResult {
  const now = input.now ?? new Date();
  const accessToken = createOpaqueSecret(ACCESS_TOKEN_PREFIX);
  const refreshToken = createOpaqueSecret(REFRESH_TOKEN_PREFIX);
  const accessTokenExpiresAt = new Date(now.getTime() + getAccessTokenTtlSeconds() * 1000);
  const refreshTokenExpiresAt = new Date(now.getTime() + getRefreshTokenTtlSeconds() * 1000);
  const serializedScopes = serializeScopes(input.scopes);
  const familyId = input.familyId ?? randomBytes(16).toString("hex");

  database.insert(oauthAccessTokens).values({
    id: createStableId("access", `${input.clientId}:${now.toISOString()}:${accessToken}`),
    tokenHash: hashValue(accessToken),
    clientId: input.clientId,
    userId: input.userId,
    connectionId: input.connectionId,
    scopes: serializedScopes,
    resource: input.resource,
    expiresAt: accessTokenExpiresAt,
    revokedAt: null,
    createdAt: now,
  }).run();

  database.insert(oauthRefreshTokens).values({
    id: createStableId("refresh", `${input.clientId}:${now.toISOString()}:${refreshToken}`),
    tokenHash: hashValue(refreshToken),
    clientId: input.clientId,
    userId: input.userId,
    connectionId: input.connectionId,
    scopes: serializedScopes,
    resource: input.resource,
    expiresAt: refreshTokenExpiresAt,
    revokedAt: null,
    familyId,
    createdAt: now,
  }).run();

  return {
    accessToken: {
      apiKeyId: input.apiKeyId,
      clientId: input.clientId,
      connectionId: input.connectionId,
      expiresAt: accessTokenExpiresAt,
      resource: input.resource,
      scopes: input.scopes,
      userId: input.userId,
    },
    response: {
      access_token: accessToken,
      token_type: "bearer",
      expires_in: getAccessTokenTtlSeconds(),
      scope: serializedScopes,
      refresh_token: refreshToken,
    },
  };
}

function ensureOAuthAuditApiKeyId(
  database: AskDb,
  userId: string,
  client: OAuthClientRecord,
  now: Date
): string {
  const apiKeyId = getOAuthAuditApiKeyId(userId, client.client_id);
  const existing = database
    .select({ id: apiKeys.id })
    .from(apiKeys)
    .where(eq(apiKeys.id, apiKeyId))
    .get();

  if (!existing) {
    const clientLabel = client.client_name?.trim() || client.client_id;
    database.insert(apiKeys).values({
      id: apiKeyId,
      prefix: `oauth:${clientLabel}`.slice(0, 40),
      keyHash: hashKey(`oauth-audit:${userId}:${client.client_id}`),
      label: `OAuth session for ${clientLabel}`,
      revokedAt: now,
      createdAt: now,
      updatedAt: now,
      userId,
    }).run();
  }

  return apiKeyId;
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function createOpaqueSecret(prefix: string): string {
  return `${prefix}${randomBytes(32).toString("hex")}`;
}

function hashValue(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function createStableId(prefix: string, input: string): string {
  return `${prefix}_${hashValue(input).slice(0, 24)}`;
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function serializeScopes(scopes: string[]): string {
  return uniqueSorted(scopes).join(" ");
}

function parseScopes(serialized: string): string[] {
  if (!serialized.trim()) return [];
  return uniqueSorted(serialized.split(/\s+/).filter(Boolean));
}

export interface AuthAuditEvent {
  event: string;
  outcome?: "info" | "success" | "failure";
  userId?: string | null;
  clientId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  details?: Record<string, unknown> | null;
}

export function recordAuthAudit(
  database: AskDb,
  evt: AuthAuditEvent,
  now: Date = new Date()
): void {
  try {
    database.insert(authAuditLogs).values({
      event: evt.event,
      outcome: evt.outcome ?? "info",
      userId: evt.userId ?? null,
      clientId: evt.clientId ?? null,
      ipAddress: evt.ipAddress ?? null,
      userAgent: evt.userAgent ?? null,
      details: evt.details ? JSON.stringify(evt.details) : null,
      createdAt: now,
    }).run();
  } catch (err) {
    // Never let audit-log failures break auth. Log to stderr and move on.
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[askdb] auth audit log failed for ${evt.event}: ${msg}`);
  }
}
