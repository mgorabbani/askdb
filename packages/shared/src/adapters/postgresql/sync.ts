import { spawn } from "child_process";
import { Client } from "pg";

export interface PgSyncOptions {
  prodUri: string;
  sandboxUri: string;
  databaseName: string;
  tmpDir: string;
}

/**
 * Dump the prod PostgreSQL database with pg_dump and load it into the sandbox
 * with psql. Uses --clean --if-exists so repeated syncs replace prior data.
 */
export async function runPostgresDumpRestore(opts: PgSyncOptions): Promise<void> {
  const { prodUri, sandboxUri, databaseName, tmpDir } = opts;

  const dumpFile = `${tmpDir}/dump.sql`;

  const prodUriWithDb = injectDatabase(prodUri, databaseName);
  const sandboxUriWithDb = injectDatabase(sandboxUri, databaseName);

  // pg_dump writes plain-text SQL that psql can replay. --clean/--if-exists
  // means tables/indexes are dropped before recreation, making sync idempotent.
  await runCommand(
    "pg_dump",
    [
      "--dbname=" + prodUriWithDb,
      "--format=plain",
      "--clean",
      "--if-exists",
      "--no-owner",
      "--no-privileges",
      "--quote-all-identifiers",
      `--file=${dumpFile}`,
    ],
    { PGCONNECT_TIMEOUT: "10" },
  );

  // Ensure the target database exists on the sandbox before restoring.
  await ensureSandboxDatabase(sandboxUri, databaseName);

  await runCommand(
    "psql",
    [
      "--dbname=" + sandboxUriWithDb,
      "--set=ON_ERROR_STOP=1",
      "--quiet",
      `--file=${dumpFile}`,
    ],
    { PGCONNECT_TIMEOUT: "10" },
  );
}

async function ensureSandboxDatabase(sandboxUri: string, databaseName: string) {
  if (!databaseName) return;
  const client = new Client({
    connectionString: sandboxUri,
    database: "postgres",
    connectionTimeoutMillis: 10_000,
  });
  try {
    await client.connect();
    const { rows } = await client.query<{ exists: number }>(
      "SELECT 1 AS exists FROM pg_database WHERE datname = $1",
      [databaseName],
    );
    if (rows.length > 0) return;
    // CREATE DATABASE does not accept parameters, so we quote-escape the name.
    await client.query(`CREATE DATABASE "${databaseName.replace(/"/g, '""')}"`);
  } finally {
    await client.end().catch(() => {});
  }
}

function injectDatabase(uri: string, databaseName: string): string {
  if (!databaseName) return uri;
  try {
    const url = new URL(uri);
    url.pathname = "/" + encodeURIComponent(databaseName);
    return url.toString();
  } catch {
    return uri;
  }
}

function runCommand(command: string, args: string[], env?: Record<string, string>): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      stdio: "pipe",
      env: { ...process.env, ...env },
    });
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

