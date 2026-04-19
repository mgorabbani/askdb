import assert from "node:assert/strict";
import test from "node:test";

import {
  RESULT_VIEWER_URI,
  buildStructuredResult,
  resultViewerHtml,
  resultViewerResourceMeta,
  resultViewerToolMeta,
} from "./viewer.js";

test("resultViewerToolMeta uses the canonical MCP Apps `ui.resourceUri` shape", () => {
  const meta = resultViewerToolMeta();
  assert.deepEqual(meta, { ui: { resourceUri: RESULT_VIEWER_URI } });
});

test("resultViewerResourceMeta declares CSP, permissions, and prefersBorder", () => {
  const meta = resultViewerResourceMeta() as {
    csp: Record<string, unknown>;
    permissions: Record<string, unknown>;
    prefersBorder: boolean;
  };
  assert.ok(meta.csp && typeof meta.csp === "object");
  assert.equal(meta.prefersBorder, true);
  assert.ok(meta.permissions && typeof meta.permissions === "object");
});

test("buildStructuredResult infers columns from rows and carries meta", () => {
  const rows = [
    { _id: "1", name: "Alice", age: 30 },
    { _id: "2", name: "Bob", city: "Berlin" },
  ];

  const structured = buildStructuredResult(rows, {
    collection: "users",
    connectionId: "conn_a",
    connectionName: "Orders",
    operation: "find",
    truncated: false,
  });

  assert.equal(structured.kind, "rows");
  assert.equal(structured.rows.length, 2);
  assert.deepEqual(structured.columns, ["_id", "name", "age", "city"]);
  assert.equal(structured.meta.collection, "users");
  assert.equal(structured.meta.connectionName, "Orders");
  assert.equal(structured.meta.operation, "find");
  assert.equal(structured.meta.count, 2);
  assert.equal(structured.meta.truncated, false);
});

test("buildStructuredResult handles empty rows without throwing", () => {
  const structured = buildStructuredResult([], {
    collection: "events",
    connectionId: "conn_a",
    connectionName: "Orders",
    operation: "aggregate",
    truncated: false,
  });
  assert.equal(structured.rows.length, 0);
  assert.deepEqual(structured.columns, []);
  assert.equal(structured.meta.count, 0);
});

test("resultViewerHtml ships a self-contained HTML document that listens for ui/notifications/tool-result", () => {
  const html = resultViewerHtml();
  assert.match(html, /<!doctype html>/i);
  assert.match(html, /ui\/notifications\/tool-result/);
  assert.match(html, /ui\/initialize/);
  assert.match(html, /2026-01-26/);
  assert.match(html, /structuredContent/);
});
