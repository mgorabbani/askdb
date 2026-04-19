import Docker from "dockerode";
import { existsSync } from "fs";
import net from "net";
import { normalizeDbType, type SupportedDbType } from "../adapters/factory.js";

// When DOCKER_HOST is set (e.g. tcp://docker-socket-proxy:2375), dockerode
// parses it automatically. Fall back to the Unix socket for bare-metal runs.
const dockerOpts = process.env.DOCKER_HOST
  ? {}
  : { socketPath: "/var/run/docker.sock" };
const docker = new Docker(dockerOpts);

const CONTAINER_PREFIX = "askdb-sandbox-";
const VOLUME_PREFIX = "askdb-data-";

// Detect if running inside Docker — use host.docker.internal to reach host-mapped ports
const isInDocker = existsSync("/.dockerenv");
const HOST = isInDocker ? "host.docker.internal" : "localhost";

// Cold start (especially on a fresh VPS pulling the image) can take 20-40s.
const READY_TIMEOUT_SECONDS = parseInt(
  process.env.SANDBOX_READY_TIMEOUT_SECONDS ?? "60",
  10,
);

interface DbTypeConfig {
  image: string;
  internalPort: number;
  portRangeStart: number;
  portRangeEnd: number;
  env?: Record<string, string>;
  dataDir: string;
  connectionString: (host: string, port: number) => string;
  waitForReady: (host: string, port: number, timeoutSeconds: number) => Promise<void>;
}

