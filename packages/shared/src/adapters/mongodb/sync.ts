import { spawn } from "child_process";

export interface MongoSyncOptions {
  prodUri: string;
  sandboxUri: string;
  databaseName: string;
  tmpDir: string;
}

export async function runMongoDumpRestore(opts: MongoSyncOptions): Promise<void> {
  const { prodUri, sandboxUri, databaseName, tmpDir } = opts;
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
      else reject(new Error(`${command} exited with code ${code}: ${stderr.slice(-500)}`));
    });

    proc.on("error", (err) => {
      clearTimeout(timeout);
      reject(new Error(`${command} failed to start: ${err.message}`));
    });
  });
}
