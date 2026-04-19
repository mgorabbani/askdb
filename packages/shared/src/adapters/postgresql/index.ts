import type pg from "pg";
import type { DatabaseAdapter, IntrospectionResult, QueryResult } from "../types.js";

type PgClientCtor = typeof pg.Client;
let cachedClient: PgClientCtor | null = null;
async function getClientCtor(): Promise<PgClientCtor> {
  if (cachedClient) return cachedClient;
  const mod = await import("pg");
  cachedClient = (mod as unknown as { default: typeof pg }).default?.Client ?? (mod as unknown as typeof pg).Client;
  return cachedClient;
}

const FORBIDDEN_SQL = /\b(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|TRUNCATE|GRANT|REVOKE|COPY|VACUUM|REINDEX|CALL|DO|LOCK|MERGE)\b/i;

export class PostgreSQLAdapter implements DatabaseAdapter {
  async validateConnection(connString: string, databaseName?: string) {
    const Client = await getClientCtor();
    const client = new Client({
      connectionString: connString,
      database: databaseName,
      connectionTimeoutMillis: 10_000,
      statement_timeout: 10_000,
    });

    try {
      await client.connect();
      await client.query("SELECT 1");
      return { valid: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown connection error";
      return { valid: false, error: message };
    } finally {
      await client.end().catch(() => {});
    }
  }

  async getDatabaseSize(connString: string, databaseName?: string) {
    const Client = await getClientCtor();
    const client = new Client({
      connectionString: connString,
      database: databaseName,
      connectionTimeoutMillis: 10_000,
      statement_timeout: 10_000,
    });

    try {
      await client.connect();
      const sizeRow = await client.query<{ size: string }>(
        "SELECT pg_database_size(current_database())::text AS size",
      );
      const countRow = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
           FROM information_schema.tables
          WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
            AND table_type = 'BASE TABLE'`,
      );
      return {
        sizeBytes: Number(sizeRow.rows[0]?.size ?? 0),
        collections: Number(countRow.rows[0]?.count ?? 0),
      };
    } finally {
      await client.end().catch(() => {});
    }
  }

  async dump(_connString: string, _outputDir: string): Promise<void> {
    throw new Error("Use runPostgresDumpRestore() from ./sync.js");
  }

  async restore(_sandboxConnString: string, _inputDir: string): Promise<void> {
    throw new Error("Use runPostgresDumpRestore() from ./sync.js");
  }

  async introspect(_sandboxConnString: string): Promise<IntrospectionResult> {
    throw new Error("Use introspectAndSave() from ./introspect.js");
  }

  async executeQuery(
    sandboxConnString: string,
    query: string,
    visibleCollections: string[],
    hiddenFields: Map<string, string[]>,
  ): Promise<QueryResult> {
    const check = this.validateQuery(query);
    if (!check.valid) throw new Error(check.error ?? "Invalid query");

    const Client = await getClientCtor();
    const client = new Client({
      connectionString: sandboxConnString,
      connectionTimeoutMillis: 10_000,
      statement_timeout: 10_000,
    });

    try {
      await client.connect();
      const result = await client.query(query);
      const visible = new Set(visibleCollections);

      const rows = (result.rows as Record<string, unknown>[]).map((row) => {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(row)) {
          let hidden = false;
          for (const [table, fields] of hiddenFields) {
            if (visible.size > 0 && !visible.has(table)) continue;
            if (fields.includes(k)) {
              hidden = true;
              break;
            }
          }
          if (!hidden) out[k] = v;
        }
        return out;
      });

      return {
        documents: rows,
        totalCount: result.rowCount ?? rows.length,
        truncated: false,
      };
    } finally {
      await client.end().catch(() => {});
    }
  }

  validateQuery(query: string) {
    const trimmed = query.trim().replace(/;$/, "");
    if (!trimmed) return { valid: false, error: "Empty query" };
    if (trimmed.includes(";")) {
      return { valid: false, error: "Multiple statements are not allowed" };
    }
    if (FORBIDDEN_SQL.test(trimmed)) {
      return { valid: false, error: "Only read-only SELECT/WITH/EXPLAIN queries are permitted" };
    }
    if (!/^\s*(SELECT|WITH|EXPLAIN|SHOW|VALUES|TABLE)\b/i.test(trimmed)) {
      return { valid: false, error: "Query must start with SELECT, WITH, EXPLAIN, SHOW, VALUES, or TABLE" };
    }
    return { valid: true };
  }
}
