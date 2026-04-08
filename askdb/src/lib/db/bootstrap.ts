interface SqliteExecDatabase {
  exec(sql: string): unknown;
}

export function ensureDatabaseSchema(sqlite: SqliteExecDatabase) {
  sqlite.exec(`
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
  `);
}
