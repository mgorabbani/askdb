import assert from "node:assert/strict";
import test from "node:test";
import {
  agentInsights,
  queryMemories,
  schemaColumns,
  schemaRelationships,
  schemaTables,
} from "../db/schema.js";
import { resetTestDatabase, seedAuthFixture, testDb } from "../../support/sqlite-fixture.js";

let generatorModule: Promise<typeof import("./generator.js")> | null = null;

function loadGenerator() {
  generatorModule ??= import("./generator.js");
  return generatorModule;
}

function seedSchemaFixture(connectionId: string, now: Date) {
  testDb.insert(schemaTables).values([
    {
      id: "table_users",
      name: "users",
      description: "User accounts and enrollment state.",
      docCount: 1070,
      isVisible: true,
      createdAt: now,
      updatedAt: now,
      connectionId,
    },
    {
      id: "table_courses",
      name: "courses",
      description: "Course catalog metadata.",
      docCount: 245,
      isVisible: true,
      createdAt: now,
      updatedAt: now,
      connectionId,
    },
    {
      id: "table_private",
      name: "private_notes",
      description: "Internal notes.",
      docCount: 12,
      isVisible: false,
      createdAt: now,
      updatedAt: now,
      connectionId,
    },
  ]).run();

  testDb.insert(schemaColumns).values([
    {
      id: "col_role",
      name: "role",
      fieldType: "String",
      sampleValue: "STUDENT",
      isVisible: true,
      piiConfidence: "NONE",
      createdAt: now,
      updatedAt: now,
      tableId: "table_users",
    },
    {
      id: "col_created_at",
      name: "createdAt",
      fieldType: "String",
      sampleValue: "2026-04-01T12:00:00.000Z",
      isVisible: true,
      piiConfidence: "NONE",
      createdAt: now,
      updatedAt: now,
      tableId: "table_users",
    },
    {
      id: "col_course_ids",
      name: "courseIds",
      fieldType: "Array",
      sampleValue: '["course_1","course_2"]',
      isVisible: true,
      piiConfidence: "NONE",
      createdAt: now,
      updatedAt: now,
      tableId: "table_users",
    },
    {
      id: "col_profile_name",
      name: "profile.name",
      fieldType: "String",
      sampleValue: "Alice",
      isVisible: true,
      piiConfidence: "NONE",
      createdAt: now,
      updatedAt: now,
      tableId: "table_users",
    },
    {
      id: "col_password",
      name: "password",
      fieldType: "String",
      sampleValue: "secret",
      isVisible: false,
      piiConfidence: "HIGH",
      createdAt: now,
      updatedAt: now,
      tableId: "table_users",
    },
    {
      id: "col_course_title",
      name: "title",
      fieldType: "String",
      sampleValue: "Algebra I",
      isVisible: true,
      piiConfidence: "NONE",
      createdAt: now,
      updatedAt: now,
      tableId: "table_courses",
    },
  ]).run();

  testDb.insert(schemaRelationships).values({
    id: "rel_users_courses",
    sourceTableId: "table_users",
    sourceField: "courseIds",
    targetTableId: "table_courses",
    targetField: "_id",
    relationType: "hasMany",
    confidence: "AUTO",
    createdAt: now,
    connectionId,
  }).run();
}

