# Spec: askdb MCP Server v2 — Agent-Ready Redesign

## Objective

Redesign the askdb MCP server's tool surface so any AI agent can go from zero knowledge to correct queries with minimal tool calls. The current server requires agents to know MongoDB query syntax upfront and offers no way to learn from past interactions. The redesign introduces:

1. **Context tools** that return markdown — agents read these to understand the DB before querying
2. **`save_insight`** — agents contribute learnings back when users are satisfied, building a shared knowledge base
3. **Smarter tool descriptions** that guide agents through the intended workflow

The raw MongoDB query tool stays — it's the most flexible and performant option. We're improving everything *around* it.

## Current State

### Existing tools (5)

| Tool | What it does | Problem |
|------|-------------|---------|
| `list_tables` | Returns JSON array of `{name, docCount}` | No descriptions, no relationships, no context |
| `describe_table` | Returns fields for one collection | No relationships, no query patterns, requires knowing the collection name |
| `query` | Raw MongoDB JSON (find, aggregate, count, distinct) | Works well, but agents struggle with date types, uppercase enums, etc. |
| `sample_data` | Random docs via `$sample` | Fine as-is |
| `get_schema_summary` | Full markdown dump of everything | Too much — dumps all collections, all fields, all patterns in one wall of text |

### Existing infrastructure (keep all of this)

- **SQLite metadata store** — `schemaTables`, `schemaColumns`, `schemaRelationships`, `queryMemories`, `auditLogs`
- **PII detection & field visibility** — auto-hides sensitive fields
- **Relationship detection** — auto-detects FKs via naming conventions
- **Query pattern tracking** — `recordQueryPattern()` in server.ts, `extractPatterns()` in extractor.ts
- **Schema introspection** — `introspect.ts` discovers collections, fields, types, sample values
- **Audit logging** — every tool call logged with timing
- **Security** — API key auth, sandbox isolation, forbidden aggregation stages, hidden collection/field enforcement

## Proposed Design

### New tool surface (5 tools)

```
Agent workflow:
  get_guide → get_schema → [get_collection_detail] → query/sample_data → save_insight
     ↑            ↑                ↑                      ↑                   ↑
  "How do I    "What's in     "Deep dive on         "Run the            "Store what
   use this?"   the DB?"       one collection"       actual query"       I learned"
```

#### Tool 1: `get_guide` (new — replaces nothing)

**Purpose:** The "README" for agents. Call once per session to understand how to use this MCP server.

**Input:** none

**Output:** Static markdown containing:
- Available tools and when to use each
- Recommended workflow (get_guide → get_schema → query)
- MongoDB query syntax reference (find, aggregate, count, distinct)
- Common gotchas for this specific database (populated from insights)
- Query format examples
- Limits and constraints (500 doc max, 10s timeout, forbidden stages)

**Description for agents:**
```
"Call this FIRST when you connect. Returns a guide explaining how to use this
MCP server, what tools are available, the query format, and tips learned from
previous sessions. You only need to call this once per session."
```

**Implementation notes:**
- Mostly static content, but the "tips" section is dynamic — pulled from `agentInsights` table (new)
- Cached in memory, regenerated when insights change

#### Tool 2: `get_schema` (replaces `list_tables` + `get_schema_summary`)

**Purpose:** High-level DB overview. Agent's mental model of the entire database.

**Input:** none

**Output:** Markdown containing:
- All visible collections with doc counts and one-line descriptions
- Relationship map (which collections connect and how)
- Field type gotchas (e.g., "createdAt is mixed Date/String across collections")
- Top 10 most-used query patterns with example queries

**Description for agents:**
```
"Get the database overview — all collections, relationships, and common query
patterns. Call this before writing queries to understand what data exists and
how it's connected. Returns markdown optimized for AI context."
```

**Implementation notes:**
- Built from existing `generateSchemaMarkdown()` but restructured:
  - Collections section: name, docCount, description, key fields (not all fields)
  - Relationships section: dedicated section showing the full graph
  - Patterns section: top queries with working examples
