import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { connections } from "@/lib/db/schema";
import { getSession } from "@/lib/auth/session";
import { and, eq } from "drizzle-orm";
import { generateSchemaMarkdown } from "@/lib/schema-summary/generator";

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

  const markdown = await generateSchemaMarkdown(id);

  return new Response(markdown, {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  });
}
