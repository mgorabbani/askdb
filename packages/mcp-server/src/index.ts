// MCP server — standalone Express process on port 3001
// Shares SQLite + logic with @askdb/server via @askdb/shared.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { randomUUID } from "node:crypto";
import { existsSync } from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../..");
loadEnv({ path: path.join(repoRoot, ".env") });

// Resolve DATABASE_PATH relative to repo root so it works regardless of cwd.
if (process.env.DATABASE_PATH && !path.isAbsolute(process.env.DATABASE_PATH)) {
  process.env.DATABASE_PATH = path.resolve(repoRoot, process.env.DATABASE_PATH);
}

const MONGO_HOST = existsSync("/.dockerenv") ? "host.docker.internal" : "localhost";

import express from "express";
import { MongoClient, type Db as MongoDb } from "mongodb";
import { z } from "zod";

import {
  getOAuthProtectedResourceMetadataUrl,
  mcpAuthMetadataRouter,
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

import {
  MCP_OAUTH_SUPPORTED_SCOPES,
  db,
  schema,
  hashKey,
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
  verifyOAuthAccessToken,
} from "@askdb/shared";

import {
  buildConfigResourcePayload,
  buildDebugResourcePayload,
  buildInitializeInstructions,
  buildInsightsResourceMarkdown,
  isToolEnabled,
  readServerControls,
} from "./patterns.js";

import { registerExecuteTypescriptTool } from "./code-mode/tool.js";

const {
  agentInsights,
  apiKeys,
  connections,
  schemaTables,
  schemaColumns,
  queryMemories,
  auditLogs,
} = schema;

// ── Auth: resolve bearer token → userId + apiKeyId + connectionId ───

interface AuthContext {
  userId: string;
  apiKeyId: string;
  connectionId: string;
  sandboxPort: number;
  authType: "api_key" | "oauth";
  clientId: string;
  scopes: string[];
}

function isLocalHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1";
}

function getOAuthIssuerUrl(): URL {
  const raw = process.env.MCP_OAUTH_ISSUER_URL
    ?? process.env.BETTER_AUTH_URL
    ?? `http://localhost:${process.env.PORT ?? "3100"}`;
  const url = new URL(raw);
  return new URL(url.origin);
}

function getMcpPublicUrl(): URL {
  const configured = process.env.MCP_PUBLIC_URL;
  if (configured) return new URL(configured);

  const authBase = process.env.BETTER_AUTH_URL
    ? new URL(process.env.BETTER_AUTH_URL)
    : new URL(`http://localhost:${process.env.PORT ?? "3100"}`);

  if (isLocalHostname(authBase.hostname)) {
    return new URL(`http://localhost:${process.env.MCP_PORT || "3001"}/mcp`);
  }

  return new URL("/mcp", authBase);
}

function getConnectionContext(connectionId: string) {
  const conn = db
    .select()
    .from(connections)
    .where(eq(connections.id, connectionId))
    .get();

  if (!conn || !conn.sandboxPort) return null;
  return conn;
}

function authenticateApiKeyToken(token: string): AuthContext | null {
  if (!token.startsWith("ask_sk_")) return null;

  const hash = hashKey(token);

  const keyRow = db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.keyHash, hash), isNull(apiKeys.revokedAt)))
    .get();

  if (!keyRow) return null;

  const conn = db
    .select()
    .from(connections)
    .where(eq(connections.userId, keyRow.userId))
    .all()
    .find((row) => typeof row.sandboxPort === "number");

  if (!conn || !conn.sandboxPort) {
    return null;
  }

  return {
    userId: keyRow.userId,
    apiKeyId: keyRow.id,
    connectionId: conn.id,
    sandboxPort: conn.sandboxPort,
    authType: "api_key",
    clientId: `legacy-api-key:${keyRow.id}`,
    scopes: [...MCP_OAUTH_SUPPORTED_SCOPES],
  };
}

const mcpPublicUrl = getMcpPublicUrl();
const oauthIssuerUrl = getOAuthIssuerUrl();
const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(mcpPublicUrl);

