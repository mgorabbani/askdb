// MCP server — separate Express process on port 3001
// Runs independently from Next.js.
//
// Usage:
//   pnpm dev:mcp   (development)
//   pnpm start:mcp (production)

import "dotenv/config";

import { randomUUID } from "node:crypto";
import { createHash, createDecipheriv } from "crypto";
import { existsSync } from "fs";
import path from "path";

const MONGO_HOST = existsSync("/.dockerenv") ? "host.docker.internal" : "localhost";

import express from "express";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { eq, and, isNull, inArray } from "drizzle-orm";
import { MongoClient, type Db as MongoDb } from "mongodb";
import { z } from "zod";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

// ── Re-import schema (can't use @/ alias in standalone tsx) ─────────
import {
  apiKeys,
  connections,
  schemaTables,
  schemaColumns,
  schemaRelationships,
  queryMemories,
  auditLogs,
} from "../lib/db/schema.js";

// ── Own DB connection (standalone process) ──────────────────────────
const dbPath =
  process.env.DATABASE_PATH ||
  path.resolve(process.cwd(), "data", "askdb.db");

const sqlite = new Database(dbPath);
sqlite.pragma("journal_mode = WAL");
const db = drizzle(sqlite);

// ── Helpers ─────────────────────────────────────────────────────────

function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

function decrypt(encoded: string): string {
  const hex = process.env.ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error("ENCRYPTION_KEY must be a 64-char hex string (32 bytes)");
  }
  const encKey = Buffer.from(hex, "hex");
  const [ivHex, authTagHex, ciphertextHex] = encoded.split(":");
  if (!ivHex || !authTagHex || !ciphertextHex) {
    throw new Error("Invalid encrypted format");
  }
  const iv = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(authTagHex, "hex");
  const ciphertext = Buffer.from(ciphertextHex, "hex");
  const decipher = createDecipheriv("aes-256-gcm", encKey, iv);
  decipher.setAuthTag(authTag);
  let decrypted = decipher.update(ciphertext);
  decrypted = Buffer.concat([decrypted, decipher.final()]);
  return decrypted.toString("utf8");
}

// ── Auth: resolve bearer token → userId + apiKeyId + connectionId ───

interface AuthContext {
  userId: string;
  apiKeyId: string;
  connectionId: string;
  sandboxPort: number;
}

function authenticate(authHeader: string | undefined): AuthContext | null {
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7);
  if (!token.startsWith("ask_sk_")) return null;

  const hash = hashKey(token);

  // Look up the API key (not revoked)
  const keyRow = db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.keyHash, hash), isNull(apiKeys.revokedAt)))
    .get();

  if (!keyRow) return null;

  // Find the user's connection (take first active one)
  const conn = db
    .select()
    .from(connections)
    .where(eq(connections.userId, keyRow.userId))
    .get();

  if (!conn || !conn.sandboxPort) return null;

  return {
    userId: keyRow.userId,
    apiKeyId: keyRow.id,
    connectionId: conn.id,
    sandboxPort: conn.sandboxPort,
  };
}

// ── MongoDB helpers ─────────────────────────────────────────────────

const mongoClients = new Map<number, MongoClient>();

async function getMongoDb(port: number): Promise<MongoDb> {
  let client = mongoClients.get(port);
  if (!client) {
    const uri = `mongodb://${MONGO_HOST}:${port}`;
    client = new MongoClient(uri, {
      serverSelectionTimeoutMS: 5000,
      connectTimeoutMS: 5000,
    });
    await client.connect();
    mongoClients.set(port, client);
  }
  // Use the first non-system database. The sandbox mirrors the user's DB;
  // we need to discover which DB has their collections.
  const adminDb = client.db("admin");
  const dbs = await adminDb.admin().listDatabases();
  const userDb = dbs.databases.find(
    (d) => !["admin", "local", "config"].includes(d.name)
  );
  return client.db(userDb?.name ?? "test");
}

// ── Schema helpers ──────────────────────────────────────────────────

function getVisibleTables(connectionId: string) {
  return db
    .select()
    .from(schemaTables)
    .where(
      and(
        eq(schemaTables.connectionId, connectionId),
        eq(schemaTables.isVisible, true)
      )
    )
    .all();
}

