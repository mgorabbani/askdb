import { desc, eq, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  agentInsights,
  queryMemories,
  schemaColumns,
  schemaRelationships,
  schemaTables,
} from "../db/schema.js";

type TableRow = typeof schemaTables.$inferSelect;
type ColumnRow = typeof schemaColumns.$inferSelect;
type RelationshipRow = typeof schemaRelationships.$inferSelect;
type QueryMemoryRow = typeof queryMemories.$inferSelect;
type InsightRow = typeof agentInsights.$inferSelect;

interface RelationshipView {
  sourceCollection: string;
  sourceField: string;
  targetCollection: string;
  targetField: string;
  relationType: string;
}

interface CollectionContext {
  table: TableRow;
  visibleFields: ColumnRow[];
  hiddenFieldCount: number;
  description: string;
  outgoingRelationships: RelationshipView[];
  incomingRelationships: RelationshipView[];
}

interface SchemaContext {
  collections: CollectionContext[];
  hiddenCollectionCount: number;
  queryPatterns: QueryMemoryRow[];
  insights: InsightRow[];
}

const guideCache = new Map<string, string>();

export function invalidateGuideCache(connectionId?: string) {
  if (connectionId) {
    guideCache.delete(connectionId);
    return;
  }

  guideCache.clear();
}

export async function generateGuideMarkdown(connectionId: string): Promise<string> {
  const cached = guideCache.get(connectionId);
  if (cached) return cached;

  const insights = await loadInsights(connectionId);
  const learnedGotchas = insights.filter((insight) => insight.category === "gotcha").slice(0, 6);
  const learnedTips = insights.filter((insight) => insight.category !== "gotcha").slice(0, 6);

  const lines: string[] = [
    "# askdb MCP Guide",
    "",
    "Read this resource once when you connect. Then use `schema://overview` or `list-collections` before writing queries.",
    "",
    "## Recommended Workflow",
    "",
    "1. Read `guide://usage` or rely on initialize-time instructions for the tool contract and learned tips.",
    "2. Read `schema://overview` or call `list-collections` for the database overview and common patterns.",
    "3. Call `collection-schema` before querying a collection you have not explored yet.",
    "4. Prefer `find`, `aggregate`, `count`, or `distinct` for queries. Use `sample-documents` for raw examples when needed.",
    "5. Call `save-insight` after the user is satisfied so future agents start with that knowledge.",
    "",
    "## Tools",
    "",
    "- `list-collections`: List visible MongoDB collections available to this tenant.",
    "- `collection-schema`: Full field list, relationships, gotchas, and examples for one collection.",
    "- `find`, `aggregate`, `count`, `distinct`: Preferred read-only MongoDB query tools.",
    "- `query`: Low-level compatibility tool that accepts the full JSON query envelope.",
    "- `sample-documents`: Pull a small random sample of raw documents from one collection.",
    "- `save-insight`: Store a validated gotcha, pattern, or tip after a successful session.",
    "",
    "## Resources",
    "",
    "- `guide://usage`: Usage guide and learned tips.",
    "- `schema://overview`: High-level schema overview optimized for AI context.",
    "- `insights://global`: Saved gotchas, patterns, and tips.",
    "- `config://config`: Redacted server configuration and active safety controls.",
    "- `debug://askdb`: Recent tool error state for debugging.",
    "",
    "## Query Format",
    "",
    "Use `query` only when you need the low-level compatibility envelope. The preferred path is the dedicated query tools.",
    "",
    "```json",
    '{',
    '  "collection": "users",',
    '  "operation": "find",',
    '  "filter": { "role": "STUDENT" },',
    '  "limit": 25',
    '}',
    "```",
    "",
    "Supported operations:",
    "",
    "- `find`: `{ collection, operation: \"find\", filter?, limit? }`",
    "- `aggregate`: `{ collection, operation: \"aggregate\", pipeline, limit? }`",
    "- `count`: `{ collection, operation: \"count\", filter? }`",
    "- `distinct`: `{ collection, operation: \"distinct\", field, filter? }`",
    "",
    "## Query Examples",
    "",
    "### Find documents",
    "",
    "```json",
    '{ "collection": "users", "operation": "find", "filter": { "status": "active" }, "limit": 20 }',
    "```",
    "",
    "### Aggregate documents",
    "",
    "```json",
    '{ "collection": "orders", "operation": "aggregate", "pipeline": [{ "$match": { "status": "paid" } }, { "$group": { "_id": "$customerId", "total": { "$sum": "$amount" } } }], "limit": 50 }',
    "```",
    "",
    "### Count documents",
    "",
    "```json",
    '{ "collection": "users", "operation": "count", "filter": { "role": "TEACHER" } }',
    "```",
    "",
    "### Distinct values",
    "",
    "```json",
    '{ "collection": "users", "operation": "distinct", "field": "role" }',
    "```",
    "",
    "## Limits And Constraints",
    "",
    "- Read-only access only.",
    "- `query` returns at most 500 documents.",
    "- `sample-documents` returns at most 20 documents.",
    "- Query timeout is 10 seconds.",
    "- Forbidden aggregation stages: `$merge`, `$out`, `$collStats`, `$currentOp`, `$listSessions`.",
    "- Hidden collections and hidden fields never appear in tool output.",
  ];

  if (learnedGotchas.length > 0) {
    lines.push("", "## Learned Gotchas", "");
    for (const insight of learnedGotchas) {
      lines.push(`- ${formatInsightBullet(insight)}`);
    }
  } else {
    lines.push("", "## Learned Gotchas", "", "- No saved gotchas yet. Save one with `save-insight` after you resolve something non-obvious.");
  }

  if (learnedTips.length > 0) {
    lines.push("", "## Learned Tips", "");
    for (const insight of learnedTips) {
      lines.push(`- ${formatInsightBullet(insight)}`);
    }
  }

  lines.push(
    "",
    "## When To Save An Insight",
    "",
    "Use `save-insight` only after the user got the answer they needed. Save durable knowledge such as enum values, date quirks, join strategies, or common working query patterns.",
    ""
  );

  const markdown = lines.join("\n");
  guideCache.set(connectionId, markdown);
  return markdown;
}

