import { Router, type Router as ExpressRouter } from "express";
import {
  and,
  eq,
  desc,
  db,
  schema,
  encrypt,
  getAdapter,
  normalizeDbType,
  SUPPORTED_DB_TYPES,
  sandboxManager,
  syncConnection,
  generateSchemaMarkdown,
} from "@askdb/shared";
import { requireSession, type AuthedRequest } from "../lib/session.js";

const {
  connections,
  schemaTables,
  schemaColumns,
  schemaRelationships,
  queryMemories,
} = schema;

export const connectionsRouter: ExpressRouter = Router();
connectionsRouter.use(requireSession);

const MAX_DB_SIZE = 20 * 1024 * 1024 * 1024;
const WARN_DB_SIZE = 5 * 1024 * 1024 * 1024;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

async function loadOwnedConnection(req: AuthedRequest, id: string) {
  const [conn] = await db
    .select()
    .from(connections)
    .where(and(eq(connections.id, id), eq(connections.userId, req.session.user.id)));
  return conn ?? null;
}

connectionsRouter.get("/", async (req, res) => {
  const r = req as AuthedRequest;
  const conns = await db
    .select({
      id: connections.id,
      name: connections.name,
      description: connections.description,
      dbType: connections.dbType,
      databaseName: connections.databaseName,
      syncStatus: connections.syncStatus,
      lastSyncAt: connections.lastSyncAt,
      sandboxPort: connections.sandboxPort,
      createdAt: connections.createdAt,
    })
    .from(connections)
    .where(eq(connections.userId, r.session.user.id));
  res.json(conns);
});

connectionsRouter.post("/", async (req, res) => {
  const r = req as AuthedRequest;
  const { name, connectionString, databaseName, dbType, description } = req.body as {
    name?: string;
    connectionString?: string;
    databaseName?: string;
    dbType?: string;
    description?: string | null;
  };

  if (!name || !connectionString) {
    res.status(400).json({ error: "Name and connection string are required" });
    return;
  }
  if (!databaseName) {
    res.status(400).json({ error: "Database name is required" });
    return;
  }

  let normalizedDbType: string;
  try {
    normalizedDbType = normalizeDbType(dbType ?? "mongodb");
  } catch {
    res.status(400).json({
      error: `Unsupported database type. Supported: ${SUPPORTED_DB_TYPES.join(", ")}`,
    });
    return;
  }

  const adapter = getAdapter(normalizedDbType);

  const validation = await adapter.validateConnection(connectionString, databaseName);
  if (!validation.valid) {
    res.status(400).json({ error: `Connection failed: ${validation.error}` });
    return;
  }

  const size = await adapter.getDatabaseSize(connectionString, databaseName);
  if (size.sizeBytes > MAX_DB_SIZE) {
    res.status(400).json({
      error: `Database too large (${formatBytes(size.sizeBytes)}). Maximum is 20GB.`,
    });
    return;
  }

  const warning =
    size.sizeBytes > WARN_DB_SIZE
      ? `Database is ${formatBytes(size.sizeBytes)} — sync may take a while.`
      : undefined;

  const [connection] = await db
    .insert(connections)
    .values({
      name,
      description: description?.trim() || null,
      dbType: normalizedDbType,
      databaseName,
      connectionString: encrypt(connectionString),
      userId: r.session.user.id,
    })
    .returning();

  if (!connection) {
    res.status(500).json({ error: "Failed to create connection" });
    return;
  }

  res.json({
    id: connection.id,
    name: connection.name,
    collections: size.collections,
    sizeBytes: size.sizeBytes,
    warning,
  });
});

connectionsRouter.get("/:id", async (req, res) => {
  const r = req as AuthedRequest;
  const [conn] = await db
    .select({
      id: connections.id,
      name: connections.name,
      description: connections.description,
      dbType: connections.dbType,
      databaseName: connections.databaseName,
      syncStatus: connections.syncStatus,
      syncError: connections.syncError,
      lastSyncAt: connections.lastSyncAt,
      sandboxPort: connections.sandboxPort,
      sandboxContainerId: connections.sandboxContainerId,
      createdAt: connections.createdAt,
    })
    .from(connections)
    .where(and(eq(connections.id, req.params.id), eq(connections.userId, r.session.user.id)));

  if (!conn) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(conn);
});

connectionsRouter.patch("/:id", async (req, res) => {
  const r = req as AuthedRequest;
  const conn = await loadOwnedConnection(r, req.params.id);
  if (!conn) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  const { name, description } = req.body as {
    name?: string;
    description?: string | null;
  };

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (typeof name === "string") {
    const trimmed = name.trim();
    if (!trimmed) {
      res.status(400).json({ error: "Name cannot be empty" });
      return;
    }
    updates.name = trimmed;
  }
  if (description !== undefined) {
    updates.description =
      typeof description === "string" && description.trim()
        ? description.trim()
        : null;
  }

  if (Object.keys(updates).length <= 1) {
    res.status(400).json({ error: "No valid fields to update" });
    return;
  }

  const [updated] = await db
    .update(connections)
    .set(updates)
    .where(eq(connections.id, req.params.id))
    .returning({
      id: connections.id,
      name: connections.name,
      description: connections.description,
      databaseName: connections.databaseName,
    });

  res.json(updated);
});