function getHiddenTableNames(connectionId: string): Set<string> {
  const rows = db
    .select({ name: schemaTables.name })
    .from(schemaTables)
    .where(
      and(
        eq(schemaTables.connectionId, connectionId),
        eq(schemaTables.isVisible, false)
      )
    )
    .all();
  return new Set(rows.map((r) => r.name));
}

function getVisibleColumns(tableId: string) {
  return db
    .select()
    .from(schemaColumns)
    .where(
      and(eq(schemaColumns.tableId, tableId), eq(schemaColumns.isVisible, true))
    )
    .all();
}

function getHiddenFieldNames(connectionId: string): Set<string> {
  // Get all table IDs for this connection
  const tables = db
    .select({ id: schemaTables.id })
    .from(schemaTables)
    .where(eq(schemaTables.connectionId, connectionId))
    .all();

  if (tables.length === 0) return new Set();

  const tableIds = tables.map((t) => t.id);
  const hiddenCols = db
    .select({ name: schemaColumns.name })
    .from(schemaColumns)
    .where(
      and(
        inArray(schemaColumns.tableId, tableIds),
        eq(schemaColumns.isVisible, false)
      )
    )
    .all();

  return new Set(hiddenCols.map((c) => c.name));
}

/** Strip hidden fields from a document (supports dot notation). */
function stripFields(doc: Record<string, unknown>, hidden: Set<string>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(doc)) {
    if (hidden.has(key)) continue;
    if (value && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date)) {
      // Check nested dot-notation fields
      const nested = stripFieldsNested(key, value as Record<string, unknown>, hidden);
      if (Object.keys(nested).length > 0) {
        result[key] = nested;
      }
    } else {
      result[key] = value;
    }
  }
  return result;
}

function stripFieldsNested(
  prefix: string,
  obj: Record<string, unknown>,
  hidden: Set<string>
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    const fullPath = `${prefix}.${key}`;
    if (hidden.has(fullPath)) continue;
    if (value && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date)) {
      const nested = stripFieldsNested(fullPath, value as Record<string, unknown>, hidden);
      if (Object.keys(nested).length > 0) {
        result[key] = nested;
      }
    } else {
      result[key] = value;
    }
  }
  return result;
}

/** Write an audit log entry. */
function writeAuditLog(
  action: string,
  connectionId: string,
  apiKeyId: string,
  opts: { query?: string; collection?: string; executionMs?: number; docCount?: number } = {}
) {
  db.insert(auditLogs)
    .values({
      id: randomUUID(),
      action,
      connectionId,
      apiKeyId,
      query: opts.query ?? null,
      collection: opts.collection ?? null,
      executionMs: opts.executionMs ?? 0,
      docCount: opts.docCount ?? 0,
      createdAt: new Date(),
    })
    .run();
}

// ── Memory: real-time query pattern tracking ────────────────────────

function recordQueryPattern(connectionId: string, queryStr: string) {
  let parsed: { collection?: string; operation?: string; filter?: Record<string, unknown>; pipeline?: Record<string, unknown>[] };
  try {
    parsed = JSON.parse(queryStr);
  } catch {
    return;
  }

  const { collection, operation, filter, pipeline } = parsed;
  if (!collection || !operation) return;

  // Derive a stable pattern key (strips specific values)
  let patternKey: string;
  if (operation === "find") {
    const filterKeys = filter ? Object.keys(filter).sort().join(",") : "*";
    patternKey = `find:${collection}:${filterKeys}`;
  } else if (operation === "aggregate" && pipeline) {
    const stages = pipeline.map((s) => Object.keys(s)[0]).join(",");
    patternKey = `aggregate:${collection}:${stages}`;
  } else if (operation === "count") {
    const filterKeys = filter ? Object.keys(filter).sort().join(",") : "*";
    patternKey = `count:${collection}:${filterKeys}`;
  } else {
    patternKey = `${operation}:${collection}`;
  }

  // Derive human-readable description
  let description: string;
  if (operation === "find" && filter && Object.keys(filter).length > 0) {
    description = `Find ${collection} filtered by ${Object.keys(filter).join(", ")}`;
  } else if (operation === "aggregate" && pipeline) {
    const stages = pipeline.map((s) => Object.keys(s)[0]).join(" → ");
    description = `Aggregate ${collection}: ${stages}`;
  } else if (operation === "count") {
    description = filter && Object.keys(filter).length > 0
      ? `Count ${collection} filtered by ${Object.keys(filter).join(", ")}`
      : `Count all documents in ${collection}`;
  } else {
    description = `${operation} on ${collection}`;
  }

  // Upsert
  const existing = db
    .select()
    .from(queryMemories)
    .where(and(eq(queryMemories.connectionId, connectionId), eq(queryMemories.pattern, patternKey)))
    .get();

  if (existing) {
    db.update(queryMemories)
      .set({ frequency: existing.frequency + 1, exampleQuery: queryStr, lastUsedAt: new Date() })
      .where(eq(queryMemories.id, existing.id))
      .run();
  } else {
    db.insert(queryMemories)
      .values({
        id: randomUUID(),
        connectionId,
        pattern: patternKey,
        description,
        exampleQuery: queryStr,
        collection,
        frequency: 1,
        lastUsedAt: new Date(),
        createdAt: new Date(),
      })
      .run();
  }
}