export async function generateSchemaOverviewMarkdown(connectionId: string): Promise<string> {
  const context = await loadSchemaContext(connectionId);
  const lines: string[] = ["# Database Overview", ""];

  lines.push("## Collections", "");
  if (context.collections.length === 0) {
    lines.push("No visible collections are available yet.");
  } else {
    lines.push("| Collection | Documents | Description |");
    lines.push("| --- | ---: | --- |");
    for (const collection of context.collections) {
      lines.push(
        `| ${escapeTableCell(collection.table.name)} | ${collection.table.docCount.toLocaleString()} | ${escapeTableCell(collection.description)} |`
      );
    }
  }

  if (context.hiddenCollectionCount > 0) {
    lines.push("", `_${context.hiddenCollectionCount} collection(s) hidden for privacy._`);
  }

  lines.push("", "## Relationships", "");
  const relationships = dedupeRelationshipViews(
    context.collections.flatMap((collection) => collection.outgoingRelationships)
  );
  if (relationships.length === 0) {
    lines.push("No visible relationships detected.");
  } else {
    for (const relationship of relationships) {
      lines.push(`- ${formatRelationship(relationship)}`);
    }
  }

  lines.push("", "## Gotchas", "");
  const gotchas = collectSchemaGotchas(context);
  if (gotchas.length === 0) {
    lines.push("- No saved gotchas yet.");
  } else {
    for (const gotcha of gotchas) {
      lines.push(`- ${gotcha}`);
    }
  }

  lines.push("", "## Common Queries", "");
  if (context.queryPatterns.length === 0) {
    lines.push("No query memories have been recorded yet.");
  } else {
    for (const pattern of context.queryPatterns.slice(0, 10)) {
      lines.push(`### ${pattern.description}`, "");
      lines.push(`Observed ${pattern.frequency} time(s).`);
      if (pattern.collection) {
        lines.push(`Primary collection: \`${pattern.collection}\`.`);
      }
      if (pattern.exampleQuery) {
        lines.push("", "```json", formatJsonExample(pattern.exampleQuery), "```");
      }
      lines.push("");
    }
  }

  return lines.join("\n");
}

