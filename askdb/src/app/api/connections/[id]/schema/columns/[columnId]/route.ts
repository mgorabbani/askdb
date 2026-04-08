import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { connections, schemaColumns } from "@/lib/db/schema";
import { getSession } from "@/lib/auth/session";
import { and, eq } from "drizzle-orm";

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string; columnId: string }> }
) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id, columnId } = await params;

  const [conn] = await db
    .select()
    .from(connections)
    .where(and(eq(connections.id, id), eq(connections.userId, session.user.id)));
  if (!conn) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const body = await req.json();
  const { isVisible } = body as { isVisible?: boolean };
  if (typeof isVisible !== "boolean") {
    return NextResponse.json({ error: "isVisible must be a boolean" }, { status: 400 });
  }

  const [column] = await db
    .update(schemaColumns)
    .set({ isVisible, updatedAt: new Date() })
    .where(eq(schemaColumns.id, columnId))
    .returning();

  return NextResponse.json(column);
}