// ── Schema summary generator ────────────────────────────────────────

function generateSchemaMarkdown(connectionId: string): string {
  const tables = db.select().from(schemaTables)
    .where(eq(schemaTables.connectionId, connectionId)).all();

  const lines: string[] = ["# Database Schema\n"];

  const visible = tables.filter((t) => t.isVisible);
  const hiddenCount = tables.length - visible.length;

  for (const table of visible) {
    const columns = db.select().from(schemaColumns)
      .where(eq(schemaColumns.tableId, table.id)).all();

    const visibleFields = columns.filter((c) => c.isVisible);
    if (visibleFields.length === 0) continue;

    lines.push(`## ${table.name} (${table.docCount.toLocaleString()} documents)\n`);
    if (table.description) lines.push(`${table.description}\n`);

    lines.push("### Fields\n");
    lines.push("| Field | Type | Sample |");
    lines.push("|-------|------|--------|");
    for (const f of visibleFields) {
      const sample = f.sampleValue ? (f.sampleValue.length > 50 ? f.sampleValue.slice(0, 50) + "…" : f.sampleValue) : "—";
      lines.push(`| ${f.name} | ${f.fieldType} | ${sample} |`);
    }
    lines.push("");

    const hiddenFields = columns.filter((c) => !c.isVisible);
    if (hiddenFields.length > 0) {
      lines.push(`*${hiddenFields.length} field(s) hidden for privacy*\n`);
    }

    // Outgoing relationships
    const rels = db.select().from(schemaRelationships)
      .where(eq(schemaRelationships.sourceTableId, table.id)).all();

    if (rels.length > 0) {
      lines.push("### Relationships\n");
      for (const rel of rels) {
        const target = tables.find((t) => t.id === rel.targetTableId);
        if (target) {
          const arrow = rel.relationType === "belongsTo" ? "→" : "→→";
          lines.push(`- \`${rel.sourceField}\` ${arrow} **${target.name}** (${rel.relationType})`);
        }
      }
      lines.push("");
    }

    // Incoming references
    const incoming = db.select().from(schemaRelationships)
      .where(eq(schemaRelationships.targetTableId, table.id)).all();

    if (incoming.length > 0) {
      lines.push("### Referenced By\n");
      for (const ref of incoming) {
        const source = tables.find((t) => t.id === ref.sourceTableId);
        if (source) lines.push(`- **${source.name}**.${ref.sourceField}`);
      }
      lines.push("");
    }

    lines.push("---\n");
  }

  if (hiddenCount > 0) lines.push(`*${hiddenCount} collection(s) hidden for privacy*\n`);

  // Query memories
  const memories = db.select().from(queryMemories)
    .where(eq(queryMemories.connectionId, connectionId))
    .all()
    .sort((a, b) => b.frequency - a.frequency)
    .slice(0, 20);

  if (memories.length > 0) {
    lines.push("## Common Query Patterns\n");
    for (const m of memories) {
      lines.push(`- **${m.pattern}** (used ${m.frequency}x)`);
      lines.push(`  ${m.description}`);
      if (m.exampleQuery) lines.push(`  \`${m.exampleQuery}\``);
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ── Allowed operations & forbidden stages ───────────────────────────

const ALLOWED_OPS = new Set(["find", "aggregate", "count", "distinct"]);
const FORBIDDEN_STAGES = new Set([
  "$merge",
  "$out",
  "$collStats",
  "$currentOp",
  "$listSessions",
]);

// ── Build MCP server ────────────────────────────────────────────────

function createMcpServer(auth: AuthContext): McpServer {
  const server = new McpServer(
    { name: "askdb", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );

  // ── list_tables ─────────────────────────────────────────────────
  server.registerTool("list_tables", {
    description:
      "List all visible MongoDB collections with their document counts.",
    inputSchema: {},
  }, async () => {
    const start = Date.now();
    const tables = getVisibleTables(auth.connectionId);

    // Filter to only tables that have at least one visible column
    const result: { name: string; docCount: number }[] = [];
    for (const t of tables) {
      const visCols = getVisibleColumns(t.id);
      if (visCols.length > 0) {
        result.push({ name: t.name, docCount: t.docCount });
      }
    }

    writeAuditLog("list_tables", auth.connectionId, auth.apiKeyId, {
      executionMs: Date.now() - start,
      docCount: result.length,
    });

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  });

  // ── describe_table ──────────────────────────────────────────────
  server.registerTool("describe_table", {
    description:
      "Describe the visible fields of a MongoDB collection (name, type, sample value).",
    inputSchema: {
      table_name: z.string().describe("The collection name to describe"),
    },
  }, async ({ table_name }) => {
    const start = Date.now();

    const hiddenTables = getHiddenTableNames(auth.connectionId);
    if (hiddenTables.has(table_name)) {
      return {
        content: [{ type: "text" as const, text: `Collection "${table_name}" not found or is hidden.` }],
        isError: true,
      };
    }

    const table = db
      .select()
      .from(schemaTables)
      .where(
        and(
          eq(schemaTables.connectionId, auth.connectionId),
          eq(schemaTables.name, table_name),
          eq(schemaTables.isVisible, true)
        )
      )
      .get();

    if (!table) {
      return {
        content: [{ type: "text" as const, text: `Collection "${table_name}" not found.` }],
        isError: true,
      };
    }

    const cols = getVisibleColumns(table.id);
    const fields = cols.map((c) => ({
      name: c.name,
      type: c.fieldType,
      sampleValue: c.sampleValue,
    }));

    writeAuditLog("describe_table", auth.connectionId, auth.apiKeyId, {
      collection: table_name,
      executionMs: Date.now() - start,
      docCount: fields.length,
    });

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(fields, null, 2),
        },
      ],
    };
  });

  // ── query ───────────────────────────────────────────────────────
  server.registerTool("query", {
    description:
      "Execute a read-only MongoDB query. JSON format: {collection, operation, filter?, pipeline?, field?, limit?}. Allowed operations: find, aggregate, count, distinct.",
    inputSchema: {
      query: z
        .string()
        .describe(
          'JSON query object, e.g. {"collection":"users","operation":"find","filter":{"status":"active"}}'
        ),
    },
  }, async ({ query: queryStr }) => {
    const start = Date.now();
    let parsed: {
      collection: string;
      operation: string;
      filter?: Record<string, unknown>;
      pipeline?: Record<string, unknown>[];
      field?: string;
      limit?: number;
    };

    try {
      parsed = JSON.parse(queryStr);
    } catch {
      return {
        content: [{ type: "text" as const, text: "Invalid JSON in query parameter." }],
        isError: true,
      };
    }

    const { collection, operation, filter, pipeline, field, limit } = parsed;

    // Validate operation
    if (!ALLOWED_OPS.has(operation)) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Operation "${operation}" is not allowed. Allowed: ${[...ALLOWED_OPS].join(", ")}`,
          },
        ],
        isError: true,
      };
    }

    // Reject hidden collections
    const hiddenTables = getHiddenTableNames(auth.connectionId);
    if (hiddenTables.has(collection)) {
      return {
        content: [{ type: "text" as const, text: `Collection "${collection}" is not accessible.` }],
        isError: true,
      };
    }

    // Validate aggregation pipeline
    if (operation === "aggregate" && pipeline) {
      for (const stage of pipeline) {
        const stageKey = Object.keys(stage)[0];
        if (FORBIDDEN_STAGES.has(stageKey)) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Aggregation stage "${stageKey}" is forbidden.`,
              },
            ],
            isError: true,
          };
        }
        // Check $lookup references to hidden collections
        if (stageKey === "$lookup") {
          const lookup = stage["$lookup"] as Record<string, unknown>;
          if (lookup.from && hiddenTables.has(lookup.from as string)) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `$lookup references hidden collection "${lookup.from}".`,
                },
              ],
              isError: true,
            };
          }
        }
      }
    }

    const hiddenFields = getHiddenFieldNames(auth.connectionId);
    const maxDocs = Math.min(limit ?? 500, 500);

    try {
      const mongoDb = await getMongoDb(auth.sandboxPort);
      const coll = mongoDb.collection(collection);
      let docs: Record<string, unknown>[];

      switch (operation) {
        case "find": {
          docs = (await coll
            .find(filter ?? {})
            .limit(maxDocs)
            .maxTimeMS(10_000)
            .toArray()) as Record<string, unknown>[];
          break;
        }
        case "aggregate": {
          docs = (await coll
            .aggregate(pipeline ?? [], { maxTimeMS: 10_000 })
            .toArray()) as Record<string, unknown>[];
          docs = docs.slice(0, maxDocs);
          break;
        }
        case "count": {
          const count = await coll.countDocuments(filter ?? {}, {
            maxTimeMS: 10_000,
          });
          const elapsed = Date.now() - start;
          writeAuditLog("query", auth.connectionId, auth.apiKeyId, {
            query: queryStr,
            collection,
            executionMs: elapsed,
            docCount: 1,
          });
          recordQueryPattern(auth.connectionId, queryStr);
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ count }) }],
          };
        }
        case "distinct": {
          const values = await coll.distinct(field ?? "_id", filter ?? {}, {
            maxTimeMS: 10_000,
          });
          const limited = values.slice(0, maxDocs);
          const elapsed = Date.now() - start;
          writeAuditLog("query", auth.connectionId, auth.apiKeyId, {
            query: queryStr,
            collection,
            executionMs: elapsed,
            docCount: limited.length,
          });
          recordQueryPattern(auth.connectionId, queryStr);
          return {
            content: [
              { type: "text" as const, text: JSON.stringify(limited, null, 2) },
            ],
          };
        }
        default:
          return {
            content: [{ type: "text" as const, text: `Unsupported operation: ${operation}` }],
            isError: true,
          };
      }

      // Strip hidden fields
      const cleaned = docs.map((d) => stripFields(d, hiddenFields));
      const elapsed = Date.now() - start;

      writeAuditLog("query", auth.connectionId, auth.apiKeyId, {
        query: queryStr,
        collection,
        executionMs: elapsed,
        docCount: cleaned.length,
      });

      // Track query pattern for memory system
      recordQueryPattern(auth.connectionId, queryStr);

      return {
        content: [
          { type: "text" as const, text: JSON.stringify(cleaned, null, 2) },
        ],
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text" as const, text: `Query error: ${msg}` }],
        isError: true,
      };
    }
  });

  // ── sample_data ─────────────────────────────────────────────────
  server.registerTool("sample_data", {
    description:
      "Get random sample documents from a collection using $sample aggregation.",
    inputSchema: {
      table_name: z.string().describe("The collection name to sample from"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(20)
        .default(5)
        .describe("Number of sample documents (max 20)"),
    },
  }, async ({ table_name, limit }) => {
    const start = Date.now();

    const hiddenTables = getHiddenTableNames(auth.connectionId);
    if (hiddenTables.has(table_name)) {
      return {
        content: [{ type: "text" as const, text: `Collection "${table_name}" is not accessible.` }],
        isError: true,
      };
    }

    const sampleSize = Math.min(limit ?? 5, 20);
    const hiddenFields = getHiddenFieldNames(auth.connectionId);

    try {
      const mongoDb = await getMongoDb(auth.sandboxPort);
      const coll = mongoDb.collection(table_name);
      const docs = (await coll
        .aggregate([{ $sample: { size: sampleSize } }], { maxTimeMS: 10_000 })
        .toArray()) as Record<string, unknown>[];

      const cleaned = docs.map((d) => stripFields(d, hiddenFields));
      const elapsed = Date.now() - start;

      writeAuditLog("sample_data", auth.connectionId, auth.apiKeyId, {
        collection: table_name,
        executionMs: elapsed,
        docCount: cleaned.length,
      });

      return {
        content: [
          { type: "text" as const, text: JSON.stringify(cleaned, null, 2) },
        ],
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text" as const, text: `Sample error: ${msg}` }],
        isError: true,
      };
    }
  });

  // ── get_schema_summary ──────────────────────────────────────────
  server.registerTool("get_schema_summary", {
    description:
      "Get a complete schema overview: all visible collections with fields, relationships, and common query patterns. Use this first to understand the database before querying.",
    inputSchema: {},
  }, async () => {
    const start = Date.now();
    const markdown = generateSchemaMarkdown(auth.connectionId);
    const elapsed = Date.now() - start;

    writeAuditLog("get_schema_summary", auth.connectionId, auth.apiKeyId, {
      executionMs: elapsed,
    });

    return {
      content: [
        { type: "text" as const, text: markdown },
      ],
    };
  });

  return server;
}

