import { MongoClient } from "mongodb";
import { db } from "../../db/index.js";
import { schemaTables, schemaColumns } from "../../db/schema.js";
import { detectPii } from "../../pii/patterns.js";
import { and, eq } from "drizzle-orm";
import { detectRelationships } from "./relationships.js";

const SYSTEM_COLLECTIONS = /^system\./;
const INTERNAL_COLLECTIONS = new Set(["_migrations", "_sessions", "__schema"]);

export async function introspectAndSave(connectionId: string, sandboxUri: string, databaseName?: string) {
  const client = new MongoClient(sandboxUri, { serverSelectionTimeoutMS: 10000 });

  try {
    await client.connect();
    const mdb = databaseName ? client.db(databaseName) : client.db();
    const collectionInfos = await mdb.listCollections().toArray();

    for (const info of collectionInfos) {
      const name = info.name;
      if (SYSTEM_COLLECTIONS.test(name) || INTERNAL_COLLECTIONS.has(name)) continue;

      const collection = mdb.collection(name);
      const docCount = await collection.estimatedDocumentCount();
      const sampleDoc = await collection.findOne({}, { sort: { _id: -1 } }).catch(() => null);
      const fields = sampleDoc ? flattenFields(sampleDoc) : [];

      // Upsert schema table
      const [existing] = await db
        .select()
        .from(schemaTables)
        .where(and(eq(schemaTables.connectionId, connectionId), eq(schemaTables.name, name)));

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
            name,
            docCount,
            isVisible: !name.startsWith("_"),
          })
          .returning();
        if (!inserted) throw new Error(`Failed to insert schema table ${name}`);
        tableId = inserted.id;
      }

      // Upsert schema columns
      for (const field of fields) {
        const piiConfidence = detectPii(field.name);
        const autoHide = piiConfidence === "HIGH" || piiConfidence === "MEDIUM";

        const [existingCol] = await db
          .select()
          .from(schemaColumns)
          .where(and(eq(schemaColumns.tableId, tableId), eq(schemaColumns.name, field.name)));

        if (existingCol) {
          await db
            .update(schemaColumns)
            .set({ fieldType: field.type, sampleValue: field.sampleValue, updatedAt: new Date() })
            .where(eq(schemaColumns.id, existingCol.id));
        } else {
          await db.insert(schemaColumns).values({
            tableId,
            name: field.name,
            fieldType: field.type,
            sampleValue: field.sampleValue,
            isVisible: !autoHide,
            piiConfidence,
          });
        }
      }

      // Remove columns that no longer exist
      const currentFieldNames = new Set(fields.map((f) => f.name));
      const existingCols = await db
        .select({ id: schemaColumns.id, name: schemaColumns.name })
        .from(schemaColumns)
        .where(eq(schemaColumns.tableId, tableId));

      for (const col of existingCols) {
        if (!currentFieldNames.has(col.name)) {
          await db.delete(schemaColumns).where(eq(schemaColumns.id, col.id));
        }
      }
    }

    // Remove tables that no longer exist
    const currentNames = new Set(
      collectionInfos
        .filter((i) => !SYSTEM_COLLECTIONS.test(i.name) && !INTERNAL_COLLECTIONS.has(i.name))
        .map((i) => i.name)
    );

    const existingTables = await db
      .select({ id: schemaTables.id, name: schemaTables.name })
      .from(schemaTables)
      .where(eq(schemaTables.connectionId, connectionId));

    for (const table of existingTables) {
      if (!currentNames.has(table.name)) {
        await db.delete(schemaTables).where(eq(schemaTables.id, table.id));
      }
    }
    // Detect relationships after all tables/columns are saved
    await detectRelationships(connectionId);
  } finally {
    await client.close().catch(() => {});
  }
}

interface FlatField {
  name: string;
  type: string;
  sampleValue: string | null;
}

function flattenFields(doc: Record<string, unknown>, prefix = ""): FlatField[] {
  const fields: FlatField[] = [];
  for (const [key, value] of Object.entries(doc)) {
    if (key === "_id") continue;
    const fieldName = prefix ? `${prefix}.${key}` : key;
    const type = getBsonType(value);
    if (type === "Object" && value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date)) {
      fields.push({ name: fieldName, type: "Object", sampleValue: null });
      fields.push(...flattenFields(value as Record<string, unknown>, fieldName));
    } else {
      fields.push({ name: fieldName, type, sampleValue: stringifySample(value) });
    }
  }
  return fields;
}

function getBsonType(value: unknown): string {
  if (value === null || value === undefined) return "Null";
  if (typeof value === "string") return "String";
  if (typeof value === "number") return Number.isInteger(value) ? "Int32" : "Double";
  if (typeof value === "boolean") return "Boolean";
  if (value instanceof Date) return "Date";
  if (Array.isArray(value)) return "Array";
  if (typeof value === "object") return "Object";
  return "Unknown";
}

function stringifySample(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const str = value instanceof Date ? value.toISOString() : String(value);
  return str.length > 200 ? str.slice(0, 200) + "..." : str;
}