export async function generateCollectionDetailMarkdown(
  connectionId: string,
  collectionName: string
): Promise<string | null> {
  const context = await loadSchemaContext(connectionId);
  const collection = context.collections.find((entry) => entry.table.name === collectionName);
  if (!collection) return null;

  const lines: string[] = [
    `# ${collection.table.name}`,
    "",
    collection.description,
    "",
    `Documents: ${collection.table.docCount.toLocaleString()}`,
  ];

  if (collection.hiddenFieldCount > 0) {
    lines.push(`Visible fields shown below. ${collection.hiddenFieldCount} hidden field(s) are omitted for privacy.`);
  }

  lines.push("", "## Fields", "");
  const fields = buildDisplayFields(collection.visibleFields);
  if (fields.length === 0) {
    lines.push("No visible fields have been sampled yet.");
  } else {
    lines.push("| Field | Type | Sample |");
    lines.push("| --- | --- | --- |");
    for (const field of fields) {
      lines.push(
        `| ${escapeTableCell(field.name)} | ${escapeTableCell(field.fieldType)} | ${escapeTableCell(field.sampleValue ?? "—")} |`
      );
    }
  }

  lines.push("", "## Relationships From This Collection", "");
  if (collection.outgoingRelationships.length === 0) {
    lines.push("No outgoing relationships detected.");
  } else {
    for (const relationship of collection.outgoingRelationships) {
      lines.push(`- ${formatRelationship(relationship)}`);
    }
  }

  lines.push("", "## Collections That Point Here", "");
  if (collection.incomingRelationships.length === 0) {
    lines.push("No incoming relationships detected.");
  } else {
    for (const relationship of collection.incomingRelationships) {
      lines.push(`- ${formatRelationship(relationship)}`);
    }
  }

  lines.push("", "## Known Gotchas", "");
  const gotchas = collectCollectionGotchas(collection, context.insights);
  if (gotchas.length === 0) {
    lines.push("- No saved gotchas for this collection yet.");
  } else {
    for (const gotcha of gotchas) {
      lines.push(`- ${gotcha}`);
    }
  }

  lines.push("", "## Working Query Examples", "");
  const examples = collectCollectionExamples(collection.table.name, context.queryPatterns, context.insights);
  if (examples.length === 0) {
    lines.push("No saved examples for this collection yet.");
  } else {
    for (const example of examples) {
      lines.push(`### ${example.title}`, "");
      if (example.detail) {
        lines.push(example.detail, "");
      }
      lines.push("```json", formatJsonExample(example.query), "```", "");
    }
  }

  return lines.join("\n");
}

export async function generateSchemaMarkdown(connectionId: string): Promise<string> {
  return generateSchemaOverviewMarkdown(connectionId);
}

async function loadSchemaContext(connectionId: string): Promise<SchemaContext> {
  const tables = await db
    .select()
    .from(schemaTables)
    .where(eq(schemaTables.connectionId, connectionId));

  const tableIds = tables.map((table) => table.id);
  const [columns, relationships, queryPatterns, insights] = await Promise.all([
    tableIds.length > 0
      ? db.select().from(schemaColumns).where(inArray(schemaColumns.tableId, tableIds))
      : Promise.resolve([] as ColumnRow[]),
    db
      .select()
      .from(schemaRelationships)
      .where(eq(schemaRelationships.connectionId, connectionId)),
    db
      .select()
      .from(queryMemories)
      .where(eq(queryMemories.connectionId, connectionId))
      .orderBy(desc(queryMemories.frequency), desc(queryMemories.lastUsedAt))
      .limit(20),
    loadInsights(connectionId),
  ]);

  const columnsByTable = new Map<string, ColumnRow[]>();
  for (const column of columns) {
    const current = columnsByTable.get(column.tableId) ?? [];
    current.push(column);
    columnsByTable.set(column.tableId, current);
  }

  const collections: CollectionContext[] = [];

  for (const table of tables) {
    const allFields = columnsByTable.get(table.id) ?? [];
    if (!shouldExposeCollection(table, allFields)) continue;

    const visibleFields = allFields.filter((field) => field.isVisible);
    const outgoingRelationships = buildRelationshipViews(table, relationships, tables, "outgoing");
    const incomingRelationships = buildRelationshipViews(table, relationships, tables, "incoming");
    const keyFields = deriveKeyFields(visibleFields);

    collections.push({
      table,
      visibleFields,
      hiddenFieldCount: allFields.length - visibleFields.length,
      description: table.description ?? describeCollection(table.name, keyFields, outgoingRelationships, allFields.length),
      outgoingRelationships,
      incomingRelationships,
    });
  }

  const accessibleTableIds = new Set(collections.map((collection) => collection.table.id));
  for (const collection of collections) {
    collection.outgoingRelationships = collection.outgoingRelationships.filter(
      (relationship) =>
        accessibleTableIds.has(
          tables.find((table) => table.name === relationship.targetCollection)?.id ?? ""
        )
    );
    collection.incomingRelationships = collection.incomingRelationships.filter(
      (relationship) =>
        accessibleTableIds.has(
          tables.find((table) => table.name === relationship.sourceCollection)?.id ?? ""
        )
    );
  }

  return {
    collections: collections.sort((left, right) => left.table.name.localeCompare(right.table.name)),
    hiddenCollectionCount: tables.length - collections.length,
    queryPatterns,
    insights,
  };
}

