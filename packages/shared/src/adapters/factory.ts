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
