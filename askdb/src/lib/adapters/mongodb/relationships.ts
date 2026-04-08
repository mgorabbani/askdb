import { db } from "@/lib/db";
import { schemaTables, schemaColumns, schemaRelationships } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";

/**
 * Detect relationships between collections by matching field names
 * against known collection names.
 *
 * Patterns matched:
 *   userId, user_id     → users
 *   orderId, order_id   → orders
 *   categoryRef         → categories (with pluralization)
 *   productIds (array)  → products
 */

const SUFFIX_PATTERNS = [
  /^(.+?)(?:Id|_id)$/,      // userId, user_id
  /^(.+?)(?:Ref|_ref)$/,    // userRef, user_ref
  /^(.+?)(?:Ids|_ids)$/,    // userIds, user_ids (array references)
];

/** Simple pluralization for matching collection names */
function pluralize(word: string): string[] {
  const lower = word.toLowerCase();
  const variants = [lower];

  // common plural forms
  if (lower.endsWith("y")) {
    variants.push(lower.slice(0, -1) + "ies"); // category → categories
  } else if (lower.endsWith("s") || lower.endsWith("x") || lower.endsWith("ch") || lower.endsWith("sh")) {
    variants.push(lower + "es");
  } else {
    variants.push(lower + "s");
  }

  // also try the singular if it looks plural
  if (lower.endsWith("ies")) {
    variants.push(lower.slice(0, -3) + "y");
  } else if (lower.endsWith("ses") || lower.endsWith("xes") || lower.endsWith("ches") || lower.endsWith("shes")) {
    variants.push(lower.slice(0, -2));
  } else if (lower.endsWith("s") && !lower.endsWith("ss")) {
    variants.push(lower.slice(0, -1));
  }

  return variants;
}

/** Convert camelCase/snake_case to base word */
function extractBaseName(fieldName: string): string | null {
  // Get leaf field name for nested (address.userId → userId)
  const leaf = fieldName.includes(".") ? fieldName.split(".").pop()! : fieldName;

  for (const pattern of SUFFIX_PATTERNS) {
    const match = leaf.match(pattern);
    if (match) {
      // Convert camelCase to lowercase: "parentCategory" → "parentcategory" → try "category"
      const raw = match[1];
      // If camelCase, take the last capitalized word: "parentCategory" → "Category"
      const camelParts = raw.split(/(?=[A-Z])/);
      const lastPart = camelParts[camelParts.length - 1];
      return lastPart.toLowerCase();
    }
  }
  return null;
}

export async function detectRelationships(connectionId: string) {
  // Get all tables for this connection
  const tables = await db
    .select()
    .from(schemaTables)
    .where(eq(schemaTables.connectionId, connectionId));

  // Build lookup: collection name (lowercase) → table record
  const tableByName = new Map<string, typeof tables[0]>();
  for (const t of tables) {
    tableByName.set(t.name.toLowerCase(), t);
  }

  // Clear existing auto-detected relationships
  const existing = await db
    .select()
    .from(schemaRelationships)
    .where(
      and(
        eq(schemaRelationships.connectionId, connectionId),
        eq(schemaRelationships.confidence, "AUTO")
      )
    );
  for (const rel of existing) {
    await db.delete(schemaRelationships).where(eq(schemaRelationships.id, rel.id));
  }

  // For each table, check its fields for reference patterns
  for (const table of tables) {
    const columns = await db
      .select()
      .from(schemaColumns)
      .where(eq(schemaColumns.tableId, table.id));

    for (const col of columns) {
      const baseName = extractBaseName(col.name);
      if (!baseName) continue;

      // Try to find a matching collection
      const candidates = pluralize(baseName);
      let targetTable: typeof tables[0] | undefined;

      for (const candidate of candidates) {
        targetTable = tableByName.get(candidate);
        if (targetTable && targetTable.id !== table.id) break;
        targetTable = undefined;
      }

      if (!targetTable) continue;

      // Determine if it's an array field (hasMany via embedded IDs)
      const isArray = col.fieldType === "Array" || col.name.match(/Ids$|_ids$/);
      const relationType = isArray ? "hasMany" : "belongsTo";

      await db.insert(schemaRelationships).values({
        sourceTableId: table.id,
        sourceField: col.name,
        targetTableId: targetTable.id,
        targetField: "_id",
        relationType,
        confidence: "AUTO",
        connectionId,
      });
    }
  }
}
