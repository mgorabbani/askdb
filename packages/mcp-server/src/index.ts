// MCP server — exported as a library; mounted by @askdb/server.
// No standalone app.listen here.

import { randomUUID } from "node:crypto";

import express from "express";
import { MongoClient, type Db as MongoDb } from "mongodb";
import { z } from "zod";
import { existsSync } from "fs";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
// Side-effect import: adds req.auth augmentation to express-serve-static-core
import "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

import {
  db,
  schema,
  eq,
  and,
  isNull,
  inArray,
  desc,
  generateCollectionDetailMarkdown,
  generateGuideMarkdown,
  generateSchemaOverviewMarkdown,
  invalidateGuideCache,
  saveAgentInsight,
} from "@askdb/shared";

import {
  buildConfigResourcePayload,
  buildDatabasesOverviewMarkdown,
  buildDebugResourcePayload,
  buildInitializeInstructions,
  buildInsightsResourceMarkdown,
  isToolEnabled,
  readServerControls,
} from "./patterns.js";

import { registerExecuteTypescriptTool } from "./code-mode/tool.js";
import {
  RESULT_VIEWER_URI,
  buildStructuredResult,
  resultViewerHtml,
  resultViewerResourceMeta,
  resultViewerToolMeta,
  type StructuredResult,
} from "./mcp-apps/viewer.js";

export { createMcpTokenVerifier } from "./token-verifier.js";

import type { AccessibleConnection, AuthContext } from "./token-verifier.js";

const MONGO_HOST = existsSync("/.dockerenv") ? "host.docker.internal" : "localhost";

const {
  agentInsights,
  schemaTables,
  schemaColumns,
  queryMemories,
  auditLogs,
} = schema;

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

