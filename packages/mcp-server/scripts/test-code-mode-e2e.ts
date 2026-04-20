// End-to-end smoke test for the Code Mode MCP tool.
//
// Spins up a real MongoDB container, populates two collections, builds a
// throwaway SQLite DB with a real connection + api key + schema metadata,
// starts an in-process Express app that mounts the MCP router directly, and
// then connects with the official MCP client SDK and calls execute-typescript
// with a real cross-collection question. Asserts the result is correct AND
// that the hidden field (users.email) does not leak.
//
// Usage: pnpm --filter @askdb/mcp-server e2e
//
// Requires Docker.

import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { execSync } from "node:child_process";
import type http from "node:http";

import Database from "better-sqlite3";
import { MongoClient } from "mongodb";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";

import { ensureDatabaseSchema, encrypt } from "@askdb/shared";
import { generateApiKey } from "@askdb/shared";

// ── Constants ───────────────────────────────────────────────────────

const MONGO_PORT = 27099;
const SERVER_PORT = 3099;
const CONTAINER_NAME = "askdb-codemode-e2e";
const MONGO_IMAGE = "mongo:7";
const TEST_DB_NAME = "appdb";
const MONGO_USER = "askdb";
const MONGO_PASSWORD = "e2e-test-password-not-a-secret";
const MONGO_URI = `mongodb://${encodeURIComponent(MONGO_USER)}:${encodeURIComponent(MONGO_PASSWORD)}@localhost:${MONGO_PORT}/?authSource=admin`;

// ── Tiny logger ─────────────────────────────────────────────────────

const log = (msg: string) => console.log(`[e2e] ${msg}`);
function fail(msg: string): never {
  console.error(`[e2e] FAIL: ${msg}`);
  process.exit(1);
}

// ── Lifecycle ───────────────────────────────────────────────────────

async function dockerStop(): Promise<void> {
  try {
    execSync(`docker rm -f ${CONTAINER_NAME}`, { stdio: "ignore" });
  } catch {
    // not running
  }
}

async function dockerStartMongo(): Promise<void> {
  log(`starting ${MONGO_IMAGE} on :${MONGO_PORT}`);
  execSync(
    `docker run -d --rm --name ${CONTAINER_NAME} -p ${MONGO_PORT}:27017 ` +
      `-e MONGO_INITDB_ROOT_USERNAME=${MONGO_USER} ` +
      `-e MONGO_INITDB_ROOT_PASSWORD=${MONGO_PASSWORD} ` +
      `${MONGO_IMAGE}`,
    { stdio: "ignore" }
  );

  // Wait for ping
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const client = new MongoClient(MONGO_URI, {
      serverSelectionTimeoutMS: 1000,
    });
    try {
      await client.connect();
      await client.db("admin").command({ ping: 1 });
      await client.close();
      log("mongo ready");
      return;
    } catch {
      await client.close().catch(() => {});
      await delay(500);
    }
  }
  fail("mongo did not become ready within 30s");
}

async function seedMongo(): Promise<{ userIds: string[] }> {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const db = client.db(TEST_DB_NAME);

  await db.collection("users").insertMany([
    { _id: "u1" as unknown as never, name: "Alice",   email: "alice@example.com",   age: 31 },
    { _id: "u2" as unknown as never, name: "Bob",     email: "bob@example.com",     age: 28 },
    { _id: "u3" as unknown as never, name: "Carol",   email: "carol@example.com",   age: 42 },
    { _id: "u4" as unknown as never, name: "Dave",    email: "dave@example.com",    age: 35 },
    { _id: "u5" as unknown as never, name: "Eve",     email: "eve@example.com",     age: 29 },
  ]);

  // Hand-tuned so totals are: Carol=350, Alice=210, Dave=170, Bob=120, Eve=60
  // → top 3 by spend should be Carol, Alice, Dave.
  await db.collection("orders").insertMany([
    { userId: "u1", amount: 100 },
    { userId: "u1", amount:  60 },
    { userId: "u1", amount:  50 },
    { userId: "u2", amount:  90 },
    { userId: "u2", amount:  30 },
    { userId: "u3", amount: 200 },
    { userId: "u3", amount: 100 },
    { userId: "u3", amount:  50 },
    { userId: "u4", amount: 120 },
    { userId: "u4", amount:  50 },
    { userId: "u5", amount:  60 },
  ]);

  await client.close();
  log("seeded users (5) + orders (11)");
  return { userIds: ["u1", "u2", "u3", "u4", "u5"] };
}