connectionsRouter.delete("/:id", async (req, res) => {
  const r = req as AuthedRequest;
  const conn = await loadOwnedConnection(r, req.params.id);
  if (!conn) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  try {
    await sandboxManager.destroy(req.params.id, true);
  } catch {
    // already gone
  }

  await db.delete(connections).where(eq(connections.id, req.params.id));
  res.json({ ok: true });
});

connectionsRouter.get("/:id/status", async (req, res) => {
  const r = req as AuthedRequest;
  const conn = await loadOwnedConnection(r, req.params.id);
  if (!conn) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  const sandbox = await sandboxManager.getStatus(req.params.id, conn.dbType);
  res.json({
    syncStatus: conn.syncStatus,
    syncError: conn.syncError,
    lastSyncAt: conn.lastSyncAt,
    sandbox: sandbox ? { running: sandbox.running, port: sandbox.port } : null,
  });
});

connectionsRouter.post("/:id/sync", async (req, res) => {
  const r = req as AuthedRequest;
  const conn = await loadOwnedConnection(r, req.params.id);
  if (!conn) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  if (conn.syncStatus === "SYNCING") {
    res.status(409).json({ error: "Sync already in progress" });
    return;
  }

  syncConnection(req.params.id).catch((err) => {
    console.error(`Sync failed for connection ${req.params.id}:`, err);
  });

  res.json({ ok: true, message: "Sync started" });
});

connectionsRouter.get("/:id/schema", async (req, res) => {
  const r = req as AuthedRequest;
  const conn = await loadOwnedConnection(r, req.params.id);
  if (!conn) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  const tables = await db
    .select()
    .from(schemaTables)
    .where(eq(schemaTables.connectionId, req.params.id));

  const result = await Promise.all(
    tables.map(async (table) => {
      const cols = await db
        .select()
        .from(schemaColumns)
        .where(eq(schemaColumns.tableId, table.id));
      const rels = await db
        .select()
        .from(schemaRelationships)
        .where(eq(schemaRelationships.sourceTableId, table.id));
      return { ...table, columns: cols, relationships: rels };
    })
  );

  res.json(result);
});

connectionsRouter.get("/:id/schema/summary", async (req, res) => {
  const r = req as AuthedRequest;
  const conn = await loadOwnedConnection(r, req.params.id);
  if (!conn) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const markdown = await generateSchemaMarkdown(req.params.id);
  res.setHeader("Content-Type", "text/markdown; charset=utf-8");
  res.send(markdown);
});

connectionsRouter.patch("/:id/schema/tables/:tableId", async (req, res) => {
  const r = req as AuthedRequest;
  const conn = await loadOwnedConnection(r, req.params.id);
  if (!conn) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  const { isVisible, description } = req.body as {
    isVisible?: boolean;
    description?: string | null;
  };

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (typeof isVisible === "boolean") updates.isVisible = isVisible;
  if (description !== undefined) updates.description = description;

  if (Object.keys(updates).length <= 1) {
    res.status(400).json({ error: "No valid fields to update" });
    return;
  }

  const [table] = await db
    .update(schemaTables)
    .set(updates)
    .where(eq(schemaTables.id, req.params.tableId))
    .returning();

  res.json(table);
});

connectionsRouter.patch("/:id/schema/columns/:columnId", async (req, res) => {
  const r = req as AuthedRequest;
  const conn = await loadOwnedConnection(r, req.params.id);
  if (!conn) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  const { isVisible } = req.body as { isVisible?: boolean };
  if (typeof isVisible !== "boolean") {
    res.status(400).json({ error: "isVisible must be a boolean" });
    return;
  }

  const [column] = await db
    .update(schemaColumns)
    .set({ isVisible, updatedAt: new Date() })
    .where(eq(schemaColumns.id, req.params.columnId))
    .returning();

  res.json(column);
});

connectionsRouter.get("/:id/memories", async (req, res) => {
  const r = req as AuthedRequest;
  const conn = await loadOwnedConnection(r, req.params.id);
  if (!conn) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  const memories = await db
    .select()
    .from(queryMemories)
    .where(eq(queryMemories.connectionId, req.params.id))
    .orderBy(desc(queryMemories.frequency));

  res.json(memories);
});

connectionsRouter.post("/:id/memories", async (req, res) => {
  const r = req as AuthedRequest;
  const conn = await loadOwnedConnection(r, req.params.id);
  if (!conn) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  const { pattern, description, exampleQuery, collection } = req.body as {
    pattern?: string;
    description?: string;
    exampleQuery?: string;
    collection?: string;
  };

  if (!pattern || !description) {
    res.status(400).json({ error: "pattern and description required" });
    return;
  }

  const [memory] = await db
    .insert(queryMemories)
    .values({
      connectionId: req.params.id,
      pattern,
      description,
      exampleQuery: exampleQuery ?? null,
      collection: collection ?? null,
      frequency: 1,
      lastUsedAt: new Date(),
    })
    .returning();

  res.status(201).json(memory);
});

connectionsRouter.delete("/:id/memories", async (req, res) => {
  const r = req as AuthedRequest;
  const conn = await loadOwnedConnection(r, req.params.id);
  if (!conn) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  const memoryId = req.query.memoryId;
  if (typeof memoryId !== "string" || !memoryId) {
    res.status(400).json({ error: "memoryId required" });
    return;
  }

  await db.delete(queryMemories).where(eq(queryMemories.id, memoryId));
  res.json({ ok: true });
});