test("generateSchemaOverviewMarkdown builds the new overview surface", async () => {
  const { generateSchemaOverviewMarkdown, invalidateGuideCache } =
    await loadGenerator();
  resetTestDatabase();
  invalidateGuideCache();
  const fixture = seedAuthFixture();
  seedSchemaFixture(fixture.connectionId, fixture.now);

  testDb.insert(queryMemories).values({
    id: "memory_users_by_role",
    pattern: "count:users:role",
    description: "Count users filtered by role",
    exampleQuery:
      '{"collection":"users","operation":"count","filter":{"role":"STUDENT"}}',
    collection: "users",
    frequency: 4,
    lastUsedAt: fixture.now,
    createdAt: fixture.now,
    connectionId: fixture.connectionId,
  }).run();

  testDb.insert(agentInsights).values({
    id: "insight_global_role",
    insight: "role values are UPPERCASE: STUDENT, PARENT, TEACHER",
    collection: null,
    category: "gotcha",
    exampleQuery: null,
    useCount: 2,
    lastConfirmedAt: fixture.now,
    createdAt: fixture.now,
    connectionId: fixture.connectionId,
    apiKeyId: fixture.apiKeyId,
  }).run();

  const markdown = await generateSchemaOverviewMarkdown(fixture.connectionId);

  assert.match(markdown, /# Database Overview/);
  assert.match(markdown, /\| users \| 1,070 \|/);
  assert.match(markdown, /\| courses \| 245 \|/);
  assert.doesNotMatch(markdown, /private_notes/);
  assert.match(markdown, /1 collection\(s\) hidden for privacy/);
  assert.match(markdown, /`users\.courseIds` ->> `courses\._id` \(hasMany\)/);
  assert.match(markdown, /role values are UPPERCASE/);
  assert.match(markdown, /Count users filtered by role/);
});

test("generateCollectionDetailMarkdown hides private fields and includes saved examples", async () => {
  const { generateCollectionDetailMarkdown, invalidateGuideCache } =
    await loadGenerator();
  resetTestDatabase();
  invalidateGuideCache();
  const fixture = seedAuthFixture();
  seedSchemaFixture(fixture.connectionId, fixture.now);

  testDb.insert(queryMemories).values({
    id: "memory_users_recent",
    pattern: "find:users:createdAt",
    description: "Find users filtered by createdAt",
    exampleQuery:
      '{"collection":"users","operation":"find","filter":{"createdAt":{"$gte":"2026-04-01T00:00:00.000Z"}}}',
    collection: "users",
    frequency: 3,
    lastUsedAt: fixture.now,
    createdAt: fixture.now,
    connectionId: fixture.connectionId,
  }).run();

  testDb.insert(agentInsights).values([
    {
      id: "insight_users_dates",
      insight: "createdAt is stored as an ISO string, not a BSON Date",
      collection: "users",
      category: "gotcha",
      exampleQuery: null,
      useCount: 2,
      lastConfirmedAt: fixture.now,
      createdAt: fixture.now,
      connectionId: fixture.connectionId,
      apiKeyId: fixture.apiKeyId,
    },
    {
      id: "insight_users_role_pattern",
      insight: "Use uppercase role values when filtering users",
      collection: "users",
      category: "pattern",
      exampleQuery:
        '{"collection":"users","operation":"find","filter":{"role":"STUDENT"},"limit":10}',
      useCount: 3,
      lastConfirmedAt: fixture.now,
      createdAt: fixture.now,
      connectionId: fixture.connectionId,
      apiKeyId: fixture.apiKeyId,
    },
  ]).run();

  const markdown = await generateCollectionDetailMarkdown(
    fixture.connectionId,
    "users"
  );

  assert.ok(markdown);
  assert.match(markdown!, /\| _id \| ObjectId \| MongoDB document id \|/);
  assert.match(markdown!, /\| role \| String \| STUDENT \|/);
  assert.match(markdown!, /\| courseIds \| Array \| \["course_1","course_2"\] \|/);
  assert.match(markdown!, /1 hidden field\(s\) are omitted for privacy/);
  assert.doesNotMatch(markdown!, /password/);
  assert.match(markdown!, /createdAt is stored as an ISO string/);
  assert.match(markdown!, /Use uppercase role values when filtering users/);
  assert.match(markdown!, /Find users filtered by createdAt/);
});

test("generateGuideMarkdown uses cache until invalidated", async () => {
  const { generateGuideMarkdown, invalidateGuideCache } = await loadGenerator();
  resetTestDatabase();
  invalidateGuideCache();
  const fixture = seedAuthFixture();

  testDb.insert(agentInsights).values({
    id: "insight_initial",
    insight: "Always inspect get_schema before querying",
    collection: null,
    category: "tip",
    exampleQuery: null,
    useCount: 1,
    lastConfirmedAt: fixture.now,
    createdAt: fixture.now,
    connectionId: fixture.connectionId,
    apiKeyId: fixture.apiKeyId,
  }).run();

  const firstGuide = await generateGuideMarkdown(fixture.connectionId);

  testDb.insert(agentInsights).values({
    id: "insight_later",
    insight: "createdAt is mixed across legacy exports",
    collection: "users",
    category: "gotcha",
    exampleQuery: null,
    useCount: 1,
    lastConfirmedAt: fixture.now,
    createdAt: fixture.now,
    connectionId: fixture.connectionId,
    apiKeyId: fixture.apiKeyId,
  }).run();

  const cachedGuide = await generateGuideMarkdown(fixture.connectionId);
  invalidateGuideCache(fixture.connectionId);
  const refreshedGuide = await generateGuideMarkdown(fixture.connectionId);

  assert.doesNotMatch(firstGuide, /createdAt is mixed across legacy exports/);
  assert.equal(cachedGuide, firstGuide);
  assert.match(refreshedGuide, /createdAt is mixed across legacy exports/);
});