interface SeedSqliteResult {
  fullKey: string;
  connectionId: string;
  apiKeyId: string;
  userId: string;
  dbPath: string;
  cleanup: () => void;
}

function createSchema(sqlite: Database.Database): void {
  // Mirror the Drizzle schema in packages/shared/src/db/schema.ts. We
  // don't run drizzle migrations here — this is a throwaway test DB.
  sqlite.exec(`
    CREATE TABLE user (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      emailVerified INTEGER NOT NULL,
      image TEXT,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    );

    CREATE TABLE connections (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      dbType TEXT NOT NULL DEFAULT 'mongodb',
      databaseName TEXT NOT NULL DEFAULT '',
      connectionString TEXT NOT NULL,
      sandboxContainerId TEXT,
      sandboxPort INTEGER,
      sandboxPassword TEXT,
      syncStatus TEXT NOT NULL DEFAULT 'IDLE',
      syncError TEXT,
      lastSyncAt INTEGER,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL,
      userId TEXT NOT NULL REFERENCES user(id)
    );

    CREATE TABLE schema_tables (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      docCount INTEGER NOT NULL DEFAULT 0,
      isVisible INTEGER NOT NULL DEFAULT 1,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL,
      connectionId TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE
    );

    CREATE TABLE schema_columns (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      fieldType TEXT NOT NULL,
      sampleValue TEXT,
      isVisible INTEGER NOT NULL DEFAULT 1,
      piiConfidence TEXT NOT NULL DEFAULT 'NONE',
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL,
      tableId TEXT NOT NULL REFERENCES schema_tables(id) ON DELETE CASCADE
    );

    CREATE TABLE schema_relationships (
      id TEXT PRIMARY KEY NOT NULL,
      sourceTableId TEXT NOT NULL REFERENCES schema_tables(id) ON DELETE CASCADE,
      sourceField TEXT NOT NULL,
      targetTableId TEXT NOT NULL REFERENCES schema_tables(id) ON DELETE CASCADE,
      targetField TEXT NOT NULL DEFAULT '_id',
      relationType TEXT NOT NULL DEFAULT 'belongsTo',
      confidence TEXT NOT NULL DEFAULT 'AUTO',
      createdAt INTEGER NOT NULL,
      connectionId TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE
    );

    CREATE TABLE api_keys (
      id TEXT PRIMARY KEY NOT NULL,
      prefix TEXT NOT NULL,
      keyHash TEXT NOT NULL UNIQUE,
      label TEXT,
      revokedAt INTEGER,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL,
      userId TEXT NOT NULL REFERENCES user(id)
    );

    CREATE TABLE query_memories (
      id TEXT PRIMARY KEY NOT NULL,
      pattern TEXT NOT NULL,
      description TEXT NOT NULL,
      exampleQuery TEXT,
      collection TEXT,
      frequency INTEGER NOT NULL DEFAULT 1,
      lastUsedAt INTEGER NOT NULL,
      createdAt INTEGER NOT NULL,
      connectionId TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE
    );

    CREATE TABLE audit_logs (
      id TEXT PRIMARY KEY NOT NULL,
      action TEXT NOT NULL,
      query TEXT,
      collection TEXT,
      executionMs INTEGER NOT NULL DEFAULT 0,
      docCount INTEGER NOT NULL DEFAULT 0,
      createdAt INTEGER NOT NULL,
      connectionId TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
      apiKeyId TEXT NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE
    );
  `);

  ensureDatabaseSchema(sqlite); // creates agent_insights
}

