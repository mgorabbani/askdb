interface SqliteExecDatabase {
  exec(sql: string): unknown;
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
  `);
}
