import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

// ─── Better Auth tables (managed by better-auth) ───────────────────

export const user = sqliteTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: integer("emailVerified", { mode: "boolean" }).notNull(),
  image: text("image"),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull(),
});

export const session = sqliteTable("session", {
  id: text("id").primaryKey(),
  expiresAt: integer("expiresAt", { mode: "timestamp" }).notNull(),
  token: text("token").notNull().unique(),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull(),
  ipAddress: text("ipAddress"),
  userAgent: text("userAgent"),
  userId: text("userId")
    .notNull()
    .references(() => user.id),
});

export const account = sqliteTable("account", {
  id: text("id").primaryKey(),
  accountId: text("accountId").notNull(),
  providerId: text("providerId").notNull(),
  userId: text("userId")
    .notNull()
    .references(() => user.id),
  accessToken: text("accessToken"),
  refreshToken: text("refreshToken"),
  idToken: text("idToken"),
  accessTokenExpiresAt: integer("accessTokenExpiresAt", { mode: "timestamp" }),
  refreshTokenExpiresAt: integer("refreshTokenExpiresAt", { mode: "timestamp" }),
  scope: text("scope"),
  password: text("password"),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull(),
});

export const verification = sqliteTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: integer("expiresAt", { mode: "timestamp" }).notNull(),
  createdAt: integer("createdAt", { mode: "timestamp" }),
  updatedAt: integer("updatedAt", { mode: "timestamp" }),
});

// ─── App tables ────────────────────────────────────────────────────

export const connections = sqliteTable("connections", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  name: text("name").notNull(),
  dbType: text("dbType").notNull().default("mongodb"),
  databaseName: text("databaseName").notNull().default(""),
  connectionString: text("connectionString").notNull(), // AES-256-GCM encrypted
  sandboxContainerId: text("sandboxContainerId"),
  sandboxPort: integer("sandboxPort"),
  syncStatus: text("syncStatus").notNull().default("IDLE"),
  syncError: text("syncError"),
  lastSyncAt: integer("lastSyncAt", { mode: "timestamp" }),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  userId: text("userId")
    .notNull()
    .references(() => user.id),
});

export const schemaTables = sqliteTable("schema_tables", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  name: text("name").notNull(),
  description: text("description"), // user-editable or AI-generated summary
  docCount: integer("docCount").notNull().default(0),
  isVisible: integer("isVisible", { mode: "boolean" }).notNull().default(true),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  connectionId: text("connectionId")
    .notNull()
    .references(() => connections.id, { onDelete: "cascade" }),
});

export const schemaColumns = sqliteTable("schema_columns", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  name: text("name").notNull(),
  fieldType: text("fieldType").notNull(),
  sampleValue: text("sampleValue"),
  isVisible: integer("isVisible", { mode: "boolean" }).notNull().default(true),
  piiConfidence: text("piiConfidence").notNull().default("NONE"),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  tableId: text("tableId")
    .notNull()
    .references(() => schemaTables.id, { onDelete: "cascade" }),
});

export const schemaRelationships = sqliteTable("schema_relationships", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  sourceTableId: text("sourceTableId")
    .notNull()
    .references(() => schemaTables.id, { onDelete: "cascade" }),
  sourceField: text("sourceField").notNull(), // e.g. "userId"
  targetTableId: text("targetTableId")
    .notNull()
    .references(() => schemaTables.id, { onDelete: "cascade" }),
  targetField: text("targetField").notNull().default("_id"), // usually _id
  relationType: text("relationType").notNull().default("belongsTo"), // belongsTo | hasMany
  confidence: text("confidence").notNull().default("AUTO"), // AUTO (detected) | MANUAL (user-set)
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  connectionId: text("connectionId")
    .notNull()
    .references(() => connections.id, { onDelete: "cascade" }),
});

