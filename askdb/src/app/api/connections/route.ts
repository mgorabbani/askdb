import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { connections } from "@/lib/db/schema";
import { getSession } from "@/lib/auth/session";
import { encrypt } from "@/lib/crypto/encryption";
import { MongoDBAdapter } from "@/lib/adapters/mongodb";
import { eq } from "drizzle-orm";

const adapter = new MongoDBAdapter();

const MAX_DB_SIZE = 20 * 1024 * 1024 * 1024;
const WARN_DB_SIZE = 5 * 1024 * 1024 * 1024;

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  const { name, connectionString, databaseName } = body as {
    name?: string;
    connectionString?: string;
    databaseName?: string;
  };

  if (!name || !connectionString) {
    return NextResponse.json({ error: "Name and connection string are required" }, { status: 400 });
  }

  if (!databaseName) {
    return NextResponse.json({ error: "Database name is required" }, { status: 400 });
  }

  const validation = await adapter.validateConnection(connectionString, databaseName);
  if (!validation.valid) {
    return NextResponse.json({ error: `Connection failed: ${validation.error}` }, { status: 400 });
  }

  const size = await adapter.getDatabaseSize(connectionString, databaseName);
  if (size.sizeBytes > MAX_DB_SIZE) {
    return NextResponse.json({
      error: `Database too large (${formatBytes(size.sizeBytes)}). Maximum is 20GB.`,
    }, { status: 400 });
  }

  const warning = size.sizeBytes > WARN_DB_SIZE
    ? `Database is ${formatBytes(size.sizeBytes)} — sync may take a while.`
    : undefined;

  const encryptedConnString = encrypt(connectionString);
  const [connection] = await db
    .insert(connections)
    .values({
      name,
      dbType: "mongodb",
      databaseName,
      connectionString: encryptedConnString,
      userId: session.user.id,
    })
    .returning();

  return NextResponse.json({
    id: connection.id,
    name: connection.name,
    collections: size.collections,
    sizeBytes: size.sizeBytes,
    warning,
  });
}

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const conns = await db
    .select({
      id: connections.id,
      name: connections.name,
      dbType: connections.dbType,
      syncStatus: connections.syncStatus,
      lastSyncAt: connections.lastSyncAt,
      sandboxPort: connections.sandboxPort,
      createdAt: connections.createdAt,
    })
    .from(connections)
    .where(eq(connections.userId, session.user.id));

  return NextResponse.json(conns);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}