const tokenVerifier = {
  async verifyAccessToken(token: string) {
    const tokenPrefix = token.slice(0, 10);
    const legacyAuth = authenticateApiKeyToken(token);
    if (legacyAuth) {
      console.log(`[mcp] verifyAccessToken api_key prefix=${tokenPrefix} ok user=${legacyAuth.userId}`);
      return {
        token,
        clientId: legacyAuth.clientId,
        scopes: legacyAuth.scopes,
        expiresAt: 4102444800,
        resource: mcpPublicUrl,
        extra: { ...legacyAuth },
      };
    }

    const verified = verifyOAuthAccessToken(db, token);
    if (!verified) {
      console.warn(`[mcp] verifyAccessToken oauth MISS prefix=${tokenPrefix}`);
      throw new InvalidTokenError("Invalid or expired token");
    }

    const conn = getConnectionContext(verified.connectionId);
    if (!conn) {
      console.warn(`[mcp] verifyAccessToken oauth NO_CONNECTION user=${verified.userId} connectionId=${verified.connectionId}`);
      throw new InvalidTokenError("No active sandbox connection found for this token");
    }
    console.log(`[mcp] verifyAccessToken oauth ok user=${verified.userId} client=${verified.clientId} resource=${verified.resource}`);

    const auth: AuthContext = {
      userId: verified.userId,
      apiKeyId: verified.apiKeyId,
      connectionId: verified.connectionId,
      sandboxPort: conn.sandboxPort!,
      authType: "oauth",
      clientId: verified.clientId,
      scopes: verified.scopes,
    };

    return {
      token,
      clientId: verified.clientId,
      scopes: verified.scopes,
      expiresAt: Math.floor(verified.expiresAt.getTime() / 1000),
      resource: new URL(verified.resource),
      extra: { ...auth },
    };
  },
};

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
  const topInsights = db
    .select({
      category: agentInsights.category,
      collection: agentInsights.collection,
      insight: agentInsights.insight,
    })
    .from(agentInsights)
    .where(eq(agentInsights.connectionId, auth.connectionId))
    .orderBy(desc(agentInsights.useCount), desc(agentInsights.lastConfirmedAt))
    .all()
    .slice(0, 12);

  const server = new McpServer(
    { name: "askdb", version: "0.2.0" },
    {
      capabilities: { tools: {}, resources: {} },
      instructions: buildInitializeInstructions(topInsights),
    }
  );
  const resourceUris = [
    "guide://usage",
    "schema://overview",
    "insights://global",
    "config://config",
    "debug://askdb",
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
    },
    queryStr = JSON.stringify(parsed)
  ) {
    const start = Date.now();
    const { collection, operation, filter, pipeline, field, limit } = parsed;

    if (!ALLOWED_OPS.has(operation)) {
      return toolError(
        toolName,
        `Operation "${operation}" is not allowed. Allowed: ${[...ALLOWED_OPS].join(", ")}`
      );
    }

    const hiddenTables = getHiddenTableNames(auth.connectionId);
    if (hiddenTables.has(collection)) {
      return toolError(toolName, `Collection "${collection}" is not accessible.`);
    }

    if (!getAccessibleTable(auth.connectionId, collection)) {
      return toolError(toolName, `Collection "${collection}" not found.`);
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
          writeAuditLog(toolName, auth.connectionId, auth.apiKeyId, {
            query: queryStr,
            collection,
            executionMs: elapsed,
            docCount: 1,
          });
          recordQueryPattern(auth.connectionId, queryStr);
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
          writeAuditLog(toolName, auth.connectionId, auth.apiKeyId, {
            query: queryStr,
            collection,
            executionMs: elapsed,
            docCount: limited.length,
          });
          recordQueryPattern(auth.connectionId, queryStr);
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

      writeAuditLog(toolName, auth.connectionId, auth.apiKeyId, {
        query: queryStr,
        collection,
        executionMs: elapsed,
        docCount: cleaned.length,
      });

      recordQueryPattern(auth.connectionId, queryStr);
      rememberSuccess(toolName);

      return {
        content: [
          { type: "text" as const, text: JSON.stringify(cleaned, null, 2) },
        ],
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return toolError(toolName, `Query error: ${msg}`);
    }
  }

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
          text: await generateGuideMarkdown(auth.connectionId),
        },
      ],
    })
  );

  server.registerResource(
    "schema-overview",
    "schema://overview",
    {
      title: "Schema Overview",
      description: "High-level schema overview with collections, relationships, gotchas, and common queries.",
      mimeType: "text/markdown",
    },
    async () => ({
      contents: [
        {
          uri: "schema://overview",
          mimeType: "text/markdown",
          text: await generateSchemaOverviewMarkdown(auth.connectionId),
        },
      ],
    })
  );

  server.registerResource(
    "insights",
    "insights://global",
    {
      title: "Saved Insights",
      description: "Saved agent insights for this connection.",
      mimeType: "text/markdown",
    },
    async () => {
      const insights = db
        .select({
          category: agentInsights.category,
          collection: agentInsights.collection,
          insight: agentInsights.insight,
        })
        .from(agentInsights)
        .where(eq(agentInsights.connectionId, auth.connectionId))
        .all();

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
              connectionId: auth.connectionId,
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
            buildDebugResourcePayload(auth.connectionId, debugState),
            null,
            2
          ),
        },
      ],
    })
  );

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
          "List visible MongoDB collections for this tenant. Use this or the schema://overview resource before querying unfamiliar data.",
        annotations: { readOnlyHint: true },
        inputSchema: {},
      },
      async () => {
        const start = Date.now();
        const tables = db
          .select()
          .from(schemaTables)
          .where(
            and(
              eq(schemaTables.connectionId, auth.connectionId),
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

        writeAuditLog("list-collections", auth.connectionId, auth.apiKeyId, {
          executionMs: Date.now() - start,
          docCount: result.length,
        });
        rememberSuccess("list-collections");

        return {
          content: [
            { type: "text" as const, text: JSON.stringify(result, null, 2) },
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
        },
      },
      async ({ collection }) => {
        const start = Date.now();
        const hiddenTables = getHiddenTableNames(auth.connectionId);
        if (hiddenTables.has(collection)) {
          return toolError("collection-schema", `Collection "${collection}" is not accessible.`);
        }

        const table = getAccessibleTable(auth.connectionId, collection);
        if (!table) {
          return toolError("collection-schema", `Collection "${collection}" not found.`);
        }

        const markdown = await generateCollectionDetailMarkdown(
          auth.connectionId,
          collection
        );
        if (!markdown) {
          return toolError(
            "collection-schema",
            `Collection "${collection}" is not available for inspection.`
          );
        }

        writeAuditLog("collection-schema", auth.connectionId, auth.apiKeyId, {
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
        inputSchema: {
          collection: z.string().describe("The collection to query"),
          filter: z.record(z.string(), z.unknown()).optional(),
          limit: z.number().int().min(1).max(500).optional(),
        },
      },
      async ({ collection, filter, limit }) =>
        executeQueryOperation("find", {
          collection,
          operation: "find",
          filter,
          limit,
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
        inputSchema: {
          collection: z.string().describe("The collection to query"),
          pipeline: z
            .array(z.record(z.string(), z.unknown()))
            .describe("Aggregation pipeline stages"),
          limit: z.number().int().min(1).max(500).optional(),
        },
      },
      async ({ collection, pipeline, limit }) =>
        executeQueryOperation("aggregate", {
          collection,
          operation: "aggregate",
          pipeline,
          limit,
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
        },
      },
      async ({ collection, filter }) =>
        executeQueryOperation("count", {
          collection,
          operation: "count",
          filter,
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
        },
      },
      async ({ collection, field, filter, limit }) =>
        executeQueryOperation("distinct", {
          collection,
          operation: "distinct",
          field,
          filter,
          limit,
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
        inputSchema: {
          collection: z.string().describe("The collection to sample from"),
          limit: z
            .number()
            .int()
            .min(1)
            .max(20)
            .default(5)
            .describe("Number of sample documents (max 20)"),
        },
      },
      async ({ collection, limit }) => {
        const start = Date.now();
        const hiddenTables = getHiddenTableNames(auth.connectionId);
        if (hiddenTables.has(collection)) {
          return toolError("sample-documents", `Collection "${collection}" is not accessible.`);
        }

        if (!getAccessibleTable(auth.connectionId, collection)) {
          return toolError("sample-documents", `Collection "${collection}" not found.`);
        }

        const sampleSize = Math.min(limit ?? 5, 20);
        const hiddenFields = getHiddenFieldNames(auth.connectionId);

        try {
          const mongoDb = await getMongoDb(auth.sandboxPort);
          const coll = mongoDb.collection(collection);
          const docs = (await coll
            .aggregate([{ $sample: { size: sampleSize } }], { maxTimeMS: 10_000 })
            .toArray()) as Record<string, unknown>[];

          const cleaned = docs.map((document) => stripFields(document, hiddenFields));
          const elapsed = Date.now() - start;

          writeAuditLog("sample-documents", auth.connectionId, auth.apiKeyId, {
            collection,
            executionMs: elapsed,
            docCount: cleaned.length,
          });
          rememberSuccess("sample-documents");

          return {
            content: [
              { type: "text" as const, text: JSON.stringify(cleaned, null, 2) },
            ],
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
        },
      },
      async ({ query: queryStr }) => {
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

        return executeQueryOperation("query", parsed, queryStr);
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
        },
      },
      async ({ insight, collection, category, exampleQuery }) => {
        const start = Date.now();
        const normalizedInsight = insight.trim();
        const normalizedCollection = normalizeOptionalString(collection);
        const normalizedExampleQuery = normalizeOptionalString(exampleQuery);

        if (!normalizedInsight) {
          return toolError("save-insight", "Insight cannot be empty.");
        }

        if (normalizedCollection) {
          const hiddenTables = getHiddenTableNames(auth.connectionId);
          if (hiddenTables.has(normalizedCollection)) {
            return toolError(
              "save-insight",
              `Collection "${normalizedCollection}" is not accessible.`
            );
          }

          if (!getAccessibleTable(auth.connectionId, normalizedCollection)) {
            return toolError(
              "save-insight",
              `Collection "${normalizedCollection}" not found.`
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
          connectionId: auth.connectionId,
          exampleQuery: normalizedExampleQuery,
          insight: normalizedInsight,
        });

        invalidateGuideCache(auth.connectionId);
        writeAuditLog("save-insight", auth.connectionId, auth.apiKeyId, {
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
      auth: { connectionId: auth.connectionId, apiKeyId: auth.apiKeyId },
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

// ── Express app + transport management ──────────────────────────────

const app = express();
app.set("trust proxy", 1);
app.use((req, _res, next) => {
  const authHeader = req.headers.authorization;
  const authSummary = authHeader
    ? `${authHeader.split(" ")[0]} ${authHeader.slice(-8)}`
    : "-";
  console.log(`[mcp] ${req.method} ${req.originalUrl} auth=${authSummary}`);
  next();
});
const oauthMetadata = {
  issuer: oauthIssuerUrl.href,
  authorization_endpoint: new URL("/authorize", oauthIssuerUrl).href,
  token_endpoint: new URL("/token", oauthIssuerUrl).href,
  registration_endpoint: new URL("/register", oauthIssuerUrl).href,
  revocation_endpoint: new URL("/revoke", oauthIssuerUrl).href,
  response_types_supported: ["code"],
  code_challenge_methods_supported: ["S256"],
  token_endpoint_auth_methods_supported: ["client_secret_post", "none"],
  revocation_endpoint_auth_methods_supported: ["client_secret_post"],
  grant_types_supported: ["authorization_code", "refresh_token"],
  scopes_supported: [...MCP_OAUTH_SUPPORTED_SCOPES],
};

app.use(
  mcpAuthMetadataRouter({
    oauthMetadata,
    resourceServerUrl: mcpPublicUrl,
    scopesSupported: [...MCP_OAUTH_SUPPORTED_SCOPES],
    resourceName: "askdb MCP",
    serviceDocumentationUrl: new URL("/dashboard/setup", oauthIssuerUrl),
  })
);

const authMiddleware = requireBearerAuth({
  verifier: tokenVerifier,
  resourceMetadataUrl,
});

app.use(express.json());

// Map session ID → transport
const transports: Record<string, StreamableHTTPServerTransport> = {};

function getRequestAuthContext(req: express.Request): AuthContext | null {
  const extra = req.auth?.extra as Partial<AuthContext> | undefined;
  if (
    !extra
    || typeof extra.userId !== "string"
    || typeof extra.apiKeyId !== "string"
    || typeof extra.connectionId !== "string"
    || typeof extra.sandboxPort !== "number"
    || typeof extra.clientId !== "string"
    || (extra.authType !== "api_key" && extra.authType !== "oauth")
    || !Array.isArray(extra.scopes)
  ) {
    return null;
  }

  return {
    userId: extra.userId,
    apiKeyId: extra.apiKeyId,
    connectionId: extra.connectionId,
    sandboxPort: extra.sandboxPort,
    authType: extra.authType,
    clientId: extra.clientId,
    scopes: extra.scopes.filter((scope): scope is string => typeof scope === "string"),
  };
}

// POST /mcp — main MCP endpoint
app.post("/mcp", authMiddleware, async (req, res) => {
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
app.get("/mcp", authMiddleware, async (req, res) => {
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

// DELETE /mcp — session termination
app.delete("/mcp", authMiddleware, async (req, res) => {
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
  console.log("[MCP] Shutdown complete");
  process.exit(0);
});
