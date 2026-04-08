import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { connections, schemaTables, schemaColumns, schemaRelationships } from "@/lib/db/schema";
import { getSession } from "@/lib/auth/session";
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

  const tables = await db
    .select()
    .from(schemaTables)
    .where(eq(schemaTables.connectionId, id));

  const result = await Promise.all(
    tables.map(async (table) => {
      const cols = await db
        .select()
        .from(schemaColumns)
        .where(eq(schemaColumns.tableId, table.id));
      const rels = await db
        .select()
        .from(schemaRelationships)
        .where(eq(schemaRelationships.sourceTableId, table.id));
      return { ...table, columns: cols, relationships: rels };
    })
  );

  return NextResponse.json(result);
}