// ── Express app + transport management ──────────────────────────────

const app = express();
app.use(express.json());

// Map session ID → transport
const transports: Record<string, StreamableHTTPServerTransport> = {};

// POST /mcp — main MCP endpoint
app.post("/mcp", async (req, res) => {
  // Authenticate
  const auth = authenticate(req.headers.authorization);
  if (!auth) {
    res.status(401).json({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Unauthorized: invalid or missing API key" },
      id: null,
    });
    return;
  }

  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  try {
    let transport: StreamableHTTPServerTransport;

    if (sessionId && transports[sessionId]) {
      // Reuse existing transport
      transport = transports[sessionId];
    } else if (!sessionId && isInitializeRequest(req.body)) {
      // New initialization request
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid: string) => {
          console.log(`[MCP] Session initialized: ${sid}`);
          transports[sid] = transport;
        },
      });

      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid && transports[sid]) {
          console.log(`[MCP] Session closed: ${sid}`);
          delete transports[sid];
        }
      };

      // Connect a fresh MCP server for this session
      const mcpServer = createMcpServer(auth);
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    } else {
      res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Bad Request: no valid session ID" },
        id: null,
      });
      return;
    }

    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("[MCP] Error handling POST:", error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

// GET /mcp — SSE stream
app.get("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (!sessionId || !transports[sessionId]) {
    res.status(400).send("Invalid or missing session ID");
    return;
  }

  const auth = authenticate(req.headers.authorization);
  if (!auth) {
    res.status(401).send("Unauthorized");
    return;
  }

  const transport = transports[sessionId];
  await transport.handleRequest(req, res);
});

