import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { connections } from "@/lib/db/schema";
import { getSession } from "@/lib/auth/session";
import { and, eq } from "drizzle-orm";
import { sandboxManager } from "@/lib/docker/manager";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const [conn] = await db
    .select({
      id: connections.id,
      name: connections.name,
      dbType: connections.dbType,
      syncStatus: connections.syncStatus,
      syncError: connections.syncError,
      lastSyncAt: connections.lastSyncAt,
      sandboxPort: connections.sandboxPort,
      sandboxContainerId: connections.sandboxContainerId,
      createdAt: connections.createdAt,
    })
    .from(connections)
    .where(and(eq(connections.id, id), eq(connections.userId, session.user.id)));

  if (!conn) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return NextResponse.json(conn);
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const [conn] = await db
    .select()
    .from(connections)
    .where(and(eq(connections.id, id), eq(connections.userId, session.user.id)));

  if (!conn) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Clean up Docker sandbox container and volume
  try {
    await sandboxManager.destroy(id, true);
  } catch {
    // Container may already be gone — continue with DB cleanup
  }

  await db.delete(connections).where(eq(connections.id, id));
  return NextResponse.json({ ok: true });
}
