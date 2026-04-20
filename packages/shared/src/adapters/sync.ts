import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { connections } from "../db/schema.js";
import { decrypt, encrypt } from "../crypto/encryption.js";
import {
  sandboxManager,
  generateSandboxCredentials,
  type SandboxCredentials,
} from "../docker/manager.js";
import { normalizeDbType, assertValidDatabaseName } from "./factory.js";
import { runMongoDumpRestore } from "./mongodb/sync.js";
import { introspectAndSave as mongoIntrospectAndSave } from "./mongodb/introspect.js";
import { runPostgresDumpRestore } from "./postgresql/sync.js";
import { introspectAndSave as postgresIntrospectAndSave } from "./postgresql/introspect.js";

/**
 * Resolve sandbox credentials for a connection row. Existing rows without a
 * stored password fall back to the legacy "askdb/askdb" literals so in-place
 * upgrades keep working until the sandbox is recreated. Callers that create a
 * new sandbox should persist the returned credentials.
 */
export function resolveSandboxCredentials(
  storedPasswordCipher: string | null | undefined,
): SandboxCredentials {
  if (!storedPasswordCipher) {
    return { user: "askdb", password: "askdb" };
  }
  return { user: "askdb", password: decrypt(storedPasswordCipher) };
}

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
    let credentials: SandboxCredentials;

    if (!sandboxPort || !connection.sandboxContainerId) {
      // Fresh sandbox — mint new credentials and persist them BEFORE createContainer
      // so a crash between those two calls still leaves a recoverable row.
      credentials = generateSandboxCredentials();
      await db
        .update(connections)
        .set({
          sandboxPassword: encrypt(credentials.password),
          updatedAt: new Date(),
        })
        .where(eq(connections.id, connectionId));

      const sandbox = await sandboxManager.create(connectionId, dbType, credentials);
      sandboxPort = sandbox.port;
      await db
        .update(connections)
        .set({
          sandboxContainerId: sandbox.containerId,
          sandboxPort: sandbox.port,
          updatedAt: new Date(),
        })
        .where(eq(connections.id, connectionId));
    } else {
      // Existing sandbox — reuse the stored password. Legacy rows (no password
      // persisted) still work against the old "askdb/askdb" container until
      // they're recreated.
      credentials = resolveSandboxCredentials(connection.sandboxPassword);
    }

    const sandboxUri = sandboxManager.getConnectionString(sandboxPort, credentials, dbType);

    tmpDir = await mkdtemp(path.join(tmpdir(), `askdb-dump-${connectionId}-`));
    const databaseName = connection.databaseName;
    assertValidDatabaseName(databaseName);

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