function getAccessibleTable(connectionId: string, collectionName: string) {
  return db
    .select()
    .from(schemaTables)
    .where(
      and(
        eq(schemaTables.connectionId, connectionId),
        eq(schemaTables.name, collectionName),
        eq(schemaTables.isVisible, true)
      )
    )
    .get();
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

function normalizeOptionalString(value: string | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

// ── Connection resolution ───────────────────────────────────────────

interface ConnectionResolutionError {
  ok: false;
  error: string;
}

interface ConnectionResolutionOk {
  ok: true;
  connection: AccessibleConnection;
}

type ConnectionResolution = ConnectionResolutionOk | ConnectionResolutionError;

function resolveConnection(
  auth: AuthContext,
  connectionId?: string
): ConnectionResolution {
  if (auth.connections.length === 0) {
    return { ok: false, error: "No active database connections are available." };
  }

  const targetId = connectionId ?? auth.defaultConnectionId;
  const match = auth.connections.find((c) => c.id === targetId);

  if (!match) {
    if (!connectionId && auth.connections.length > 1) {
      const options = auth.connections
        .map((c) => `${c.id} (${c.name})`)
        .join(", ");
      return {
        ok: false,
        error: `Multiple databases are available; pass connectionId. Options: ${options}`,
      };
    }
    return {
      ok: false,
      error: `Database "${connectionId}" is not accessible. Call list-databases to see what is available.`,
    };
  }

  return { ok: true, connection: match };
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
  const controls = readServerControls();
  const accessibleIds = auth.connections.map((c) => c.id);
  const topInsights =
    accessibleIds.length === 0
      ? []
      : db
          .select({
            category: agentInsights.category,
            collection: agentInsights.collection,
            insight: agentInsights.insight,
          })
          .from(agentInsights)
          .where(inArray(agentInsights.connectionId, accessibleIds))
          .orderBy(
            desc(agentInsights.useCount),
            desc(agentInsights.lastConfirmedAt)
          )
          .all()
          .slice(0, 12);

  const server = new McpServer(
    { name: "askdb", version: "0.2.0" },
    {
      capabilities: { tools: {}, resources: {} },
      instructions: buildInitializeInstructions(topInsights, auth.connections),
    }
  );
  const resourceUris = [
    "databases://overview",
    "guide://usage",
    "schema://overview",
    "insights://global",
    "config://config",
    "debug://askdb",
    RESULT_VIEWER_URI,
  ];
  const toolNames: string[] = [];
  const debugState = {
    lastError: null as string | null,
    lastErrorAt: null as string | null,
    lastSuccessAt: null as string | null,
    lastTool: null as string | null,
  };

  function rememberError(toolName: string, message: string) {
    debugState.lastTool = toolName;
    debugState.lastError = message;
    debugState.lastErrorAt = new Date().toISOString();
  }

  function rememberSuccess(toolName: string) {
    debugState.lastTool = toolName;
    debugState.lastSuccessAt = new Date().toISOString();
  }

  function toolError(toolName: string, message: string) {
    rememberError(toolName, message);
    return {
      content: [{ type: "text" as const, text: message }],
      isError: true,
    };
  }

  async function executeQueryOperation(
    toolName: string,
    parsed: {
      collection: string;
      operation: string;
      filter?: Record<string, unknown>;
      pipeline?: Record<string, unknown>[];
      field?: string;
      limit?: number;
      connectionId?: string;
    },
    queryStr?: string
  ) {
    const start = Date.now();
    const {
      collection,
      operation,
      filter,
      pipeline,
      field,
      limit,
      connectionId,
    } = parsed;

    const resolved = resolveConnection(auth, connectionId);
    if (!resolved.ok) return toolError(toolName, resolved.error);
    const conn = resolved.connection;

    // Serialize without the connectionId so audit/query-pattern records stay
    // comparable to pre-multi-DB entries.
    const { connectionId: _unused, ...forSerialization } = parsed;
    void _unused;
    const serializedQuery =
      queryStr ?? JSON.stringify(forSerialization);

    if (!ALLOWED_OPS.has(operation)) {
      return toolError(
        toolName,
        `Operation "${operation}" is not allowed. Allowed: ${[...ALLOWED_OPS].join(", ")}`
      );
    }

    const hiddenTables = getHiddenTableNames(conn.id);
    if (hiddenTables.has(collection)) {
      return toolError(toolName, `Collection "${collection}" is not accessible.`);
    }

    if (!getAccessibleTable(conn.id, collection)) {
      return toolError(
        toolName,
        `Collection "${collection}" not found in database "${conn.name}".`
      );
    }

    if (operation === "aggregate" && pipeline) {
      for (const stage of pipeline) {
        const stageKey = Object.keys(stage)[0];
        if (!stageKey) continue;
        if (FORBIDDEN_STAGES.has(stageKey)) {
          return toolError(toolName, `Aggregation stage "${stageKey}" is forbidden.`);
        }
        if (stageKey === "$lookup") {
          const lookup = stage.$lookup as Record<string, unknown>;
          if (lookup.from && hiddenTables.has(lookup.from as string)) {
            return toolError(
              toolName,
              `$lookup references hidden collection "${lookup.from}".`
            );
          }
        }
      }
    }

    const hiddenFields = getHiddenFieldNames(conn.id);
    const maxDocs = Math.min(limit ?? 500, 500);

    try {
      const mongoDb = await getMongoDb(conn.sandboxPort);
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
          writeAuditLog(toolName, conn.id, auth.apiKeyId, {
            query: serializedQuery,
            collection,
            executionMs: elapsed,
            docCount: 1,
          });
          recordQueryPattern(conn.id, serializedQuery);
          rememberSuccess(toolName);
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
          writeAuditLog(toolName, conn.id, auth.apiKeyId, {
            query: serializedQuery,
            collection,
            executionMs: elapsed,
            docCount: limited.length,
          });
          recordQueryPattern(conn.id, serializedQuery);
          rememberSuccess(toolName);
          return {
            content: [
              { type: "text" as const, text: JSON.stringify(limited, null, 2) },
            ],
          };
        }
        default:
          return toolError(toolName, `Unsupported operation: ${operation}`);
      }

      const cleaned = docs.map((document) => stripFields(document, hiddenFields));
      const elapsed = Date.now() - start;

      writeAuditLog(toolName, conn.id, auth.apiKeyId, {
        query: serializedQuery,
        collection,
        executionMs: elapsed,
        docCount: cleaned.length,
      });

      recordQueryPattern(conn.id, serializedQuery);
      rememberSuccess(toolName);

      const structured: StructuredResult = buildStructuredResult(cleaned, {
        collection,
        connectionId: conn.id,
        connectionName: conn.name,
        operation,
        truncated: cleaned.length >= maxDocs,
      });

      return {
        content: [
          { type: "text" as const, text: JSON.stringify(cleaned, null, 2) },
        ],
        structuredContent: structured as unknown as Record<string, unknown>,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return toolError(toolName, `Query error: ${msg}`);
    }
  }

  server.registerResource(
    "databases",
    "databases://overview",
    {
      title: "Databases",
      description:
        "Plain-language list of every database this user has connected, with what each one is for. Read this first to pick which database holds the data you need.",
      mimeType: "text/markdown",
    },
    async () => ({
      contents: [
        {
          uri: "databases://overview",
          mimeType: "text/markdown",
          text: buildDatabasesOverviewMarkdown(auth.connections),
        },
      ],
    })
  );

  server.registerResource(
    "guide",
    "guide://usage",
    {
      title: "Guide",
      description: "Usage guide and learned askdb tips.",
      mimeType: "text/markdown",
    },
    async () => ({
      contents: [
        {
          uri: "guide://usage",
          mimeType: "text/markdown",
          text: await generateGuideMarkdown(auth.defaultConnectionId),
        },
      ],
    })
  );

  server.registerResource(
    "schema-overview",
    "schema://overview",
    {
      title: "Schema Overview",
      description:
        "Schema overview for the default database. Pass connectionId to collection-schema or other tools to target a different database.",
      mimeType: "text/markdown",
    },
    async () => ({
      contents: [
        {
          uri: "schema://overview",
          mimeType: "text/markdown",
          text: await generateSchemaOverviewMarkdown(auth.defaultConnectionId),
        },
      ],
    })
  );

  server.registerResource(
    "insights",
    "insights://global",
    {
      title: "Saved Insights",
      description: "Saved agent insights across every database this user owns.",
      mimeType: "text/markdown",
    },
    async () => {
      const ids = auth.connections.map((c) => c.id);
      const insights = ids.length
        ? db
            .select({
              category: agentInsights.category,
              collection: agentInsights.collection,
              insight: agentInsights.insight,
            })
            .from(agentInsights)
            .where(inArray(agentInsights.connectionId, ids))
            .all()
        : [];

      return {
        contents: [
          {
            uri: "insights://global",
            mimeType: "text/markdown",
            text: buildInsightsResourceMarkdown(insights),
          },
        ],
      };
    }
  );

  server.registerResource(
    "config",
    "config://config",
    {
      title: "Server Config",
      description: "Redacted askdb MCP configuration and safety controls.",
      mimeType: "application/json",
    },
    async () => ({
      contents: [
        {
          uri: "config://config",
          mimeType: "application/json",
          text: JSON.stringify(
            buildConfigResourcePayload({
              connectionId: auth.defaultConnectionId,
              disabledItems: controls.disabledItems,
              readOnly: controls.readOnly,
              resources: resourceUris,
              toolNames,
            }),
            null,
            2
          ),
        },
      ],
    })
  );

  server.registerResource(
    "result-viewer",
    RESULT_VIEWER_URI,
    {
      title: "Result Viewer",
      description:
        "MCP Apps UI that renders find/aggregate/sample-documents results as an interactive table. Hosts without MCP Apps support ignore this resource.",
      mimeType: "text/html",
      _meta: resultViewerResourceMeta(),
    },
    async () => ({
      contents: [
        {
          uri: RESULT_VIEWER_URI,
          mimeType: "text/html",
          text: resultViewerHtml(),
        },
      ],
    })
  );

  server.registerResource(
    "debug",
    "debug://askdb",
    {
      title: "Debug",
      description: "Recent askdb MCP debug state for this session.",
      mimeType: "application/json",
    },
    async () => ({
      contents: [
        {
          uri: "debug://askdb",
          mimeType: "application/json",
          text: JSON.stringify(
            buildDebugResourcePayload(auth.defaultConnectionId, debugState),
            null,
            2
          ),
        },
      ],
    })
  );

  if (
    isToolEnabled(controls, "list-databases", {
      category: "askdb",
      operation: "metadata",
    })
  ) {
    toolNames.push("list-databases");
    server.registerTool(
      "list-databases",
      {
        title: "List Databases",
        description:
          "List every database this user has connected, with each database's name and a plain-language description of what it contains. Call this first so you can pick which database to query. Every other tool accepts a `connectionId` to target a specific database.",
        annotations: { readOnlyHint: true },
        inputSchema: {},
      },
      async () => {
        const result = auth.connections.map((conn) => {
          const tables = db
            .select({
              name: schemaTables.name,
              description: schemaTables.description,
              docCount: schemaTables.docCount,
            })
            .from(schemaTables)
            .where(
              and(
                eq(schemaTables.connectionId, conn.id),
                eq(schemaTables.isVisible, true)
              )
            )
            .all();

          return {
            connectionId: conn.id,
            name: conn.name,
            description: conn.description,
            databaseName: conn.databaseName,
            collectionCount: tables.length,
            topCollections: tables
              .slice()
              .sort((a, b) => b.docCount - a.docCount)
              .slice(0, 8)
              .map((t) => ({
                name: t.name,
                docCount: t.docCount,
                description: t.description,
              })),
          };
        });

        rememberSuccess("list-databases");

        return {
          content: [
            { type: "text" as const, text: JSON.stringify(result, null, 2) },
          ],
        };
      }
    );
  }

  if (
    isToolEnabled(controls, "list-collections", {
      category: "mongodb",
      operation: "metadata",
    })
  ) {
    toolNames.push("list-collections");
    server.registerTool(
      "list-collections",
      {
        title: "List Collections",
        description:
          "List visible MongoDB collections in one database. Pass `connectionId` to target a specific database when the user has more than one; omit it to use the default.",
        annotations: { readOnlyHint: true },
        inputSchema: {
          connectionId: z
            .string()
            .optional()
            .describe(
              "Which database to list. Omit when only one database is connected."
            ),
        },
      },
      async ({ connectionId }) => {
        const start = Date.now();
        const resolved = resolveConnection(auth, connectionId);
        if (!resolved.ok) return toolError("list-collections", resolved.error);
        const conn = resolved.connection;

        const tables = db
          .select()
          .from(schemaTables)
          .where(
            and(
              eq(schemaTables.connectionId, conn.id),
              eq(schemaTables.isVisible, true)
            )
          )
          .all();

        const result = tables
          .map((table) => {
            const columns = db
              .select({ isVisible: schemaColumns.isVisible })
              .from(schemaColumns)
              .where(eq(schemaColumns.tableId, table.id))
              .all();

            if (columns.length > 0 && !columns.some((column) => column.isVisible)) {
              return null;
            }

            return {
              name: table.name,
              docCount: table.docCount,
              description: table.description,
            };
          })
          .filter((table): table is NonNullable<typeof table> => table !== null);

        writeAuditLog("list-collections", conn.id, auth.apiKeyId, {
          executionMs: Date.now() - start,
          docCount: result.length,
        });
        rememberSuccess("list-collections");

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  connectionId: conn.id,
                  name: conn.name,
                  databaseName: conn.databaseName,
                  collections: result,
                },
                null,
                2
              ),
            },
          ],
        };
      }
    );
  }

  if (
    isToolEnabled(controls, "collection-schema", {
      category: "mongodb",
      operation: "metadata",
    })
  ) {
    toolNames.push("collection-schema");
    server.registerTool(
      "collection-schema",
      {
        title: "Collection Schema",
        description:
          "Describe one collection with fields, sample values, relationships, gotchas, and working examples. Use this before running queries against a collection you have not explored yet.",
        annotations: { readOnlyHint: true },
        inputSchema: {
          collection: z.string().describe("The collection to inspect"),
          connectionId: z
            .string()
            .optional()
            .describe(
              "Which database the collection lives in. Omit when only one database is connected."
            ),
        },
      },
      async ({ collection, connectionId }) => {
        const start = Date.now();
        const resolved = resolveConnection(auth, connectionId);
        if (!resolved.ok) return toolError("collection-schema", resolved.error);
        const conn = resolved.connection;

        const hiddenTables = getHiddenTableNames(conn.id);
        if (hiddenTables.has(collection)) {
          return toolError("collection-schema", `Collection "${collection}" is not accessible.`);
        }

        const table = getAccessibleTable(conn.id, collection);
        if (!table) {
          return toolError(
            "collection-schema",
            `Collection "${collection}" not found in database "${conn.name}".`
          );
        }

        const markdown = await generateCollectionDetailMarkdown(
          conn.id,
          collection
        );
        if (!markdown) {
          return toolError(
            "collection-schema",
            `Collection "${collection}" is not available for inspection.`
          );
        }

        writeAuditLog("collection-schema", conn.id, auth.apiKeyId, {
          collection,
          executionMs: Date.now() - start,
          docCount: 1,
        });
        rememberSuccess("collection-schema");

        return {
          content: [{ type: "text" as const, text: markdown }],
        };
      }
    );
  }

  if (
    isToolEnabled(controls, "find", {
      category: "mongodb",
      operation: "read",
    })
  ) {
    toolNames.push("find");
    server.registerTool(
      "find",
      {
        title: "Find",
        description:
          "Run a read-only MongoDB find query. Prefer this over the low-level query tool for standard document retrieval.",
        annotations: { readOnlyHint: true },
        _meta: resultViewerToolMeta(),
        inputSchema: {
          collection: z.string().describe("The collection to query"),
          filter: z.record(z.string(), z.unknown()).optional(),
          limit: z.number().int().min(1).max(500).optional(),
          connectionId: z
            .string()
            .optional()
            .describe(
              "Which database to query. Omit when only one database is connected."
            ),
        },
      },
      async ({ collection, filter, limit, connectionId }) =>
        executeQueryOperation("find", {
          collection,
          operation: "find",
          filter,
          limit,
          connectionId,
        })
    );
  }

  if (
    isToolEnabled(controls, "aggregate", {
      category: "mongodb",
      operation: "read",
    })
  ) {
    toolNames.push("aggregate");
    server.registerTool(
      "aggregate",
      {
        title: "Aggregate",
        description:
          "Run a read-only MongoDB aggregation pipeline. Use collection-schema first for field names, relationships, and known gotchas.",
        annotations: { readOnlyHint: true },
        _meta: resultViewerToolMeta(),
        inputSchema: {
          collection: z.string().describe("The collection to query"),
          pipeline: z
            .array(z.record(z.string(), z.unknown()))
            .describe("Aggregation pipeline stages"),
          limit: z.number().int().min(1).max(500).optional(),
          connectionId: z
            .string()
            .optional()
            .describe(
              "Which database to query. Omit when only one database is connected."
            ),
        },
      },
      async ({ collection, pipeline, limit, connectionId }) =>
        executeQueryOperation("aggregate", {
          collection,
          operation: "aggregate",
          pipeline,
          limit,
          connectionId,
        })
    );
  }

  if (
    isToolEnabled(controls, "count", {
      category: "mongodb",
      operation: "read",
    })
  ) {
    toolNames.push("count");
    server.registerTool(
      "count",
      {
        title: "Count",
        description:
          "Count documents in a collection with an optional filter.",
        annotations: { readOnlyHint: true },
        inputSchema: {
          collection: z.string().describe("The collection to query"),
          filter: z.record(z.string(), z.unknown()).optional(),
          connectionId: z
            .string()
            .optional()
            .describe(
              "Which database to query. Omit when only one database is connected."
            ),
        },
      },
      async ({ collection, filter, connectionId }) =>
        executeQueryOperation("count", {
          collection,
          operation: "count",
          filter,
          connectionId,
        })
    );
  }

  if (
    isToolEnabled(controls, "distinct", {
      category: "mongodb",
      operation: "read",
    })
  ) {
    toolNames.push("distinct");
    server.registerTool(
      "distinct",
      {
        title: "Distinct",
        description:
          "Return distinct values for one field in a collection with an optional filter.",
        annotations: { readOnlyHint: true },
        inputSchema: {
          collection: z.string().describe("The collection to query"),
          field: z.string().describe("The field to compute distinct values for"),
          filter: z.record(z.string(), z.unknown()).optional(),
          limit: z.number().int().min(1).max(500).optional(),
          connectionId: z
            .string()
            .optional()
            .describe(
              "Which database to query. Omit when only one database is connected."
            ),
        },
      },
      async ({ collection, field, filter, limit, connectionId }) =>
        executeQueryOperation("distinct", {
          collection,
          operation: "distinct",
          field,
          filter,
          limit,
          connectionId,
        })
    );
  }

  if (
    isToolEnabled(controls, "sample-documents", {
      category: "mongodb",
      operation: "read",
    })
  ) {
    toolNames.push("sample-documents");
    server.registerTool(
      "sample-documents",
      {
        title: "Sample Documents",
        description:
          "Get random sample documents from a collection using $sample. Use this after reviewing schema metadata when you need raw document examples.",
        annotations: { readOnlyHint: true },
        _meta: resultViewerToolMeta(),
        inputSchema: {
          collection: z.string().describe("The collection to sample from"),
          limit: z
            .number()
            .int()
            .min(1)
            .max(20)
            .default(5)
            .describe("Number of sample documents (max 20)"),
          connectionId: z
            .string()
            .optional()
            .describe(
              "Which database to sample from. Omit when only one database is connected."
            ),
        },
      },
      async ({ collection, limit, connectionId }) => {
        const start = Date.now();
        const resolved = resolveConnection(auth, connectionId);
        if (!resolved.ok) return toolError("sample-documents", resolved.error);
        const conn = resolved.connection;

        const hiddenTables = getHiddenTableNames(conn.id);
        if (hiddenTables.has(collection)) {
          return toolError("sample-documents", `Collection "${collection}" is not accessible.`);
        }

        if (!getAccessibleTable(conn.id, collection)) {
          return toolError(
            "sample-documents",
            `Collection "${collection}" not found in database "${conn.name}".`
          );
        }

        const sampleSize = Math.min(limit ?? 5, 20);
        const hiddenFields = getHiddenFieldNames(conn.id);

        try {
          const mongoDb = await getMongoDb(conn.sandboxPort);
          const coll = mongoDb.collection(collection);
          const docs = (await coll
            .aggregate([{ $sample: { size: sampleSize } }], { maxTimeMS: 10_000 })
            .toArray()) as Record<string, unknown>[];

          const cleaned = docs.map((document) => stripFields(document, hiddenFields));
          const elapsed = Date.now() - start;

          writeAuditLog("sample-documents", conn.id, auth.apiKeyId, {
            collection,
            executionMs: elapsed,
            docCount: cleaned.length,
          });
          rememberSuccess("sample-documents");

          const structured = buildStructuredResult(cleaned, {
            collection,
            connectionId: conn.id,
            connectionName: conn.name,
            operation: "sample",
            truncated: cleaned.length >= sampleSize,
          });

          return {
            content: [
              { type: "text" as const, text: JSON.stringify(cleaned, null, 2) },
            ],
            structuredContent: structured as unknown as Record<string, unknown>,
          };
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          return toolError("sample-documents", `Sample error: ${msg}`);
        }
      }
    );
  }

  if (
    isToolEnabled(controls, "query", {
      category: "askdb",
      operation: "read",
    })
  ) {
    toolNames.push("query");
    server.registerTool(
      "query",
      {
        title: "Query",
        description:
          "Low-level compatibility tool. Execute a read-only MongoDB query envelope with { collection, operation, filter?, pipeline?, field?, limit? }. Prefer the dedicated find, aggregate, count, and distinct tools when possible.",
        annotations: { readOnlyHint: true },
        inputSchema: {
          query: z
            .string()
            .describe(
              'JSON query object, e.g. {"collection":"users","operation":"find","filter":{"status":"active"}}'
            ),
          connectionId: z
            .string()
            .optional()
            .describe(
              "Which database to query. Omit when only one database is connected."
            ),
        },
      },
      async ({ query: queryStr, connectionId }) => {
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
          return toolError("query", "Invalid JSON in query parameter.");
        }

        return executeQueryOperation(
          "query",
          { ...parsed, connectionId },
          queryStr
        );
      }
    );
  }

  if (
    isToolEnabled(controls, "save-insight", {
      category: "askdb",
      operation: "update",
    })
  ) {
    toolNames.push("save-insight");
    server.registerTool(
      "save-insight",
      {
        title: "Save Insight",
        description:
          "Save a useful insight after the user is satisfied with a result. Use this for durable gotchas, working patterns, enum values, date quirks, or join strategies that actually worked.",
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
        },
        inputSchema: {
          insight: z.string().min(1).describe("The useful thing you learned in natural language"),
          collection: z
            .string()
            .optional()
            .describe("Optional collection this insight applies to"),
          category: z
            .enum(["gotcha", "pattern", "tip"])
            .describe("How this insight should be classified"),
          exampleQuery: z
            .string()
            .optional()
            .describe("Optional working MongoDB query JSON that demonstrates the insight"),
          connectionId: z
            .string()
            .optional()
            .describe(
              "Which database this insight applies to. Omit when only one database is connected."
            ),
        },
      },
      async ({ insight, collection, category, exampleQuery, connectionId }) => {
        const start = Date.now();
        const resolved = resolveConnection(auth, connectionId);
        if (!resolved.ok) return toolError("save-insight", resolved.error);
        const conn = resolved.connection;

        const normalizedInsight = insight.trim();
        const normalizedCollection = normalizeOptionalString(collection);
        const normalizedExampleQuery = normalizeOptionalString(exampleQuery);

        if (!normalizedInsight) {
          return toolError("save-insight", "Insight cannot be empty.");
        }

        if (normalizedCollection) {
          const hiddenTables = getHiddenTableNames(conn.id);
          if (hiddenTables.has(normalizedCollection)) {
            return toolError(
              "save-insight",
              `Collection "${normalizedCollection}" is not accessible.`
            );
          }

          if (!getAccessibleTable(conn.id, normalizedCollection)) {
            return toolError(
              "save-insight",
              `Collection "${normalizedCollection}" not found in database "${conn.name}".`
            );
          }
        }

        if (normalizedExampleQuery) {
          try {
            const parsed = JSON.parse(normalizedExampleQuery);
            if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
              return toolError(
                "save-insight",
                "exampleQuery must be a JSON object string."
              );
            }
          } catch {
            return toolError("save-insight", "exampleQuery must contain valid JSON.");
          }
        }

        const result = saveAgentInsight(db, {
          apiKeyId: auth.apiKeyId,
          category,
          collection: normalizedCollection,
          connectionId: conn.id,
          exampleQuery: normalizedExampleQuery,
          insight: normalizedInsight,
        });

        invalidateGuideCache(conn.id);
        writeAuditLog("save-insight", conn.id, auth.apiKeyId, {
          query: normalizedExampleQuery ?? undefined,
          collection: normalizedCollection ?? undefined,
          executionMs: Date.now() - start,
          docCount: 1,
        });
        rememberSuccess("save-insight");

        return {
          content: [
            {
              type: "text" as const,
              text:
                result.status === "updated"
                  ? `Updated existing insight. Confirmation count is now ${result.useCount}.`
                  : "Insight saved.",
            },
          ],
        };
      }
    );
  }

  if (
    isToolEnabled(controls, "execute-typescript", {
      category: "askdb",
      operation: "read",
    })
  ) {
    toolNames.push("execute-typescript");
    registerExecuteTypescriptTool({
      server,
      resolveConnection: (connectionId?: string) =>
        resolveConnection(auth, connectionId),
      apiKeyId: auth.apiKeyId,
      hasMultipleConnections: auth.connections.length > 1,
      executeQueryOperation,
      hooks: {
        writeAuditLog,
        rememberSuccess,
        rememberError,
      },
    });
  }

  return server;
}

