import { db } from "@/lib/db";
import {
  schemaTables,
  schemaColumns,
  schemaRelationships,
  queryMemories,
} from "@/lib/db/schema";
import { eq, and, desc } from "drizzle-orm";

interface TableSummary {
  name: string;
  description: string | null;
  docCount: number;
  isVisible: boolean;
  fields: FieldSummary[];
  relationships: RelationshipSummary[];
}

interface FieldSummary {
  name: string;
  type: string;
  sampleValue: string | null;
  isVisible: boolean;
  piiConfidence: string;
}

interface RelationshipSummary {
  sourceField: string;
  targetTable: string;
  targetField: string;
  relationType: string;
}

interface MemorySummary {
  pattern: string;
  description: string;
  exampleQuery: string | null;
  collection: string | null;
  frequency: number;
}

interface SchemaSummary {
  tables: TableSummary[];
  memories: MemorySummary[];
}

/** Build the full schema summary for a connection */
export async function buildSchemaSummary(connectionId: string): Promise<SchemaSummary> {
  const tables = await db
    .select()
    .from(schemaTables)
    .where(eq(schemaTables.connectionId, connectionId));

  const tableSummaries: TableSummary[] = [];

  for (const table of tables) {
    const columns = await db
      .select()
      .from(schemaColumns)
      .where(eq(schemaColumns.tableId, table.id));

    // Get relationships where this table is the source
    const rels = await db
      .select()
      .from(schemaRelationships)
      .where(eq(schemaRelationships.sourceTableId, table.id));

    const relSummaries: RelationshipSummary[] = [];
    for (const rel of rels) {
      const targetTable = tables.find((t) => t.id === rel.targetTableId);
      if (targetTable) {
        relSummaries.push({
          sourceField: rel.sourceField,
          targetTable: targetTable.name,
          targetField: rel.targetField,
          relationType: rel.relationType,
        });
      }
    }

    tableSummaries.push({
      name: table.name,
      description: table.description,
      docCount: table.docCount,
      isVisible: table.isVisible,
      fields: columns.map((c) => ({
        name: c.name,
        type: c.fieldType,
        sampleValue: c.sampleValue,
        isVisible: c.isVisible,
        piiConfidence: c.piiConfidence,
      })),
      relationships: relSummaries,
    });
  }

  // Get query memories
  const memories = await db
    .select()
    .from(queryMemories)
    .where(eq(queryMemories.connectionId, connectionId))
    .orderBy(desc(queryMemories.frequency))
    .limit(20);

  return {
    tables: tableSummaries,
    memories: memories.map((m) => ({
      pattern: m.pattern,
      description: m.description,
      exampleQuery: m.exampleQuery,
      collection: m.collection,
      frequency: m.frequency,
    })),
  };
}

/** Generate a markdown summary optimized for AI agent context */
export async function generateSchemaMarkdown(connectionId: string): Promise<string> {
  const summary = await buildSchemaSummary(connectionId);

  const lines: string[] = [];
  lines.push("# Database Schema\n");

  // Visible tables first, then note hidden count
  const visible = summary.tables.filter((t) => t.isVisible);
  const hiddenCount = summary.tables.length - visible.length;

  for (const table of visible) {
    const visibleFields = table.fields.filter((f) => f.isVisible);
    if (visibleFields.length === 0) continue; // skip tables with all fields hidden

    lines.push(`## ${table.name} (${table.docCount.toLocaleString()} documents)\n`);

    if (table.description) {
      lines.push(`${table.description}\n`);
    }

    lines.push("### Fields\n");
    lines.push("| Field | Type | Sample |");
    lines.push("|-------|------|--------|");
    for (const field of visibleFields) {
      const sample = field.sampleValue
        ? truncate(field.sampleValue, 50)
        : "—";
      lines.push(`| ${field.name} | ${field.type} | ${sample} |`);
    }
    lines.push("");

    // Hidden field count
    const hiddenFields = table.fields.filter((f) => !f.isVisible);
    if (hiddenFields.length > 0) {
      lines.push(`*${hiddenFields.length} field(s) hidden for privacy*\n`);
    }

    // Relationships
    if (table.relationships.length > 0) {
      lines.push("### Relationships\n");
      for (const rel of table.relationships) {
        const arrow = rel.relationType === "belongsTo" ? "→" : "→→";
        lines.push(`- \`${rel.sourceField}\` ${arrow} **${rel.targetTable}** (${rel.relationType})`);
      }
      lines.push("");
    }

    // Incoming references (tables that point to this one)
    const incomingRefs: { fromTable: string; fromField: string; relationType: string }[] = [];
    for (const otherTable of visible) {
      for (const rel of otherTable.relationships) {
        if (rel.targetTable === table.name) {
          incomingRefs.push({
            fromTable: otherTable.name,
            fromField: rel.sourceField,
            relationType: rel.relationType,
          });
        }
      }
    }
    if (incomingRefs.length > 0) {
      lines.push("### Referenced By\n");
      for (const ref of incomingRefs) {
        lines.push(`- **${ref.fromTable}**.${ref.fromField}`);
      }
      lines.push("");
    }

    lines.push("---\n");
  }

  if (hiddenCount > 0) {
    lines.push(`*${hiddenCount} collection(s) hidden for privacy*\n`);
  }

  // Query patterns / memories
  if (summary.memories.length > 0) {
    lines.push("## Common Query Patterns\n");
    for (const mem of summary.memories) {
      lines.push(`- **${mem.pattern}** (used ${mem.frequency}x)`);
      lines.push(`  ${mem.description}`);
      if (mem.exampleQuery) {
        lines.push(`  \`\`\`json\n  ${mem.exampleQuery}\n  \`\`\``);
      }
    }
    lines.push("");
  }

  return lines.join("\n");
}

function truncate(str: string, max: number): string {
  return str.length > max ? str.slice(0, max) + "…" : str;
}