async function loadInsights(connectionId: string): Promise<InsightRow[]> {
  return db
    .select()
    .from(agentInsights)
    .where(eq(agentInsights.connectionId, connectionId))
    .orderBy(
      desc(agentInsights.useCount),
      desc(agentInsights.lastConfirmedAt),
      desc(agentInsights.createdAt)
    )
    .limit(100);
}

function shouldExposeCollection(table: TableRow, fields: ColumnRow[]): boolean {
  if (!table.isVisible) return false;
  if (fields.length === 0) return true;
  return fields.some((field) => field.isVisible);
}

function buildRelationshipViews(
  table: TableRow,
  relationships: RelationshipRow[],
  tables: TableRow[],
  direction: "outgoing" | "incoming"
): RelationshipView[] {
  return relationships
    .filter((relationship) =>
      direction === "outgoing"
        ? relationship.sourceTableId === table.id
        : relationship.targetTableId === table.id
    )
    .map((relationship) => {
      const sourceTable = tables.find((candidate) => candidate.id === relationship.sourceTableId);
      const targetTable = tables.find((candidate) => candidate.id === relationship.targetTableId);
      if (!sourceTable || !targetTable) return null;

      return {
        sourceCollection: sourceTable.name,
        sourceField: relationship.sourceField,
        targetCollection: targetTable.name,
        targetField: relationship.targetField,
        relationType: relationship.relationType,
      };
    })
    .filter((relationship): relationship is RelationshipView => relationship !== null);
}

function deriveKeyFields(fields: ColumnRow[]): string[] {
  return buildDisplayFields(fields)
    .map((field) => field.name)
    .filter((fieldName) => fieldName !== "_id")
    .slice(0, 4);
}

function describeCollection(
  collectionName: string,
  keyFields: string[],
  relationships: RelationshipView[],
  allFieldCount: number
): string {
  const parts: string[] = [];
  if (keyFields.length > 0) {
    parts.push(`Key fields: ${keyFields.join(", ")}`);
  }

  const linkedCollections = [...new Set(relationships.map((relationship) => relationship.targetCollection))];
  if (linkedCollections.length > 0) {
    parts.push(`Connects to ${linkedCollections.join(", ")}`);
  }

  if (parts.length === 0 && allFieldCount === 0) {
    return `${collectionName} is present, but no fields have been sampled yet.`;
  }

  if (parts.length === 0) {
    return `Visible fields are available for querying in ${collectionName}.`;
  }

  return parts.join(". ") + ".";
}

function collectSchemaGotchas(context: SchemaContext): string[] {
  const savedGotchas = context.insights
    .filter((insight) => insight.category === "gotcha")
    .map((insight) => formatInsightBullet(insight))
    .slice(0, 8);

  const derivedGotchas = deriveStructuralGotchas(context.collections);
  return dedupeStrings([...savedGotchas, ...derivedGotchas]).slice(0, 10);
}

function collectCollectionGotchas(collection: CollectionContext, insights: InsightRow[]): string[] {
  const savedGotchas = insights
    .filter(
      (insight) =>
        insight.category === "gotcha" &&
        (insight.collection === null || insight.collection === collection.table.name)
    )
    .map((insight) =>
      insight.collection && insight.collection !== collection.table.name
        ? `${insight.collection}: ${insight.insight}`
        : insight.insight
    );

  const derived = deriveCollectionStructuralGotchas(collection);
  return dedupeStrings([...savedGotchas, ...derived]).slice(0, 8);
}

function deriveStructuralGotchas(collections: CollectionContext[]): string[] {
  return dedupeStrings(
    collections.flatMap((collection) => deriveCollectionStructuralGotchas(collection))
  ).slice(0, 6);
}