function seedSqlite(): SeedSqliteResult {
  const tmp = mkdtempSync(path.join(tmpdir(), "askdb-e2e-"));
  const dbPath = path.join(tmp, "askdb.db");
  log(`sqlite at ${dbPath}`);

  const sqlite = new Database(dbPath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  createSchema(sqlite);

  const now = Math.floor(Date.now() / 1000);
  const userId = "user_e2e";
  const connectionId = "conn_e2e";
  const apiKey = generateApiKey();

  // user (Better Auth shape)
  sqlite
    .prepare(
      `INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(userId, "E2E Tester", "e2e@askdb.local", 1, now, now);

  // connection — sandboxPort points at our docker mongo
  sqlite
    .prepare(
      `INSERT INTO connections
        (id, name, dbType, databaseName, connectionString, sandboxPort, sandboxPassword,
         syncStatus, createdAt, updatedAt, userId)
       VALUES (?, 'e2e', 'mongodb', ?, 'unused-encrypted-blob', ?, ?, 'READY', ?, ?, ?)`
    )
    .run(connectionId, TEST_DB_NAME, MONGO_PORT, encrypt(MONGO_PASSWORD), now, now, userId);

  // api key
  const apiKeyId = "ak_e2e";
  sqlite
    .prepare(
      `INSERT INTO api_keys (id, prefix, keyHash, label, createdAt, updatedAt, userId)
       VALUES (?, ?, ?, 'e2e', ?, ?, ?)`
    )
    .run(apiKeyId, "ask_sk_test", apiKey.hash, now, now, userId);

  // schema_tables
  const usersTableId = "tbl_users";
  const ordersTableId = "tbl_orders";
  for (const t of [
    { id: usersTableId, name: "users", count: 5 },
    { id: ordersTableId, name: "orders", count: 11 },
  ]) {
    sqlite
      .prepare(
        `INSERT INTO schema_tables
          (id, name, docCount, isVisible, createdAt, updatedAt, connectionId)
         VALUES (?, ?, ?, 1, ?, ?, ?)`
      )
      .run(t.id, t.name, t.count, now, now, connectionId);
  }

  // schema_columns — email is HIDDEN (isVisible = 0). Everything else visible.
  const cols = [
    { table: usersTableId,  name: "_id",     type: "string", visible: 1 },
    { table: usersTableId,  name: "name",    type: "string", visible: 1 },
    { table: usersTableId,  name: "email",   type: "string", visible: 0 },
    { table: usersTableId,  name: "age",     type: "number", visible: 1 },
    { table: ordersTableId, name: "_id",     type: "objectId", visible: 1 },
    { table: ordersTableId, name: "userId",  type: "string", visible: 1 },
    { table: ordersTableId, name: "amount",  type: "number", visible: 1 },
  ];
  for (const c of cols) {
    sqlite
      .prepare(
        `INSERT INTO schema_columns
          (id, name, fieldType, isVisible, piiConfidence, createdAt, updatedAt, tableId)
         VALUES (?, ?, ?, ?, 'NONE', ?, ?, ?)`
      )
      .run(`col_${c.table}_${c.name}`, c.name, c.type, c.visible, now, now, c.table);
  }

  sqlite.close();

  return {
    fullKey: apiKey.fullKey,
    connectionId,
    apiKeyId,
    userId,
    dbPath,
    cleanup: () => rmSync(tmp, { recursive: true, force: true }),
  };
}

interface InProcessServer {
  httpServer: http.Server;
  onShutdown: () => Promise<void>;
}

async function startMcpServer(dbPath: string): Promise<InProcessServer> {
  log(`starting in-process MCP server on :${SERVER_PORT} with DATABASE_PATH=${dbPath}`);

  // Must be set before any @askdb/shared db access — the db singleton reads
  // DATABASE_PATH lazily on first property access.
  process.env.DATABASE_PATH = dbPath;
  process.env.PORT = String(SERVER_PORT);
  process.env.ASKDB_MCP_DISABLED_TOOLS = "";

  // Dynamically import after setting env so the lazy db singleton picks up the
  // correct DATABASE_PATH. Static imports at the top of this file don't touch
  // the db, so this ordering is safe.
  const express = (await import("express")).default;
  const { createMcpRouter, createMcpTokenVerifier } = await import("@askdb/mcp-server");
  const { getMcpPublicUrl } = await import("@askdb/shared");

  const app = express();
  const mcpPublicUrl = getMcpPublicUrl();
  const tokenVerifier = createMcpTokenVerifier({ mcpPublicUrl });
  const resourceMetadataUrl = new URL(getOAuthProtectedResourceMetadataUrl(mcpPublicUrl));
  const { router, onShutdown } = createMcpRouter();

  app.use(
    "/mcp",
    requireBearerAuth({ verifier: tokenVerifier, resourceMetadataUrl: resourceMetadataUrl.href }),
    express.json({ limit: "4mb" }),
    router
  );

  const httpServer = await new Promise<http.Server>((resolve) => {
    const srv = app.listen(SERVER_PORT, () => {
      log(`in-process MCP server listening on :${SERVER_PORT}`);
      resolve(srv);
    });
  });

  return { httpServer, onShutdown };
}

// ── Wire logger ─────────────────────────────────────────────────────
// Wraps fetch so we can see every JSON-RPC message in both directions.

function pretty(value: unknown): string {
  return JSON.stringify(value, null, 2)
    .split("\n")
    .map((l) => "║   " + l)
    .join("\n");
}

function logSseBody(text: string): void {
  for (const line of text.split("\n")) {
    if (line.startsWith("data:")) {
      const data = line.slice(5).trim();
      if (!data) continue;
      try {
        console.log(pretty(JSON.parse(data)));
      } catch {
        console.log("║   " + line);
      }
    } else if (line.trim()) {
      console.log("║   " + line);
    }
  }
}

const loggingFetch: typeof fetch = async (input, init) => {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
  const method = init?.method ?? "GET";

  console.log(`\n╔══ → ${method} ${url}`);
  if (init?.headers) {
    const headers =
      init.headers instanceof Headers
        ? Object.fromEntries(init.headers.entries())
        : (init.headers as Record<string, string>);
    const safe: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) {
      safe[k] =
        k.toLowerCase() === "authorization" ? "Bearer ask_sk_***" : v;
    }
    console.log("║ headers: " + JSON.stringify(safe));
  }
  if (init?.body && typeof init.body === "string") {
    try {
      console.log("║ body:");
      console.log(pretty(JSON.parse(init.body)));
    } catch {
      console.log("║ body: " + init.body);
    }
  }
  console.log("╚══");

  const res = await fetch(input, init);
  const clone = res.clone();
  const text = await clone.text();

  console.log(`\n╔══ ← ${res.status} ${res.statusText}`);
  const ct = res.headers.get("content-type");
  if (ct) console.log("║ content-type: " + ct);
  const sid = res.headers.get("mcp-session-id");
  if (sid) console.log("║ mcp-session-id: " + sid);
  if (text) {
    if (
      text.startsWith("event:") ||
      text.startsWith("data:") ||
      text.includes("\ndata:")
    ) {
      console.log("║ body (SSE):");
      logSseBody(text);
    } else {
      try {
        console.log("║ body:");
        console.log(pretty(JSON.parse(text)));
      } catch {
        console.log("║ body: " + text);
      }
    }
  }
  console.log("╚══");

  return res;
};

// ── Test body ───────────────────────────────────────────────────────

async function runQueryViaMcp(fullKey: string): Promise<unknown> {
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://localhost:${SERVER_PORT}/mcp`),
    {
      requestInit: {
        headers: { Authorization: `Bearer ${fullKey}` },
      },
      fetch: loggingFetch,
    }
  );

  const client = new Client(
    { name: "askdb-e2e", version: "0.0.1" },
    { capabilities: {} }
  );

  await client.connect(transport);
  log("client connected");

  // The model writes this. We're playing the model.
  const source = `
    const users = await external_find({ collection: "users" });
    const totals = await Promise.all(
      users.map(async (u) => {
        const orders = await external_find({
          collection: "orders",
          filter: { userId: u._id },
        });
        const total = orders.reduce((s, o) => s + o.amount, 0);
        return { name: u.name, _id: u._id, total, leakedEmail: u.email ?? null };
      })
    );
    totals.sort((a, b) => b.total - a.total);
    return { topThree: totals.slice(0, 3), allUsers: totals };
  `.trim();

  const result = await client.callTool({
    name: "execute-typescript",
    arguments: { source },
  });

  await client.close();

  const text = (result.content as Array<{ type: string; text: string }>)?.[0]
    ?.text;
  if (!text) fail("MCP response had no text content");
  return JSON.parse(text);
}

