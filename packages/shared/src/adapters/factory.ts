import type { DatabaseAdapter } from "./types.js";
import { MongoDBAdapter } from "./mongodb/index.js";
import { PostgreSQLAdapter } from "./postgresql/index.js";

export const SUPPORTED_DB_TYPES = ["mongodb", "postgresql"] as const;
export type SupportedDbType = typeof SUPPORTED_DB_TYPES[number];

export function normalizeDbType(dbType: string): SupportedDbType {
  const t = dbType.toLowerCase();
  if (t === "postgres" || t === "postgresql") return "postgresql";
  if (t === "mongo" || t === "mongodb") return "mongodb";
  throw new Error(`Unsupported database type: ${dbType}`);
}

export function getAdapter(dbType: string): DatabaseAdapter {
  const normalized = normalizeDbType(dbType);
  switch (normalized) {
    case "mongodb":
      return new MongoDBAdapter();
    case "postgresql":
      return new PostgreSQLAdapter();
  }
}

// Accept only conservative identifiers: letters, digits, underscore, hyphen,
// 1–63 chars. This is the intersection of what Postgres and MongoDB allow
// safely when the name is interpolated into shell args (mongodump --db,
// pg_dump dbname, CREATE DATABASE "...") or URL paths. Empty is allowed and
// means "use whatever database is implicit in the connection string".
const DATABASE_NAME_RE = /^[A-Za-z0-9_-]{1,63}$/;

export function assertValidDatabaseName(name: string): void {
  if (name === "") return;
  if (!DATABASE_NAME_RE.test(name)) {
    throw new Error(
      `Invalid database name: must be 1–63 chars of [A-Za-z0-9_-] (got ${JSON.stringify(name)})`
    );
  }
}
