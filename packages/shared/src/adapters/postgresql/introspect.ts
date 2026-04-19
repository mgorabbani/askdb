import { Client } from "pg";
import { db } from "../../db/index.js";
import { schemaTables, schemaColumns } from "../../db/schema.js";
import { detectPii } from "../../pii/patterns.js";
import { and, eq } from "drizzle-orm";
import { detectRelationships } from "../mongodb/relationships.js";

const EXCLUDED_SCHEMAS = new Set(["pg_catalog", "information_schema", "pg_toast"]);

export async function introspectAndSave(connectionId: string, sandboxUri: string, databaseName?: string) {
  // node-postgres ignores the `database` field when a connectionString is set,
  // so the target db must live in the URI itself or we end up listening on
  // whatever the URI's pathname says (usually `postgres`).
  const client = new Client({
    connectionString: injectDatabase(sandboxUri, databaseName),
    connectionTimeoutMillis: 10_000,
  });

  try {
    await client.connect();

    const tablesRes = await client.query<{ table_schema: string; table_name: string }>(
      `SELECT table_schema, table_name
         FROM information_schema.tables
        WHERE table_type = 'BASE TABLE'
          AND table_schema NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
        ORDER BY table_schema, table_name`,
    );

    const seenTableNames = new Set<string>();

    for (const row of tablesRes.rows) {
      if (EXCLUDED_SCHEMAS.has(row.table_schema)) continue;
      const qualifiedName = row.table_schema === "public"
        ? row.table_name
        : `${row.table_schema}.${row.table_name}`;
      seenTableNames.add(qualifiedName);

      const schemaIdent = quoteIdent(row.table_schema);
      const tableIdent = quoteIdent(row.table_name);

      const countRes = await client
        .query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM ${schemaIdent}.${tableIdent}`,
        )
        .catch(() => ({ rows: [{ count: "0" }] as { count: string }[] }));
      const docCount = Number(countRes.rows[0]?.count ?? 0);

      const colsRes = await client.query<{
        column_name: string;
        data_type: string;
        udt_name: string;
        is_nullable: string;
      }>(
        `SELECT column_name, data_type, udt_name, is_nullable
           FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = $2
          ORDER BY ordinal_position`,
        [row.table_schema, row.table_name],
      );

      const sampleRes = await client
        .query<Record<string, unknown>>(
          `SELECT * FROM ${schemaIdent}.${tableIdent} LIMIT 1`,
        )
        .catch(() => ({ rows: [] as Record<string, unknown>[] }));
      const sampleRow = sampleRes.rows[0] ?? {};

      const [existing] = await db
        .select()
        .from(schemaTables)
        .where(and(eq(schemaTables.connectionId, connectionId), eq(schemaTables.name, qualifiedName)));

      let tableId: string;
      if (existing) {
        await db
          .update(schemaTables)
          .set({ docCount, updatedAt: new Date() })
          .where(eq(schemaTables.id, existing.id));
        tableId = existing.id;
      } else {
        const [inserted] = await db
          .insert(schemaTables)
          .values({
            connectionId,
            name: qualifiedName,
            docCount,
            isVisible: !row.table_name.startsWith("_"),
          })
          .returning();
        if (!inserted) throw new Error(`Failed to insert schema table ${qualifiedName}`);
        tableId = inserted.id;
      }

      const currentCols = new Set<string>();
      for (const col of colsRes.rows) {
        currentCols.add(col.column_name);
        const fieldType = mapPgType(col.data_type, col.udt_name);
        const sampleValue = stringifySample(sampleRow[col.column_name]);
        const piiConfidence = detectPii(col.column_name);
        const autoHide = piiConfidence === "HIGH" || piiConfidence === "MEDIUM";

        const [existingCol] = await db
          .select()
          .from(schemaColumns)
          .where(and(eq(schemaColumns.tableId, tableId), eq(schemaColumns.name, col.column_name)));

        if (existingCol) {
          await db
            .update(schemaColumns)
            .set({ fieldType, sampleValue, updatedAt: new Date() })
            .where(eq(schemaColumns.id, existingCol.id));
        } else {
          await db.insert(schemaColumns).values({
            tableId,
            name: col.column_name,
            fieldType,
            sampleValue,
            isVisible: !autoHide,
            piiConfidence,
          });
        }
      }

      const existingCols = await db
        .select({ id: schemaColumns.id, name: schemaColumns.name })
        .from(schemaColumns)
        .where(eq(schemaColumns.tableId, tableId));

      for (const col of existingCols) {
        if (!currentCols.has(col.name)) {
          await db.delete(schemaColumns).where(eq(schemaColumns.id, col.id));
        }
      }
    }

    const existingTables = await db
      .select({ id: schemaTables.id, name: schemaTables.name })
      .from(schemaTables)
      .where(eq(schemaTables.connectionId, connectionId));

    for (const table of existingTables) {
      if (!seenTableNames.has(table.name)) {
        await db.delete(schemaTables).where(eq(schemaTables.id, table.id));
      }
    }

    await detectRelationships(connectionId);
  } finally {
    await client.end().catch(() => {});
  }
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function injectDatabase(uri: string, databaseName?: string): string {
  if (!databaseName) return uri;
  try {
    const url = new URL(uri);
    url.pathname = "/" + encodeURIComponent(databaseName);
    return url.toString();
  } catch {
    return uri;
  }
}

function mapPgType(dataType: string, udtName: string): string {
  const dt = dataType.toLowerCase();
  if (dt === "array") return "Array";
  if (dt.includes("int")) return "Int64";
  if (dt === "numeric" || dt === "real" || dt === "double precision") return "Double";
  if (dt === "boolean") return "Boolean";
  if (dt.startsWith("timestamp") || dt === "date" || dt === "time") return "Date";
  if (dt === "json" || dt === "jsonb") return "JSON";
  if (dt === "uuid") return "String";
  if (dt.includes("char") || dt === "text") return "String";
  if (dt === "bytea") return "Binary";
  return udtName || dataType;
}

function stringifySample(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  let str: string;
  if (value instanceof Date) str = value.toISOString();
  else if (typeof value === "object") {
    try {
      str = JSON.stringify(value);
    } catch {
      str = String(value);
    }
  } else {
    str = String(value);
  }
  return str.length > 200 ? str.slice(0, 200) + "..." : str;
}
