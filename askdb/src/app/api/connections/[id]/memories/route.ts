import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { connections, queryMemories } from "@/lib/db/schema";
import { getSession } from "@/lib/auth/session";
import { and, eq, desc } from "drizzle-orm";

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

  const memories = await db
    .select()
    .from(queryMemories)
    .where(eq(queryMemories.connectionId, id))
    .orderBy(desc(queryMemories.frequency));

  return NextResponse.json(memories);
}

export async function POST(
  req: Request,
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

  const body = await req.json();
  const { pattern, description, exampleQuery, collection } = body as {
    pattern: string;
    description: string;
    exampleQuery?: string;
    collection?: string;
  };

  if (!pattern || !description) {
    return NextResponse.json({ error: "pattern and description required" }, { status: 400 });
  }

  const [memory] = await db
    .insert(queryMemories)
    .values({
      connectionId: id,
      pattern,
      description,
      exampleQuery: exampleQuery ?? null,
      collection: collection ?? null,
      frequency: 1,
      lastUsedAt: new Date(),
    })
    .returning();

  return NextResponse.json(memory, { status: 201 });
}

export async function DELETE(
  req: Request,
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

  const { searchParams } = new URL(req.url);
  const memoryId = searchParams.get("memoryId");

  if (!memoryId) {
    return NextResponse.json({ error: "memoryId required" }, { status: 400 });
  }

  await db.delete(queryMemories).where(eq(queryMemories.id, memoryId));
  return NextResponse.json({ ok: true });
}