interface CodeModeReply {
  ok: boolean;
  result?: {
    topThree: Array<{ name: string; _id: string; total: number; leakedEmail: string | null }>;
    allUsers: Array<{ name: string; _id: string; total: number; leakedEmail: string | null }>;
  };
  error?: string;
  bridgeCalls?: number;
  durationMs?: number;
  console?: Array<{ level: string; message: string }>;
}

function assertReply(reply: CodeModeReply): void {
  log(`reply: ${JSON.stringify(reply, null, 2)}`);

  if (!reply.ok) fail(`code mode reported error: ${reply.error}`);
  const result = reply.result;
  if (!result) fail("code mode reply has no result");

  const expectedOrder = ["Carol", "Alice", "Dave"];
  const actualOrder = result.topThree.map((r) => r.name);
  if (JSON.stringify(actualOrder) !== JSON.stringify(expectedOrder)) {
    fail(`top-3 order wrong: got ${JSON.stringify(actualOrder)}, want ${JSON.stringify(expectedOrder)}`);
  }
  log(`✓ top-3 order: ${actualOrder.join(", ")}`);

  const totalsByName: Record<string, number> = {
    Carol: 350,
    Alice: 210,
    Dave: 170,
    Bob: 120,
    Eve: 60,
  };
  for (const row of result.allUsers) {
    const want = totalsByName[row.name];
    if (row.total !== want) {
      fail(`total wrong for ${row.name}: got ${row.total}, want ${want}`);
    }
  }
  log("✓ all per-user totals correct");

  // The killer assertion: email must NEVER appear in the bridge response.
  const leaked = result.allUsers.filter((r) => r.leakedEmail !== null);
  if (leaked.length > 0) {
    fail(`HIDDEN FIELD LEAK: email surfaced for ${leaked.map((r) => r.name).join(", ")}`);
  }
  log("✓ hidden field 'email' was stripped from every user");

  if ((reply.bridgeCalls ?? 0) < 6) {
    fail(`expected at least 6 bridge calls (1 + 5 users), got ${reply.bridgeCalls}`);
  }
  log(`✓ bridge call count: ${reply.bridgeCalls}`);

  log(`✓ total wall time: ${reply.durationMs}ms`);
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  let inProcServer: InProcessServer | null = null;
  let sqliteSeed: SeedSqliteResult | null = null;

  try {
    await dockerStop();
    await dockerStartMongo();
    await seedMongo();
    sqliteSeed = seedSqlite();
    inProcServer = await startMcpServer(sqliteSeed.dbPath);

    const reply = (await runQueryViaMcp(sqliteSeed.fullKey)) as CodeModeReply;
    assertReply(reply);

    log("");
    log("ALL CHECKS PASSED");
    log("");
  } finally {
    if (inProcServer) {
      await inProcServer.onShutdown();
      await new Promise<void>((resolve) => inProcServer!.httpServer.close(() => resolve()));
    }
    if (sqliteSeed) sqliteSeed.cleanup();
    await dockerStop();
  }
}

main().catch((err) => {
  console.error("[e2e] uncaught:", err);
  dockerStop().finally(() => process.exit(1));
});