// DELETE /mcp — session termination
app.delete("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (!sessionId || !transports[sessionId]) {
    res.status(400).send("Invalid or missing session ID");
    return;
  }

  const auth = authenticate(req.headers.authorization);
  if (!auth) {
    res.status(401).send("Unauthorized");
    return;
  }

  const transport = transports[sessionId];
  await transport.handleRequest(req, res);
});

// Health check
app.get("/health", (_req, res) => {
  res.json({ status: "ok", uptime: process.uptime() });
});

// ── Start ───────────────────────────────────────────────────────────

const PORT = parseInt(process.env.MCP_PORT || "3001", 10);

app.listen(PORT, () => {
  console.log(`[MCP] askdb MCP server listening on port ${PORT}`);
});

// Graceful shutdown
process.on("SIGINT", async () => {
  console.log("[MCP] Shutting down...");
  for (const sid of Object.keys(transports)) {
    try {
      await transports[sid].close();
      delete transports[sid];
    } catch (e) {
      console.error(`[MCP] Error closing session ${sid}:`, e);
    }
  }
  // Close MongoDB clients
  for (const [port, client] of mongoClients) {
    try {
      await client.close();
    } catch (e) {
      console.error(`[MCP] Error closing MongoDB client on port ${port}:`, e);
    }
  }
  sqlite.close();
  console.log("[MCP] Shutdown complete");
  process.exit(0);
});
