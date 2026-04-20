interface SqliteExecDatabase {
  exec(sql: string): unknown;
  prepare?(sql: string): { all(...params: unknown[]): unknown[] };
}

// Idempotent. Runs on every server startup via getDb() and on every test fixture.
// Existing DBs: no-op. Fresh DBs: creates everything needed to boot.
// Must stay in sync with packages/shared/src/db/schema.ts.
export function ensureDatabaseSchema(sqlite: SqliteExecDatabase) {
  sqlite.exec(`
    -- Better Auth tables ------------------------------------------------

    CREATE TABLE IF NOT EXISTS user (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      emailVerified INTEGER NOT NULL,
      image TEXT,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS session (
      id TEXT PRIMARY KEY NOT NULL,
      expiresAt INTEGER NOT NULL,
      token TEXT NOT NULL UNIQUE,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL,
      ipAddress TEXT,
      userAgent TEXT,
      userId TEXT NOT NULL REFERENCES user(id)
    );

    CREATE TABLE IF NOT EXISTS account (
      id TEXT PRIMARY KEY NOT NULL,
      accountId TEXT NOT NULL,
      providerId TEXT NOT NULL,
      userId TEXT NOT NULL REFERENCES user(id),
      accessToken TEXT,
      refreshToken TEXT,
      idToken TEXT,
      accessTokenExpiresAt INTEGER,
      refreshTokenExpiresAt INTEGER,
      scope TEXT,
      password TEXT,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS verification (
      id TEXT PRIMARY KEY NOT NULL,
      identifier TEXT NOT NULL,
      value TEXT NOT NULL,
      expiresAt INTEGER NOT NULL,
      createdAt INTEGER,
      updatedAt INTEGER
    );

    -- App tables --------------------------------------------------------

    CREATE TABLE IF NOT EXISTS connections (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      dbType TEXT NOT NULL DEFAULT 'mongodb',
      databaseName TEXT NOT NULL DEFAULT '',
      connectionString TEXT NOT NULL,
      sandboxContainerId TEXT,
      sandboxPort INTEGER,
      syncStatus TEXT NOT NULL DEFAULT 'IDLE',
      syncError TEXT,
      lastSyncAt INTEGER,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL,
      userId TEXT NOT NULL REFERENCES user(id)
    );

    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY NOT NULL,
      prefix TEXT NOT NULL,
      keyHash TEXT NOT NULL UNIQUE,
      label TEXT,
      revokedAt INTEGER,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL,
      userId TEXT NOT NULL REFERENCES user(id)
    );

    CREATE TABLE IF NOT EXISTS oauth_clients (
      id TEXT PRIMARY KEY NOT NULL,
      encryptedClient TEXT NOT NULL,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS oauth_authorization_codes (
      id TEXT PRIMARY KEY NOT NULL,
      codeHash TEXT NOT NULL UNIQUE,
      clientId TEXT NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
      userId TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
      connectionId TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
      redirectUri TEXT NOT NULL,
      codeChallenge TEXT NOT NULL,
      scopes TEXT NOT NULL DEFAULT '',
      resource TEXT NOT NULL,
      expiresAt INTEGER NOT NULL,
      createdAt INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS oauth_access_tokens (
      id TEXT PRIMARY KEY NOT NULL,
      tokenHash TEXT NOT NULL UNIQUE,
      clientId TEXT NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
      userId TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
      connectionId TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
      scopes TEXT NOT NULL DEFAULT '',
      resource TEXT NOT NULL,
      expiresAt INTEGER NOT NULL,
      revokedAt INTEGER,
      createdAt INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
      id TEXT PRIMARY KEY NOT NULL,
      tokenHash TEXT NOT NULL UNIQUE,
      clientId TEXT NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
      userId TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
      connectionId TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
      scopes TEXT NOT NULL DEFAULT '',
      resource TEXT NOT NULL,
      expiresAt INTEGER NOT NULL,
      revokedAt INTEGER,
      familyId TEXT NOT NULL DEFAULT '',
      createdAt INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_oauth_refresh_tokens_family
      ON oauth_refresh_tokens(familyId);

    CREATE TABLE IF NOT EXISTS schema_tables (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      docCount INTEGER NOT NULL DEFAULT 0,
      isVisible INTEGER NOT NULL DEFAULT 1,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL,
      connectionId TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS schema_columns (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      fieldType TEXT NOT NULL,
      sampleValue TEXT,
      isVisible INTEGER NOT NULL DEFAULT 1,
      piiConfidence TEXT NOT NULL DEFAULT 'NONE',
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL,
      tableId TEXT NOT NULL REFERENCES schema_tables(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS schema_relationships (
      id TEXT PRIMARY KEY NOT NULL,
      sourceTableId TEXT NOT NULL REFERENCES schema_tables(id) ON DELETE CASCADE,
      sourceField TEXT NOT NULL,
      targetTableId TEXT NOT NULL REFERENCES schema_tables(id) ON DELETE CASCADE,
      targetField TEXT NOT NULL DEFAULT '_id',
      relationType TEXT NOT NULL DEFAULT 'belongsTo',
      confidence TEXT NOT NULL DEFAULT 'AUTO',
      createdAt INTEGER NOT NULL,
      connectionId TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS query_memories (
      id TEXT PRIMARY KEY NOT NULL,
      pattern TEXT NOT NULL,
      description TEXT NOT NULL,
      exampleQuery TEXT,
      collection TEXT,
      frequency INTEGER NOT NULL DEFAULT 1,
      lastUsedAt INTEGER NOT NULL,
      createdAt INTEGER NOT NULL,
      connectionId TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS agent_insights (
      id TEXT PRIMARY KEY NOT NULL,
      insight TEXT NOT NULL,
      collection TEXT,
      category TEXT NOT NULL DEFAULT 'tip',
      exampleQuery TEXT,
      useCount INTEGER NOT NULL DEFAULT 1,
      lastConfirmedAt INTEGER NOT NULL,
      createdAt INTEGER NOT NULL,
      connectionId TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
      apiKeyId TEXT NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_agent_insights_connection
      ON agent_insights(connectionId);

    CREATE INDEX IF NOT EXISTS idx_agent_insights_connection_collection
      ON agent_insights(connectionId, collection);

    CREATE INDEX IF NOT EXISTS idx_agent_insights_connection_category
      ON agent_insights(connectionId, category);

    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY NOT NULL,
      action TEXT NOT NULL,
      query TEXT,
      collection TEXT,
      executionMs INTEGER NOT NULL DEFAULT 0,
      docCount INTEGER NOT NULL DEFAULT 0,
      createdAt INTEGER NOT NULL,
      connectionId TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
      apiKeyId TEXT NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS auth_audit_logs (
      id TEXT PRIMARY KEY NOT NULL,
      event TEXT NOT NULL,
      outcome TEXT NOT NULL DEFAULT 'info',
      userId TEXT,
      clientId TEXT,
      ipAddress TEXT,
      userAgent TEXT,
      details TEXT,
      createdAt INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_auth_audit_logs_createdAt
      ON auth_audit_logs(createdAt);
    CREATE INDEX IF NOT EXISTS idx_auth_audit_logs_event
      ON auth_audit_logs(event);
  `);

  // Idempotent column additions for pre-existing DBs. SQLite's CREATE TABLE IF
  // NOT EXISTS does not add new columns to tables that already exist, so any
  // column introduced after the initial schema must be migrated here.
  addColumnIfMissing(sqlite, "connections", "description", "TEXT");
  addColumnIfMissing(sqlite, "connections", "sandboxPassword", "TEXT");
  addColumnIfMissing(
    sqlite,
    "oauth_refresh_tokens",
    "familyId",
    "TEXT NOT NULL DEFAULT ''"
  );
}

// Allowlist of (table, column) pairs we intentionally migrate via ALTER TABLE.
// Prevents the interpolated ALTER TABLE from becoming an injection vector if
// this helper is ever called with caller-controlled strings.
const ALLOWED_COLUMN_MIGRATIONS = new Set([
  "connections:description",
  "connections:sandboxPassword",
  "oauth_refresh_tokens:familyId",
]);

function addColumnIfMissing(
  sqlite: SqliteExecDatabase,
  table: string,
  column: string,
  definition: string
) {
  if (!sqlite.prepare) return;
  if (!ALLOWED_COLUMN_MIGRATIONS.has(`${table}:${column}`)) {
    throw new Error(`addColumnIfMissing: (${table}, ${column}) not in allowlist`);
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(column)) {
    throw new Error(`addColumnIfMissing: invalid identifier ${table}.${column}`);
  }
  const cols = sqlite.prepare(`PRAGMA table_info("${table}")`).all() as {
    name: string;
  }[];
  if (cols.some((c) => c.name === column)) return;
  sqlite.exec(`ALTER TABLE "${table}" ADD COLUMN "${column}" ${definition}`);
}