function deriveCollectionStructuralGotchas(collection: CollectionContext): string[] {
  const gotchas: string[] = [];
  const arrayFields = collection.visibleFields.filter((field) => field.fieldType === "Array");
  if (arrayFields.length > 0) {
    gotchas.push(
      `${collection.table.name}: ${arrayFields
        .slice(0, 3)
        .map((field) => field.name)
        .join(", ")} are Array fields; use array-aware filters and unwind them before grouping individual elements.`
    );
  }

  const stringDates = collection.visibleFields.filter(
    (field) => field.fieldType === "String" && looksLikeDateField(field.name)
  );
  if (stringDates.length > 0) {
    gotchas.push(
      `${collection.table.name}: ${stringDates
        .slice(0, 3)
        .map((field) => field.name)
        .join(", ")} look date-like but sample as String; confirm the stored format before using date operators.`
    );
  }

  const nestedFields = collection.visibleFields.filter((field) => field.name.includes("."));
  if (nestedFields.length > 0) {
    gotchas.push(
      `${collection.table.name}: nested fields such as ${nestedFields
        .slice(0, 3)
        .map((field) => field.name)
        .join(", ")} use dot notation in filters and projections.`
    );
  }

  return gotchas;
}

function collectCollectionExamples(
  collectionName: string,
  queryPatterns: QueryMemoryRow[],
  insights: InsightRow[]
) {
  const examples: Array<{ title: string; detail: string | null; query: string; weight: number }> = [];
  const seenQueries = new Set<string>();

  for (const insight of insights) {
    if (insight.collection !== collectionName || !insight.exampleQuery) continue;
    const signature = insight.exampleQuery.trim();
    if (seenQueries.has(signature)) continue;
    seenQueries.add(signature);
    examples.push({
      title: insight.category === "pattern" ? insight.insight : `Insight: ${insight.insight}`,
      detail: `Confirmed ${insight.useCount} time(s) by agents.`,
      query: insight.exampleQuery,
      weight: 1000 + insight.useCount,
    });
  }

  for (const memory of queryPatterns) {
    if (memory.collection !== collectionName || !memory.exampleQuery) continue;
    const signature = memory.exampleQuery.trim();
    if (seenQueries.has(signature)) continue;
    seenQueries.add(signature);
    examples.push({
      title: memory.description,
      detail: `Observed ${memory.frequency} time(s) from actual query history.`,
      query: memory.exampleQuery,
      weight: memory.frequency,
    });
  }

  return examples
    .sort((left, right) => right.weight - left.weight || left.title.localeCompare(right.title))
    .slice(0, 6);
}

function buildDisplayFields(fields: ColumnRow[]) {
  const displayFields = [
    { name: "_id", fieldType: "ObjectId", sampleValue: "MongoDB document id" },
    ...fields.map((field) => ({
      name: field.name,
      fieldType: field.fieldType,
      sampleValue: field.sampleValue,
    })),
  ];

  return displayFields.sort((left, right) => {
    const groupDifference = fieldGroup(left.name) - fieldGroup(right.name);
    if (groupDifference !== 0) return groupDifference;
    return left.name.localeCompare(right.name);
  });
}

function fieldGroup(name: string): number {
  if (name === "_id" || looksLikeIdField(name)) return 0;
  if (looksLikeDateField(name)) return 2;
  return 1;
}

function looksLikeIdField(name: string): boolean {
  const leaf = name.split(".").pop() ?? name;
  return /(^id$|Id$|_id$|Ids$|_ids$|Ref$|_ref$)/.test(leaf);
}

function looksLikeDateField(name: string): boolean {
  const leaf = name.split(".").pop() ?? name;
  return /(At$|_at$|Date$|_date$|Timestamp$|_timestamp$)/i.test(leaf);
}

function formatRelationship(relationship: RelationshipView): string {
  const arrow = relationship.relationType === "hasMany" ? "->>" : "->";
  return `\`${relationship.sourceCollection}.${relationship.sourceField}\` ${arrow} \`${relationship.targetCollection}.${relationship.targetField}\` (${relationship.relationType})`;
}

function formatInsightBullet(insight: InsightRow): string {
  const prefix = insight.collection ? `${insight.collection}: ` : "";
  const example = insight.exampleQuery ? " Includes a saved example query." : "";
  return `${prefix}${insight.insight}${example}`;
}

function formatJsonExample(query: string): string {
  try {
    return JSON.stringify(JSON.parse(query), null, 2);
  } catch {
    return query.trim();
  }
}

function escapeTableCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ").replace(/\r/g, " ");
}

function dedupeRelationshipViews(relationships: RelationshipView[]): RelationshipView[] {
  const seen = new Set<string>();
  const deduped: RelationshipView[] = [];
  for (const relationship of relationships) {
    const key = [
      relationship.sourceCollection,
      relationship.sourceField,
      relationship.targetCollection,
      relationship.targetField,
      relationship.relationType,
    ].join(":");
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(relationship);
  }
  return deduped;
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values)];
}
