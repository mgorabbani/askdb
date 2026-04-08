import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { connections, schemaTables } from "@/lib/db/schema";
import { getSession } from "@/lib/auth/session";
import { and, eq } from "drizzle-orm";

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string; tableId: string }> }
) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id, tableId } = await params;

  const [conn] = await db
    .select()
    .from(connections)
    .where(and(eq(connections.id, id), eq(connections.userId, session.user.id)));
  if (!conn) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const body = await req.json();
  const { isVisible, description } = body as { isVisible?: boolean; description?: string | null };

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (typeof isVisible === "boolean") updates.isVisible = isVisible;
  if (description !== undefined) updates.description = description;

  if (Object.keys(updates).length <= 1) {
    return NextResponse.json({ error: "No valid fields to update" }, { status: 400 });
  }

  const [table] = await db
    .update(schemaTables)
    .set(updates)
    .where(eq(schemaTables.id, tableId))
    .returning();

  return NextResponse.json(table);
}