- Does NOT include every field of every collection (that's what `get_collection_detail` is for)

**Markdown structure:**
```markdown
# Database Overview

## Collections

| Collection | Documents | Description |
|-----------|-----------|-------------|
| users | 1,070 | User accounts with roles (STUDENT, PARENT, TEACHER) |
| courses | 245 | Course content and metadata |
| ...

## Relationships

users.courseIds →→ courses._id (hasMany)
enrollments.userId → users._id (belongsTo)
enrollments.courseId → courses._id (belongsTo)
...

## Gotchas

- `role` values are UPPERCASE: STUDENT, PARENT, TEACHER
- `createdAt` is mixed type (Date object in older docs, ISO string in newer)
- Array fields like `courseIds` need `$unwind` before `$group`

## Common Queries (from memory)

### Count users by role
{collection: "users", operation: "count", filter: {role: "STUDENT"}}

### Recent signups (last N days)
{collection: "users", operation: "aggregate", pipeline: [...]}
...
```

#### Tool 3: `get_collection_detail` (replaces `describe_table`)

**Purpose:** Deep dive into one collection. Everything needed to write a correct query against it.

**Input:** `{ collection_name: string }`

**Output:** Markdown containing:
- Collection description and doc count
- All visible fields with types and sample values
- Relationships (outgoing and incoming)
- Known gotchas for this collection (from insights)
- Example queries that work with this collection (from memory + insights)

**Description for agents:**
```
"Get detailed information about a specific collection — all fields, types,
sample values, relationships, and working query examples. Call this before
querying a collection you haven't explored yet."
```

**Implementation notes:**
- Merges data from: `schemaColumns`, `schemaRelationships`, `queryMemories`, `agentInsights`
- Groups fields logically: IDs first, then data fields, then timestamps
- Includes both outgoing refs ("this collection points to...") and incoming refs ("...points to this collection")

#### Tool 4: `query` (keep — improved description only)

**Purpose:** Execute read-only MongoDB queries. Same implementation, better contract.

**Input:** `{ query: string }` (JSON object)

**Output:** Query results as JSON

**Updated description for agents:**
```
"Execute a read-only MongoDB query. Pass a JSON object with:
- collection: string (required)
- operation: 'find' | 'aggregate' | 'count' | 'distinct' (required)
- filter: object (optional, for find/count)
- pipeline: array (optional, for aggregate)
- field: string (optional, for distinct)
- limit: number (optional, max 500)

Call get_schema first to understand the database. Call get_collection_detail
for field types and sample values before writing complex queries.

Timeout: 10 seconds. Max 500 documents returned."
```

**Implementation changes:** None to the core logic. Only the tool description changes.

#### Tool 5: `save_insight` (new)

**Purpose:** Agents store what they learned when the user is satisfied. Builds a growing knowledge base that makes future queries easier.

**Input:**
```typescript
{
  insight: string,          // What the agent learned (natural language)
  collection?: string,      // Which collection this relates to (optional)
  category: 'gotcha' | 'pattern' | 'tip',  // Classification
  example_query?: string,   // A working query that demonstrates the insight (optional)
}
```

**Output:** Confirmation message

**Description for agents:**
```
"Save a useful insight about this database when your user is satisfied with a
query result. Insights help future agents avoid mistakes and write better
queries. Save things like: field type gotchas, working query patterns for
common questions, enum values, date format quirks, or join strategies that work.

Categories:
- 'gotcha': Something surprising that could trip up future agents
  (e.g., 'role values are UPPERCASE', 'createdAt has mixed Date/String types')
- 'pattern': A working query pattern for a common question
  (e.g., 'to count signups in a date range, use $dateFromString with $expr')
- 'tip': General helpful knowledge
  (e.g., 'users with onboarded=false are incomplete registrations')

Only save insights when the user got what they needed — don't save failed attempts."
```

**Implementation notes:**
- New `agentInsights` table in SQLite (see schema below)
- Deduplication: before inserting, check if a similar insight exists (same collection + similar content). If so, update `lastConfirmedAt` and bump `useCount`
- Insights are surfaced in `get_guide` (gotchas section), `get_schema` (gotchas section), and `get_collection_detail` (per-collection insights)
- No LLM needed — the calling agent already writes good natural language

### Removed tools

| Tool | Replacement |
|------|------------|
| `list_tables` | Folded into `get_schema` |
| `describe_table` | Replaced by `get_collection_detail` (richer output) |
| `get_schema_summary` | Split into `get_schema` (overview) + `get_collection_detail` (deep dive) |
| `sample_data` | **Keep as-is** — still useful for seeing raw documents |

Final count: **5 tools** (get_guide, get_schema, get_collection_detail, query, sample_data, save_insight) — actually 6 including sample_data.

## Schema Changes

### New table: `agent_insights`

```sql
CREATE TABLE agent_insights (
  id TEXT PRIMARY KEY,
  insight TEXT NOT NULL,              -- Natural language insight
  collection TEXT,                     -- Related collection (nullable for global insights)
  category TEXT NOT NULL DEFAULT 'tip', -- 'gotcha' | 'pattern' | 'tip'
  example_query TEXT,                  -- Working query JSON (optional)
  use_count INTEGER NOT NULL DEFAULT 1, -- How many times agents have confirmed this
  last_confirmed_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP NOT NULL,
  connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  api_key_id TEXT NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE
);
```

**Drizzle schema:**

```typescript
export const agentInsights = sqliteTable("agent_insights", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  insight: text("insight").notNull(),
  collection: text("collection"),
  category: text("category").notNull().default("tip"),
  exampleQuery: text("exampleQuery"),
  useCount: integer("useCount").notNull().default(1),
  lastConfirmedAt: integer("lastConfirmedAt", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  connectionId: text("connectionId")
    .notNull()
    .references(() => connections.id, { onDelete: "cascade" }),
  apiKeyId: text("apiKeyId")
    .notNull()
    .references(() => apiKeys.id, { onDelete: "cascade" }),
});
```

### Existing tables — no changes

- `queryMemories` — keep as-is, still tracks query frequency patterns automatically
- `auditLogs` — keep as-is, still logs every tool call
- `schemaTables`, `schemaColumns`, `schemaRelationships` — keep as-is

## How Memory Works (the full picture)

Two memory systems working together:

### 1. Automatic memory (existing — `queryMemories`)
- Every `query` tool call automatically records the pattern
- Frequency-based: queries used often get promoted
- Surfaced in `get_schema` → "Common Queries" section
- **No agent action needed** — happens silently

### 2. Agent-contributed memory (new — `agentInsights`)
- Agent calls `save_insight` when user is satisfied
- Richer than patterns — captures *why* something works, gotchas, tips
- Surfaced in `get_guide`, `get_schema`, and `get_collection_detail`
- **Requires agent judgment** — only saved when useful

Together:
```
queryMemories  = "what queries run often"      (automatic, frequency-based)
agentInsights  = "what agents wish they knew"  (curated, quality-based)
```

## Tool Description Philosophy

Every tool description follows this structure:
1. **What it does** (one sentence)
2. **When to call it** (guidance for the agent)
3. **What it returns** (so the agent knows what to expect)
4. **Relationship to other tools** (workflow hints)

The descriptions form a **self-guided workflow**:
- `get_guide` says "call me first, then call get_schema"
- `get_schema` says "call me before querying, call get_collection_detail for more detail"
- `get_collection_detail` says "call me before querying a collection you haven't seen"
- `query` says "call get_schema or get_collection_detail first"
- `save_insight` says "call me when the user is satisfied"

No external documentation needed. The tools teach the agent how to use them.

## Success Criteria

1. **Any agent can go from zero to correct query in ≤3 tool calls**
   - `get_guide` → `get_schema` → `query` for simple questions
   - `get_guide` → `get_schema` → `get_collection_detail` → `query` for complex ones

2. **The date query problem from our session is solved**
   - After one agent figures out `createdAt` is mixed type and saves an insight, future agents read it in `get_collection_detail("users")` and write the correct `$dateFromString` + `$expr` pipeline immediately

3. **Memory grows over time**
   - First session: agent struggles, saves 3-5 insights
   - Second session: agent reads insights, fewer mistakes
   - Tenth session: agent has a rich knowledge base, rarely fails

4. **Backward compatible**
   - Existing API keys and connections work without changes
   - Old tool names can be kept as aliases during transition (optional)

5. **No external LLM dependency**
   - MCP server has zero AI API calls
   - All intelligence comes from the calling agent via `save_insight`

## Boundaries

### Always
- Respect existing PII filtering and field visibility
- Audit log every tool call (including `save_insight`)
- Enforce read-only on `query` (existing forbidden stages list)
- Strip hidden fields from all outputs
- Scope insights per connection (multi-tenant)

### Ask first
- Changing the `query` tool's allowed operations
- Adding write operations beyond `save_insight`
- Modifying the introspection/sync pipeline

### Never
- Add an LLM API key to the MCP server
- Expose hidden fields or collections in any tool output
- Allow `save_insight` to modify schema configuration
- Break existing API key authentication

## Open Questions

1. **Insight deduplication** — How fuzzy should matching be? Exact string match on `insight` field, or something smarter? Starting with exact match + same collection seems safe.

2. **Insight expiry** — Should old insights expire? Or keep forever? Leaning toward keeping forever with `useCount` as a quality signal — high-use insights are more trustworthy.

3. **Insight editing** — Should there be a `update_insight` or `delete_insight` tool? Or is that overkill for v2? Leaning toward no — let insights accumulate, address cleanup later.

4. **`get_guide` caching** — Regenerate on every call, or cache until insights change? Cache is better for performance. Invalidate when `agentInsights` table changes.

5. **Migration path** — Do we rename tools in-place (breaking) or add new tools alongside old ones? Recommend renaming in-place since the server is pre-production.

## Files to Change

| File | Change |
|------|--------|
| `src/lib/db/schema.ts` | Add `agentInsights` table |
| `src/mcp/server.ts` | Replace tool registrations (remove 3, add 3, modify 1) |
| `src/lib/schema-summary/generator.ts` | Refactor into 3 generators: guide, schema overview, collection detail |
| `src/lib/memory/extractor.ts` | No changes needed |
| `drizzle.config.ts` | May need migration for new table |

## Non-Goals (v2)

- Natural language to MongoDB translation (let the calling agent handle this)
- Write operations (insert, update, delete)
- Multi-database support per connection
- Real-time schema change detection
- Insight quality scoring or ranking algorithm
