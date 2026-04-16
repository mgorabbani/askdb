import Docker from "dockerode";
import { existsSync } from "fs";

// When DOCKER_HOST is set (e.g. tcp://docker-socket-proxy:2375), dockerode
// parses it automatically. Fall back to the Unix socket for bare-metal runs.
const dockerOpts = process.env.DOCKER_HOST
  ? {}
  : { socketPath: "/var/run/docker.sock" };
const docker = new Docker(dockerOpts);

const MONGO_IMAGE = "mongo:7";
const PORT_RANGE_START = 27100;
const PORT_RANGE_END = 27199;
const CONTAINER_PREFIX = "askdb-sandbox-";
const VOLUME_PREFIX = "askdb-data-";

// Detect if running inside Docker — use host.docker.internal to reach host-mapped ports
const isInDocker = existsSync("/.dockerenv");
const MONGO_HOST = isInDocker ? "host.docker.internal" : "localhost";

// Mongo cold start (especially on a fresh VPS pulling the image) can take 20-40s.
const READY_TIMEOUT_SECONDS = parseInt(
  process.env.SANDBOX_READY_TIMEOUT_SECONDS ?? "60",
  10,
);

export interface SandboxInfo {
  containerId: string;
  port: number;
  running: boolean;
}

export class SandboxManager {
  /** Create and start a sandbox MongoDB container, reusing existing one if present */
  async create(connectionId: string): Promise<SandboxInfo> {
    // Check if container already exists
    const existing = await this.getStatus(connectionId);
    if (existing) {
      if (!existing.running) {
        const container = docker.getContainer(`${CONTAINER_PREFIX}${connectionId}`);
        await container.start();
        await this.waitForReady(existing.port, READY_TIMEOUT_SECONDS);
        return { ...existing, running: true };
      }
      await this.waitForReady(existing.port, READY_TIMEOUT_SECONDS);
      return existing;
    }

    // Ensure image exists
    await this.pullImageIfNeeded();

    const containerName = `${CONTAINER_PREFIX}${connectionId}`;
    const volumeName = `${VOLUME_PREFIX}${connectionId}`;
    const port = await this.findAvailablePort();

    const container = await docker.createContainer({
      Image: MONGO_IMAGE,
      name: containerName,
      Labels: {
        "managed-by": "askdb",
        "connection-id": connectionId,
      },
      HostConfig: {
        Binds: [`${volumeName}:/data/db`],
        PortBindings: {
          "27017/tcp": [{ HostPort: String(port) }],
        },
        RestartPolicy: { Name: "unless-stopped" },
      },
      ExposedPorts: { "27017/tcp": {} },
    });

    await container.start();

    // Wait for MongoDB to be ready
    await this.waitForReady(port, READY_TIMEOUT_SECONDS);

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
  async getStatus(connectionId: string): Promise<SandboxInfo | null> {
    const containerName = `${CONTAINER_PREFIX}${connectionId}`;

    try {
      const container = docker.getContainer(containerName);
      const info = await container.inspect();

      const portBindings = info.NetworkSettings.Ports?.["27017/tcp"];
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
  getConnectionString(port: number): string {
    return `mongodb://${MONGO_HOST}:${port}`;
  }

  private async pullImageIfNeeded() {
    try {
      await docker.getImage(MONGO_IMAGE).inspect();
    } catch {
      // Image not found locally — pull it
      const stream = await docker.pull(MONGO_IMAGE);
      await new Promise<void>((resolve, reject) => {
        docker.modem.followProgress(stream, (err: Error | null) => {
          if (err) reject(err);
          else resolve();
        });
      });
    }
  }

  private async findAvailablePort(): Promise<number> {
    const containers = await docker.listContainers({ all: true });
    const usedPorts = new Set<number>();

    for (const c of containers) {
      if (c.Names.some((n) => n.startsWith(`/${CONTAINER_PREFIX}`))) {
        for (const p of c.Ports) {
          if (p.PublicPort) usedPorts.add(p.PublicPort);
        }
      }
    }

    for (let port = PORT_RANGE_START; port <= PORT_RANGE_END; port++) {
      if (!usedPorts.has(port)) return port;
    }

    throw new Error("No available ports in range 27100-27199");
  }

  private async waitForReady(port: number, timeoutSeconds: number) {
    const { MongoClient } = await import("mongodb");
    const deadline = Date.now() + timeoutSeconds * 1000;

    while (Date.now() < deadline) {
      try {
        const client = new MongoClient(`mongodb://${MONGO_HOST}:${port}`, {
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
  }
}

export const sandboxManager = new SandboxManager();
