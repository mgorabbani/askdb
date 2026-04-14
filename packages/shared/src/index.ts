// Re-export drizzle operators so consumers use the same module instance
// (avoids pnpm virtual-store duplication when peer deps differ).
export { and, or, eq, ne, gt, gte, lt, lte, isNull, isNotNull, inArray, notInArray, desc, asc, sql, count } from "drizzle-orm";

export * as schema from "./db/schema.js";
export { db, getDb } from "./db/index.js";
export { ensureDatabaseSchema } from "./db/bootstrap.js";
export { encrypt, decrypt } from "./crypto/encryption.js";
export { generateApiKey, hashKey } from "./auth/api-keys.js";
export {
  MCP_OAUTH_SUPPORTED_SCOPES,
  createAuthorizationCodeGrant,
  exchangeAuthorizationCodeGrant,
  exchangeRefreshTokenGrant,
  getAccessTokenTtlSeconds,
  getAuthorizationCodeChallenge,
  getAuthorizationCodeTtlSeconds,
  getDefaultConnectionForUser,
  getOAuthAuditApiKeyId,
  getOAuthClient,
  getRefreshTokenTtlSeconds,
  normalizeOAuthScopes,
  revokeOAuthToken,
  storeOAuthClient,
  verifyOAuthAccessToken,
} from "./auth/oauth.js";
export type {
  OAuthClientRecord,
  OAuthVerifiedAccessToken,
} from "./auth/oauth.js";
export type { DatabaseAdapter, IntrospectionResult, QueryResult } from "./adapters/types.js";
export { MongoDBAdapter } from "./adapters/mongodb/index.js";
export { syncConnection } from "./adapters/mongodb/sync.js";
export { startSyncScheduler, stopSyncScheduler } from "./adapters/mongodb/scheduler.js";
export { introspectAndSave } from "./adapters/mongodb/introspect.js";
export { detectRelationships } from "./adapters/mongodb/relationships.js";
export { sandboxManager } from "./docker/manager.js";
export { detectPii } from "./pii/patterns.js";
export { extractPatterns, recordQueryForMemory } from "./memory/extractor.js";
export { saveAgentInsight } from "./memory/insights.js";
export type { AgentInsightCategory } from "./memory/insights.js";
export {
  generateSchemaOverviewMarkdown,
  generateCollectionDetailMarkdown,
  generateGuideMarkdown,
  generateSchemaMarkdown,
  invalidateGuideCache,
} from "./schema-summary/generator.js";
