import { spawn } from "child_process";
import { assertValidDatabaseName } from "../factory.js";

export interface MongoSyncOptions {
  prodUri: string;
  sandboxUri: string;
  databaseName: string;
  tmpDir: string;
}

// Mirror of redactPgErrorOutput for mongo tooling — strip userinfo on
// mongodb:// URIs and any stray password= that tools might log.
function redactMongoErrorOutput(raw: string): string {
  return raw
    .replace(/(mongodb(?:\+srv)?:\/\/)[^@\s]*@/gi, "$1[redacted]@")
    .replace(/\b(password)\s*=\s*\S+/gi, "$1=[redacted]");
}

export async function runMongoDumpRestore(opts: MongoSyncOptions): Promise<void> {
  const { prodUri, sandboxUri, databaseName, tmpDir } = opts;
  assertValidDatabaseName(databaseName);
  const dumpArgs = [`--uri=${prodUri}`, `--out=${tmpDir}`];
  const restoreArgs = [`--uri=${sandboxUri}`, "--drop", tmpDir];
  if (databaseName) {
    dumpArgs.push(`--db=${databaseName}`);
    restoreArgs.push(`--nsFrom=${databaseName}.*`, `--nsTo=${databaseName}.*`);
  }
  await runCommand("mongodump", dumpArgs);
  await runCommand("mongorestore", restoreArgs);
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
      else reject(new Error(
        `${command} exited with code ${code}: ${redactMongoErrorOutput(stderr).slice(-500)}`
      ));
    });

    proc.on("error", (err) => {
      clearTimeout(timeout);
      reject(new Error(`${command} failed to start: ${redactMongoErrorOutput(err.message)}`));
    });
  });
}