const DB_CONFIGS: Record<SupportedDbType, DbTypeConfig> = {
  mongodb: {
    image: "mongo:7",
    internalPort: 27017,
    portRangeStart: 27100,
    portRangeEnd: 27199,
    dataDir: "/data/db",
    connectionString: (host, port) => `mongodb://${host}:${port}`,
    async waitForReady(host, port, timeoutSeconds) {
      const { MongoClient } = await import("mongodb");
      const deadline = Date.now() + timeoutSeconds * 1000;
      while (Date.now() < deadline) {
        try {
          const client = new MongoClient(`mongodb://${host}:${port}`, {
            serverSelectionTimeoutMS: 2000,
            connectTimeoutMS: 2000,
          });
          await client.connect();
          await client.db("admin").command({ ping: 1 });
          await client.close();
          return;
        } catch {
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
      throw new Error(`Sandbox MongoDB on port ${port} did not become ready in ${timeoutSeconds}s`);
    },
  },
  postgresql: {
    image: "postgres:17-alpine",
    internalPort: 5432,
    portRangeStart: 54320,
    portRangeEnd: 54419,
    env: {
      POSTGRES_PASSWORD: "askdb",
      POSTGRES_USER: "askdb",
      POSTGRES_DB: "postgres",
    },
    dataDir: "/var/lib/postgresql/data",
    connectionString: (host, port) =>
      `postgresql://askdb:askdb@${host}:${port}/postgres`,
    async waitForReady(host, port, timeoutSeconds) {
      const { Client } = await import("pg");
      const deadline = Date.now() + timeoutSeconds * 1000;
      while (Date.now() < deadline) {
        const open = await new Promise<boolean>((resolve) => {
          const socket = net.createConnection({ host, port, timeout: 2000 });
          socket.once("connect", () => {
            socket.end();
            resolve(true);
          });
          socket.once("error", () => resolve(false));
          socket.once("timeout", () => {
            socket.destroy();
            resolve(false);
          });
        });
        if (open) {
          // Give Postgres a moment to accept auth after the port opens.
          try {
            const client = new Client({
              connectionString: `postgresql://askdb:askdb@${host}:${port}/postgres`,
              connectionTimeoutMillis: 2000,
            });
            await client.connect();
            await client.query("SELECT 1");
            await client.end();
            return;
          } catch {
            // still starting — fall through to retry
          }
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
      throw new Error(`Sandbox PostgreSQL on port ${port} did not become ready in ${timeoutSeconds}s`);
    },
  },
};

export interface SandboxInfo {
  containerId: string;
  port: number;
  running: boolean;
}

export class SandboxManager {
  /** Create and start a sandbox container, reusing existing one if present */
  async create(connectionId: string, dbType = "mongodb"): Promise<SandboxInfo> {
    const config = DB_CONFIGS[normalizeDbType(dbType)];

    // Check if container already exists
    const existing = await this.getStatus(connectionId, dbType);
    if (existing) {
      if (!existing.running) {
        const container = docker.getContainer(`${CONTAINER_PREFIX}${connectionId}`);
        await container.start();
        await config.waitForReady(HOST, existing.port, READY_TIMEOUT_SECONDS);
        return { ...existing, running: true };
      }
      await config.waitForReady(HOST, existing.port, READY_TIMEOUT_SECONDS);
      return existing;
    }

    // Ensure image exists
    await this.pullImageIfNeeded(config.image);

    const containerName = `${CONTAINER_PREFIX}${connectionId}`;
    const volumeName = `${VOLUME_PREFIX}${connectionId}`;
    const port = await this.findAvailablePort(config.portRangeStart, config.portRangeEnd);

    const envList = config.env
      ? Object.entries(config.env).map(([k, v]) => `${k}=${v}`)
      : undefined;

    const portKey = `${config.internalPort}/tcp`;
    const container = await docker.createContainer({
      Image: config.image,
      name: containerName,
      Env: envList,
      Labels: {
        "managed-by": "askdb",
        "connection-id": connectionId,
        "db-type": normalizeDbType(dbType),
      },
      HostConfig: {
        Binds: [`${volumeName}:${config.dataDir}`],
        PortBindings: {
          [portKey]: [{ HostPort: String(port) }],
        },
        RestartPolicy: { Name: "unless-stopped" },
      },
      ExposedPorts: { [portKey]: {} },
    });

    await container.start();

    await config.waitForReady(HOST, port, READY_TIMEOUT_SECONDS);

    return {
      containerId: container.id,
      port,
      running: true,
    };
  }

  /** Destroy a sandbox container and optionally its volume */
  async destroy(connectionId: string, removeVolume = false) {
    const containerName = `${CONTAINER_PREFIX}${connectionId}`;

    try {
      const container = docker.getContainer(containerName);
      const info = await container.inspect();

      if (info.State.Running) {
        await container.stop({ t: 5 });
      }
      await container.remove({ force: true });
    } catch (err: unknown) {
      // Container might not exist — that's fine
      if (err instanceof Error && !err.message.includes("no such container")) {
        throw err;
      }
    }

    if (removeVolume) {
      try {
        const volume = docker.getVolume(`${VOLUME_PREFIX}${connectionId}`);
        await volume.remove();
      } catch {
        // Volume might not exist
      }
    }
  }

  /** Get sandbox status */
  async getStatus(connectionId: string, dbType = "mongodb"): Promise<SandboxInfo | null> {
    const containerName = `${CONTAINER_PREFIX}${connectionId}`;
    const config = DB_CONFIGS[normalizeDbType(dbType)];

    try {
      const container = docker.getContainer(containerName);
      const info = await container.inspect();

      const portBindings = info.NetworkSettings.Ports?.[`${config.internalPort}/tcp`];
      const port = portBindings?.[0]
        ? parseInt(portBindings[0].HostPort, 10)
        : 0;

      return {
        containerId: info.Id,
        port,
        running: info.State.Running,
      };
    } catch {
      return null;
    }
  }

  /** Get the connection string for a sandbox */
  getConnectionString(port: number, dbType = "mongodb"): string {
    const config = DB_CONFIGS[normalizeDbType(dbType)];
    return config.connectionString(HOST, port);
  }

  private async pullImageIfNeeded(image: string) {
    try {
      await docker.getImage(image).inspect();
    } catch {
      // Image not found locally — pull it
      const stream = await docker.pull(image);
      await new Promise<void>((resolve, reject) => {
        docker.modem.followProgress(stream, (err: Error | null) => {
          if (err) reject(err);
          else resolve();
        });
      });
    }
  }

  private async findAvailablePort(start: number, end: number): Promise<number> {
    const containers = await docker.listContainers({ all: true });
    const usedPorts = new Set<number>();

    for (const c of containers) {
      if (c.Names.some((n) => n.startsWith(`/${CONTAINER_PREFIX}`))) {
        for (const p of c.Ports) {
          if (p.PublicPort) usedPorts.add(p.PublicPort);
        }
      }
    }

    for (let port = start; port <= end; port++) {
      if (!usedPorts.has(port)) return port;
    }

    throw new Error(`No available ports in range ${start}-${end}`);
  }
}

export const sandboxManager = new SandboxManager();