export const queryMemories = sqliteTable("query_memories", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  pattern: text("pattern").notNull(), // e.g. "count users by date range"
  description: text("description").notNull(), // human-readable summary
  exampleQuery: text("exampleQuery"), // JSON query that works
  collection: text("collection"), // primary collection involved
  frequency: integer("frequency").notNull().default(1), // how often this pattern appears
  lastUsedAt: integer("lastUsedAt", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  connectionId: text("connectionId")
    .notNull()
    .references(() => connections.id, { onDelete: "cascade" }),
});

export const agentInsights = sqliteTable("agent_insights", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  insight: text("insight").notNull(),
  collection: text("collection"),
  category: text("category").notNull().default("tip"),
  exampleQuery: text("exampleQuery"),
  useCount: integer("useCount").notNull().default(1),
  lastConfirmedAt: integer("lastConfirmedAt", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  createdAt: integer("createdAt", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  connectionId: text("connectionId")
    .notNull()
    .references(() => connections.id, { onDelete: "cascade" }),
  apiKeyId: text("apiKeyId")
    .notNull()
    .references(() => apiKeys.id, { onDelete: "cascade" }),
});

export const apiKeys = sqliteTable("api_keys", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  prefix: text("prefix").notNull(),
  keyHash: text("keyHash").notNull().unique(),
  label: text("label"),
  revokedAt: integer("revokedAt", { mode: "timestamp" }),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  userId: text("userId")
    .notNull()
    .references(() => user.id),
});

export const oauthClients = sqliteTable("oauth_clients", {
  id: text("id").primaryKey(),
  encryptedClient: text("encryptedClient").notNull(),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

export const oauthAuthorizationCodes = sqliteTable("oauth_authorization_codes", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  codeHash: text("codeHash").notNull().unique(),
  clientId: text("clientId")
    .notNull()
    .references(() => oauthClients.id, { onDelete: "cascade" }),
  userId: text("userId")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  connectionId: text("connectionId")
    .notNull()
    .references(() => connections.id, { onDelete: "cascade" }),
  redirectUri: text("redirectUri").notNull(),
  codeChallenge: text("codeChallenge").notNull(),
  scopes: text("scopes").notNull().default(""),
  resource: text("resource").notNull(),
  expiresAt: integer("expiresAt", { mode: "timestamp" }).notNull(),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

export const oauthAccessTokens = sqliteTable("oauth_access_tokens", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  tokenHash: text("tokenHash").notNull().unique(),
  clientId: text("clientId")
    .notNull()
    .references(() => oauthClients.id, { onDelete: "cascade" }),
  userId: text("userId")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  connectionId: text("connectionId")
    .notNull()
    .references(() => connections.id, { onDelete: "cascade" }),
  scopes: text("scopes").notNull().default(""),
  resource: text("resource").notNull(),
  expiresAt: integer("expiresAt", { mode: "timestamp" }).notNull(),
  revokedAt: integer("revokedAt", { mode: "timestamp" }),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

export const oauthRefreshTokens = sqliteTable("oauth_refresh_tokens", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  tokenHash: text("tokenHash").notNull().unique(),
  clientId: text("clientId")
    .notNull()
    .references(() => oauthClients.id, { onDelete: "cascade" }),
  userId: text("userId")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  connectionId: text("connectionId")
    .notNull()
    .references(() => connections.id, { onDelete: "cascade" }),
  scopes: text("scopes").notNull().default(""),
  resource: text("resource").notNull(),
  expiresAt: integer("expiresAt", { mode: "timestamp" }).notNull(),
  revokedAt: integer("revokedAt", { mode: "timestamp" }),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

export const auditLogs = sqliteTable("audit_logs", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  action: text("action").notNull(),
  query: text("query"),
  collection: text("collection"),
  executionMs: integer("executionMs").notNull().default(0),
  docCount: integer("docCount").notNull().default(0),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  connectionId: text("connectionId")
    .notNull()
    .references(() => connections.id, { onDelete: "cascade" }),
  apiKeyId: text("apiKeyId")
    .notNull()
    .references(() => apiKeys.id, { onDelete: "cascade" }),
});
