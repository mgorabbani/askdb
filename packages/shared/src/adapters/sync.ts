import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { connections } from "../db/schema.js";
import { decrypt } from "../crypto/encryption.js";
import { sandboxManager } from "../docker/manager.js";
import { normalizeDbType } from "./factory.js";
import { runMongoDumpRestore } from "./mongodb/sync.js";
import { introspectAndSave as mongoIntrospectAndSave } from "./mongodb/introspect.js";
import { runPostgresDumpRestore } from "./postgresql/sync.js";
import { introspectAndSave as postgresIntrospectAndSave } from "./postgresql/introspect.js";

export async function syncConnection(connectionId: string) {
  await db
    .update(connections)
    .set({ syncStatus: "SYNCING", syncError: null, updatedAt: new Date() })
    .where(eq(connections.id, connectionId));

  let tmpDir: string | null = null;

  try {
    const [connection] = await db
      .select()
      .from(connections)
      .where(eq(connections.id, connectionId));

    if (!connection) throw new Error("Connection not found");

    const dbType = normalizeDbType(connection.dbType);
    const prodUri = decrypt(connection.connectionString);

    let sandboxPort = connection.sandboxPort;
    if (!sandboxPort || !connection.sandboxContainerId) {
      const sandbox = await sandboxManager.create(connectionId, dbType);
      sandboxPort = sandbox.port;
      await db
        .update(connections)
        .set({
          sandboxContainerId: sandbox.containerId,
          sandboxPort: sandbox.port,
          updatedAt: new Date(),
        })
        .where(eq(connections.id, connectionId));
    }

    const sandboxUri = sandboxManager.getConnectionString(sandboxPort, dbType);

    tmpDir = await mkdtemp(path.join(tmpdir(), `askdb-dump-${connectionId}-`));
    const databaseName = connection.databaseName;

    if (dbType === "mongodb") {
      await runMongoDumpRestore({ prodUri, sandboxUri, databaseName, tmpDir });
      await mongoIntrospectAndSave(connectionId, sandboxUri, databaseName || undefined);
    } else {
      await runPostgresDumpRestore({ prodUri, sandboxUri, databaseName, tmpDir });
      await postgresIntrospectAndSave(connectionId, sandboxUri, databaseName || undefined);
    }

    await db
      .update(connections)
      .set({
        syncStatus: "COMPLETED",
        lastSyncAt: new Date(),
        syncError: null,
        updatedAt: new Date(),
      })
      .where(eq(connections.id, connectionId));
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown sync error";
    await db
      .update(connections)
      .set({ syncStatus: "FAILED", syncError: message, updatedAt: new Date() })
      .where(eq(connections.id, connectionId));
    throw err;
  } finally {
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
