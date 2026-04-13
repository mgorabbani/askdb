import { spawn } from "child_process";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { db } from "../../db/index.js";
import { connections } from "../../db/schema.js";
import { decrypt } from "../../crypto/encryption.js";
import { sandboxManager } from "../../docker/manager.js";
import { introspectAndSave } from "./introspect.js";
import { eq } from "drizzle-orm";

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

    const prodUri = decrypt(connection.connectionString);

    let sandboxPort = connection.sandboxPort;
    if (!sandboxPort || !connection.sandboxContainerId) {
      const sandbox = await sandboxManager.create(connectionId);
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

    const sandboxUri = sandboxManager.getConnectionString(sandboxPort);

    tmpDir = await mkdtemp(path.join(tmpdir(), `askdb-dump-${connectionId}-`));

    const dbName = connection.databaseName;
    const dumpArgs = [`--uri=${prodUri}`, `--out=${tmpDir}`];
    const restoreArgs = [`--uri=${sandboxUri}`, "--drop", tmpDir];
    if (dbName) {
      dumpArgs.push(`--db=${dbName}`);
      restoreArgs.push(`--nsFrom=${dbName}.*`, `--nsTo=${dbName}.*`);
    }
    await runCommand("mongodump", dumpArgs);
    await runCommand("mongorestore", restoreArgs);

    await introspectAndSave(connectionId, sandboxUri, dbName || undefined);

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

function runCommand(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { stdio: "pipe" });
    let stderr = "";

    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    const timeout = setTimeout(() => {
      proc.kill("SIGTERM");
      reject(new Error(`${command} timed out after 10 minutes`));
    }, 10 * 60 * 1000);

    proc.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with code ${code}: ${stderr.slice(-500)}`));
    });

    proc.on("error", (err) => {
      clearTimeout(timeout);
      reject(new Error(`${command} failed to start: ${err.message}`));
    });
  });
}
