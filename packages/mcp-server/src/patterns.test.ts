import assert from "node:assert/strict";
import test from "node:test";
import {
  buildConfigResourcePayload,
  buildDatabasesOverviewMarkdown,
  buildDebugResourcePayload,
  buildInitializeInstructions,
  buildInsightsResourceMarkdown,
  isToolEnabled,
  readServerControls,
} from "./patterns.js";

test("readServerControls reads disabled tools and readOnly flags", () => {
  const controls = readServerControls({
    ASKDB_MCP_DISABLED_TOOLS: "find, metadata askdb",
    ASKDB_MCP_READ_ONLY: "false",
  });

  assert.equal(controls.readOnly, false);
  assert.equal(controls.disabledItems.has("find"), true);
  assert.equal(controls.disabledItems.has("metadata"), true);
  assert.equal(controls.disabledItems.has("askdb"), true);
});

test("isToolEnabled respects readOnly and disabled categories", () => {
  const readOnlyControls = readServerControls({
    ASKDB_MCP_READ_ONLY: "true",
  });
  const disabledControls = readServerControls({
    ASKDB_MCP_DISABLED_TOOLS: "mongodb",
  });

  assert.equal(
    isToolEnabled(readOnlyControls, "insert-many", {
      category: "mongodb",
      operation: "update",
    }),
    false
  );
  assert.equal(
    isToolEnabled(disabledControls, "find", {
      category: "mongodb",
      operation: "read",
    }),
    false
  );
});

test("resource and instruction builders expose the MongoDB-style contract", () => {
  const instructions = buildInitializeInstructions([
    {
      category: "gotcha",
      collection: "users",
      insight: "createdAt is stored as a string",
    },
  ]);
  const config = buildConfigResourcePayload({
    connectionId: "conn_123",
    disabledItems: ["find"],
    readOnly: true,
    resources: ["config://config", "schema://overview"],
    toolNames: ["list-collections", "collection-schema"],
  });
  const insights = buildInsightsResourceMarkdown([
    {
      category: "tip",
      collection: null,
      insight: "Use collection-schema before aggregate",
    },
  ]);
  const debug = buildDebugResourcePayload("conn_123", {
    lastError: "Collection scan rejected",
    lastErrorAt: "2026-04-09T10:00:00.000Z",
    lastSuccessAt: null,
    lastTool: "aggregate",
  });

  assert.match(instructions, /schema:\/\/overview/);
  assert.match(instructions, /collection-schema/);
  assert.match(instructions, /users: createdAt is stored as a string/);
  assert.deepEqual(config.controls.disabledItems, ["find"]);
  assert.equal(config.mode.readOnly, true);
  assert.match(insights, /# Saved Insights/);
  assert.match(insights, /Use collection-schema before aggregate/);
  assert.equal(debug.debug.lastTool, "aggregate");
});

test("buildInitializeInstructions nudges agents to pick a DB when multiple are connected", () => {
  const instructions = buildInitializeInstructions([], [
    { id: "c1", name: "Orders", description: "Customer orders", databaseName: "orders_prod" },
    { id: "c2", name: "CRM", description: null, databaseName: "crm" },
  ]);
  assert.match(instructions, /2 databases connected/);
  assert.match(instructions, /databases:\/\/overview/);
});

test("buildDatabasesOverviewMarkdown renders plain-language entries per DB", () => {
  const md = buildDatabasesOverviewMarkdown([
    {
      id: "conn_orders",
      name: "Orders",
      description: "Customer orders and subscriptions",
      databaseName: "orders_prod",
    },
    {
      id: "conn_crm",
      name: "CRM",
      description: null,
      databaseName: "crm",
    },
  ]);

  assert.match(md, /# Databases/);
  assert.match(md, /## 1\. Orders/);
  assert.match(md, /Customer orders and subscriptions/);
  assert.match(md, /conn_orders/);
  assert.match(md, /## 2\. CRM/);
  assert.match(md, /No description yet/);
});

test("buildDatabasesOverviewMarkdown handles empty state", () => {
  const md = buildDatabasesOverviewMarkdown([]);
  assert.match(md, /No databases are connected/);
});
