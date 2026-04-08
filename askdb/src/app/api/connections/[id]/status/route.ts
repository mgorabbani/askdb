import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { connections } from "@/lib/db/schema";
import { getSession } from "@/lib/auth/session";
import { sandboxManager } from "@/lib/docker/manager";
import { and, eq } from "drizzle-orm";

export async function GET(
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

  const sandbox = await sandboxManager.getStatus(id);

  return NextResponse.json({
    syncStatus: conn.syncStatus,
    syncError: conn.syncError,
    lastSyncAt: conn.lastSyncAt,
    sandbox: sandbox ? { running: sandbox.running, port: sandbox.port } : null,
  });
}
