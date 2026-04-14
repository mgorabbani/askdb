import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { ensureDatabaseSchema } from "../db/bootstrap.js";
import * as schema from "../db/schema.js";

const tempDir = mkdtempSync(join(tmpdir(), "askdb-tests-"));
export const TEST_DB_PATH = join(tempDir, "askdb.db");

process.env.DATABASE_PATH = TEST_DB_PATH;
process.env.ENCRYPTION_KEY ??= "11".repeat(32);

const sqlite = new Database(TEST_DB_PATH);
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");
ensureDatabaseSchema(sqlite);

export const testDb = drizzle(sqlite, { schema });

export function resetTestDatabase() {
  sqlite.exec(`
    DELETE FROM audit_logs;
    DELETE FROM agent_insights;
    DELETE FROM oauth_refresh_tokens;
    DELETE FROM oauth_access_tokens;
    DELETE FROM oauth_authorization_codes;
    DELETE FROM oauth_clients;
    DELETE FROM query_memories;
    DELETE FROM schema_relationships;
    DELETE FROM schema_columns;
    DELETE FROM schema_tables;
    DELETE FROM api_keys;
    DELETE FROM connections;
    DELETE FROM user;
  `);
}

export function seedAuthFixture(ids?: {
  apiKeyId?: string;
  connectionId?: string;
  userId?: string;
}) {
  const now = new Date("2026-04-09T00:00:00.000Z");
  const userId = ids?.userId ?? "user_test";
  const connectionId = ids?.connectionId ?? "conn_test";
  const apiKeyId = ids?.apiKeyId ?? "key_test";

  testDb.insert(schema.user).values({
    id: userId,
    name: "Test User",
    email: `${userId}@example.com`,
    emailVerified: true,
    image: null,
    createdAt: now,
    updatedAt: now,
  }).run();

  testDb.insert(schema.connections).values({
    id: connectionId,
    name: "Test Connection",
    dbType: "mongodb",
    databaseName: "testdb",
    connectionString: "mongodb://example",
    sandboxContainerId: null,
    sandboxPort: 27017,
    syncStatus: "IDLE",
    syncError: null,
    lastSyncAt: null,
    createdAt: now,
    updatedAt: now,
    userId,
  }).run();

  testDb.insert(schema.apiKeys).values({
    id: apiKeyId,
    prefix: "ask_sk_test",
    keyHash: `hash_${apiKeyId}`,
    label: "test",
    revokedAt: null,
    createdAt: now,
    updatedAt: now,
    userId,
  }).run();

  return { apiKeyId, connectionId, now, userId };
}

process.on("exit", () => {
  try {
    sqlite.close();
  } catch {}

  rmSync(tempDir, { force: true, recursive: true });
});
