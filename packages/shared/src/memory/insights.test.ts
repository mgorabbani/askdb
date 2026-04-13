import assert from "node:assert/strict";
import test from "node:test";
import { eq } from "drizzle-orm";
import { agentInsights } from "../db/schema.js";
import { saveAgentInsight } from "./insights.js";
import { resetTestDatabase, seedAuthFixture, testDb } from "../support/sqlite-fixture.js";

test("saveAgentInsight inserts a new insight", () => {
  resetTestDatabase();
  const fixture = seedAuthFixture();

  const result = saveAgentInsight(testDb, {
    apiKeyId: fixture.apiKeyId,
    category: "gotcha",
    collection: "users",
    connectionId: fixture.connectionId,
    exampleQuery: '{"collection":"users","operation":"count"}',
    insight: "role values are uppercase",
    now: fixture.now,
  });

  const saved = testDb
    .select()
    .from(agentInsights)
    .where(eq(agentInsights.id, result.id))
    .get();

  assert.equal(result.status, "created");
  assert.equal(result.useCount, 1);
  assert.equal(saved?.collection, "users");
  assert.equal(saved?.category, "gotcha");
  assert.equal(saved?.useCount, 1);
  assert.equal(saved?.exampleQuery, '{"collection":"users","operation":"count"}');
});

test("saveAgentInsight deduplicates exact collection and insight text", () => {
  resetTestDatabase();
  const fixture = seedAuthFixture();

  saveAgentInsight(testDb, {
    apiKeyId: fixture.apiKeyId,
    category: "pattern",
    collection: "users",
    connectionId: fixture.connectionId,
    exampleQuery: '{"collection":"users","operation":"find","filter":{"role":"STUDENT"}}',
    insight: "count students by filtering role",
    now: fixture.now,
  });

  const result = saveAgentInsight(testDb, {
    apiKeyId: fixture.apiKeyId,
    category: "tip",
    collection: "users",
    connectionId: fixture.connectionId,
    exampleQuery: null,
    insight: "count students by filtering role",
    now: new Date("2026-04-10T00:00:00.000Z"),
  });

  const rows = testDb.select().from(agentInsights).all();

  assert.equal(result.status, "updated");
  assert.equal(result.useCount, 2);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.useCount, 2);
  assert.equal(rows[0]?.category, "tip");
  assert.equal(
    rows[0]?.exampleQuery,
    '{"collection":"users","operation":"find","filter":{"role":"STUDENT"}}'
  );
});