// ── Router factory ───────────────────────────────────────────────────

export function createMcpRouter(): {
  router: express.Router;
  onShutdown: () => Promise<void>;
} {
  const MAX_SESSIONS = 1000;

  // Map session ID → transport (scoped to this router instance)
  const transports: Record<string, StreamableHTTPServerTransport> = {};

  function getRequestAuthContext(req: express.Request): AuthContext | null {
    const extra = req.auth?.extra as Partial<AuthContext> | undefined;
    if (
      !extra
      || typeof extra.userId !== "string"
      || typeof extra.apiKeyId !== "string"
      || typeof extra.defaultConnectionId !== "string"
      || !Array.isArray(extra.connections)
      || typeof extra.clientId !== "string"
      || (extra.authType !== "api_key" && extra.authType !== "oauth")
      || !Array.isArray(extra.scopes)
    ) {
      return null;
    }

    const connections: AccessibleConnection[] = [];
    for (const raw of extra.connections) {
      if (
        !raw
        || typeof raw !== "object"
        || typeof (raw as AccessibleConnection).id !== "string"
        || typeof (raw as AccessibleConnection).name !== "string"
        || typeof (raw as AccessibleConnection).databaseName !== "string"
        || typeof (raw as AccessibleConnection).sandboxPort !== "number"
      ) {
        return null;
      }
      const conn = raw as AccessibleConnection;
      connections.push({
        id: conn.id,
        name: conn.name,
        description:
          typeof conn.description === "string" ? conn.description : null,
        databaseName: conn.databaseName,
        sandboxPort: conn.sandboxPort,
      });
    }

    return {
      userId: extra.userId,
      apiKeyId: extra.apiKeyId,
      defaultConnectionId: extra.defaultConnectionId,
      connections,
      authType: extra.authType,
      clientId: extra.clientId,
      scopes: extra.scopes.filter((scope): scope is string => typeof scope === "string"),
    };
  }

  const router = express.Router();

  // Boundary logger — scoped to /mcp so it doesn't clutter unrelated routes.
  router.use((req, _res, next) => {
    const auth = req.headers.authorization;
    const authSuffix = typeof auth === "string" ? auth.slice(-8) : "none";
    console.log(`[mcp] ${req.method} ${req.originalUrl} auth=…${authSuffix}`);
    next();
  });

  // POST / — main MCP endpoint (mounted at /mcp by the host app)
  router.post("/", async (req, res) => {
    const auth = getRequestAuthContext(req);
    if (!auth) {
      res.status(401).json({
        jsonrpc: "2.0",
        error: { code: -32001, message: "Unauthorized" },
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
        // Cap the session map to avoid unbounded memory growth.
        if (Object.keys(transports).length >= MAX_SESSIONS) {
          res.status(429).json({
            jsonrpc: "2.0",
            error: { code: -32000, message: "Active session limit reached" },
            id: null,
          });
          return;
        }

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

  // GET / — SSE stream
  router.get("/", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId || !transports[sessionId]) {
      res.status(400).send("Invalid or missing session ID");
      return;
    }

    if (!getRequestAuthContext(req)) {
      res.status(401).send("Unauthorized");
      return;
    }

    const transport = transports[sessionId];
    await transport.handleRequest(req, res);
  });

  // DELETE / — session termination
  router.delete("/", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId || !transports[sessionId]) {
      res.status(400).send("Invalid or missing session ID");
      return;
    }

    if (!getRequestAuthContext(req)) {
      res.status(401).send("Unauthorized");
      return;
    }

    const transport = transports[sessionId];
    await transport.handleRequest(req, res);
  });

  async function onShutdown() {
    for (const sid of Object.keys(transports)) {
      try {
        const t = transports[sid];
        if (t) await t.close();
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
  }

  return { router, onShutdown };
}
