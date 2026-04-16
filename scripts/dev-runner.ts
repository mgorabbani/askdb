import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(import.meta.url), "../..");

type Service = {
  name: string;
  filter: string;
  color: string;
  env?: Record<string, string>;
};

const services: Service[] = [
  {
    name: "server",
    filter: "@askdb/server",
    color: "\x1b[36m", // cyan
    env: { UI_DEV_MIDDLEWARE: "1" },
  },
];

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";

function prefixStream(stream: NodeJS.ReadableStream, name: string, color: string, isErr: boolean) {
  const rl = createInterface({ input: stream });
  rl.on("line", (line) => {
    const tag = `${color}[${name}]${RESET}`;
    const out = isErr ? process.stderr : process.stdout;
    out.write(`${tag} ${line}\n`);
  });
}

const children: { service: Service; child: ChildProcess }[] = [];
let shuttingDown = false;

function spawnService(service: Service) {
  const child = spawn("pnpm", ["--filter", service.filter, "dev"], {
    cwd: repoRoot,
    env: { ...process.env, ...service.env, FORCE_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (child.stdout) prefixStream(child.stdout, service.name.trim(), service.color, false);
  if (child.stderr) prefixStream(child.stderr, service.name.trim(), service.color, true);

  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    process.stderr.write(
      `${DIM}[dev-runner] ${service.name.trim()} exited (code=${code} signal=${signal}); shutting down siblings${RESET}\n`,
    );
    shutdown(code ?? 1);
  });

  children.push({ service, child });
  return child;
}

async function shutdown(exitCode: number) {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stderr.write(`${DIM}[dev-runner] shutting down...${RESET}\n`);

  const stillRunning = children.filter(({ child }) => child.exitCode === null);
  for (const { child } of stillRunning) {
    child.kill("SIGTERM");
  }

  const killTimer = setTimeout(() => {
    for (const { service, child } of children) {
      if (child.exitCode === null) {
        process.stderr.write(`${DIM}[dev-runner] ${service.name.trim()} did not exit; SIGKILL${RESET}\n`);
        child.kill("SIGKILL");
      }
    }
  }, 5000);

  await Promise.all(
    stillRunning.map(
      ({ child }) =>
        new Promise<void>((res) => {
          if (child.exitCode !== null) return res();
          child.once("exit", () => res());
        }),
    ),
  );

  clearTimeout(killTimer);
  process.exit(exitCode);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

process.stderr.write(
  `${DIM}[dev-runner] starting ${services.map((s) => s.name.trim()).join(" + ")} (Ctrl+C to stop)${RESET}\n`,
);

for (const service of services) {
  spawnService(service);
}
