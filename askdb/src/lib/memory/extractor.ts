import { db } from "@/lib/db";
import { auditLogs, queryMemories } from "@/lib/db/schema";
import { eq, and, desc } from "drizzle-orm";

interface ParsedQuery {
  collection: string;
  operation: string;
  filter?: Record<string, unknown>;
  pipeline?: Record<string, unknown>[];
}

/**
 * Extract patterns from audit logs and upsert into query_memories.
 * Call this periodically or after a batch of queries.
 */
export async function extractPatterns(connectionId: string) {
  // Fetch recent audit logs with query data
  const logs = await db
    .select()
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.connectionId, connectionId),
        eq(auditLogs.action, "query")
      )
    )
    .orderBy(desc(auditLogs.createdAt))
    .limit(500);

  // Group by pattern
  const patterns = new Map<string, {
    count: number;
    description: string;
    exampleQuery: string;
    collection: string;
    lastUsed: Date;
  }>();

  for (const log of logs) {
    if (!log.query) continue;

    let parsed: ParsedQuery;
    try {
      parsed = JSON.parse(log.query);
    } catch {
      continue;
    }

    const patternKey = derivePatternKey(parsed);
    if (!patternKey) continue;

    const existing = patterns.get(patternKey);
    if (existing) {
      existing.count++;
      if (log.createdAt > existing.lastUsed) {
        existing.lastUsed = log.createdAt;
        existing.exampleQuery = log.query;
      }
    } else {
      patterns.set(patternKey, {
        count: 1,
        description: deriveDescription(parsed),
        exampleQuery: log.query,
        collection: parsed.collection,
        lastUsed: log.createdAt,
      });
    }
  }

  // Upsert patterns into query_memories (only patterns seen 2+ times)
  for (const [pattern, data] of patterns) {
    if (data.count < 2) continue;

    const [existing] = await db
      .select()
      .from(queryMemories)
      .where(
        and(
          eq(queryMemories.connectionId, connectionId),
          eq(queryMemories.pattern, pattern)
        )
      );

    if (existing) {
      await db
        .update(queryMemories)
        .set({
          frequency: data.count,
          exampleQuery: data.exampleQuery,
          lastUsedAt: data.lastUsed,
        })
        .where(eq(queryMemories.id, existing.id));
    } else {
      await db.insert(queryMemories).values({
        connectionId,
        pattern,
        description: data.description,
        exampleQuery: data.exampleQuery,
        collection: data.collection,
        frequency: data.count,
        lastUsedAt: data.lastUsed,
      });
    }
  }
}

/**
 * Derive a stable pattern key from a query.
 * Strips specific filter values to group similar queries.
 *
 * e.g. find on users with status filter → "find:users:status"
 * e.g. aggregate on orders with $group by date → "aggregate:orders:$group"
 */
function derivePatternKey(parsed: ParsedQuery): string | null {
  const { collection, operation } = parsed;
  if (!collection || !operation) return null;

  if (operation === "find" && parsed.filter) {
    const filterKeys = Object.keys(parsed.filter).sort().join(",");
    return `find:${collection}:${filterKeys || "*"}`;
  }

  if (operation === "aggregate" && parsed.pipeline) {
    const stages = parsed.pipeline
      .map((stage) => Object.keys(stage)[0])
      .join(",");
    return `aggregate:${collection}:${stages}`;
  }

  if (operation === "count") {
    const filterKeys = parsed.filter
      ? Object.keys(parsed.filter).sort().join(",")
      : "*";
    return `count:${collection}:${filterKeys}`;
  }

  if (operation === "distinct") {
    return `distinct:${collection}`;
  }

  return `${operation}:${collection}`;
}

/** Generate a human-readable description from a parsed query */
function deriveDescription(parsed: ParsedQuery): string {
  const { collection, operation, filter, pipeline } = parsed;

  if (operation === "find") {
    if (!filter || Object.keys(filter).length === 0) {
      return `Find all documents in ${collection}`;
    }
    const fields = Object.keys(filter).join(", ");
    return `Find ${collection} filtered by ${fields}`;
  }

  if (operation === "aggregate" && pipeline) {
    const stages = pipeline.map((s) => Object.keys(s)[0]).join(" → ");
    return `Aggregate ${collection}: ${stages}`;
  }

  if (operation === "count") {
    if (!filter || Object.keys(filter).length === 0) {
      return `Count all documents in ${collection}`;
    }
    const fields = Object.keys(filter).join(", ");
    return `Count ${collection} filtered by ${fields}`;
  }

  if (operation === "distinct") {
    return `Get distinct values from ${collection}`;
  }

  return `${operation} on ${collection}`;
}

/**
 * Record a single query for memory tracking.
 * Lightweight — called on each MCP query tool call.
 * Pattern extraction happens separately via extractPatterns().
 */
export async function recordQueryForMemory(
  connectionId: string,
  queryStr: string
) {
  let parsed: ParsedQuery;
  try {
    parsed = JSON.parse(queryStr);
  } catch {
    return;
  }

  const patternKey = derivePatternKey(parsed);
  if (!patternKey) return;

  // Quick upsert: if pattern exists, bump frequency. Otherwise create with frequency 1.
  const [existing] = await db
    .select()
    .from(queryMemories)
    .where(
      and(
        eq(queryMemories.connectionId, connectionId),
        eq(queryMemories.pattern, patternKey)
      )
    );

  if (existing) {
    await db
      .update(queryMemories)
      .set({
        frequency: existing.frequency + 1,
        exampleQuery: queryStr,
        lastUsedAt: new Date(),
      })
      .where(eq(queryMemories.id, existing.id));
  } else {
    await db.insert(queryMemories).values({
      connectionId,
      pattern: patternKey,
      description: deriveDescription(parsed),
      exampleQuery: queryStr,
      collection: parsed.collection,
      frequency: 1,
      lastUsedAt: new Date(),
    });
  }
}
