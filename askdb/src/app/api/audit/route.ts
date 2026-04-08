import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { auditLogs, connections } from "@/lib/db/schema";
import { getSession } from "@/lib/auth/session";
import { and, eq, desc, sql, count } from "drizzle-orm";

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = req.nextUrl;
  const page = Math.max(1, parseInt(searchParams.get("page") || "1", 10));
  const limit = Math.min(
    100,
    Math.max(1, parseInt(searchParams.get("limit") || "50", 10))
  );
  const connectionId = searchParams.get("connectionId");
  const action = searchParams.get("action");

  const offset = (page - 1) * limit;

  // Build conditions: only logs for connections owned by this user
  const conditions = [eq(connections.userId, session.user.id)];

  if (connectionId) {
    conditions.push(eq(auditLogs.connectionId, connectionId));
  }
  if (action) {
    conditions.push(eq(auditLogs.action, action));
  }

  const where = and(...conditions);

  const [rows, totalResult] = await Promise.all([
    db
      .select({
        id: auditLogs.id,
        action: auditLogs.action,
        query: auditLogs.query,
        collection: auditLogs.collection,
        executionMs: auditLogs.executionMs,
        docCount: auditLogs.docCount,
        createdAt: auditLogs.createdAt,
        connectionId: auditLogs.connectionId,
        connectionName: connections.name,
      })
      .from(auditLogs)
      .innerJoin(connections, eq(auditLogs.connectionId, connections.id))
      .where(where)
      .orderBy(desc(auditLogs.createdAt))
      .limit(limit)
      .offset(offset),
    db
      .select({ total: count() })
      .from(auditLogs)
      .innerJoin(connections, eq(auditLogs.connectionId, connections.id))
      .where(where),
  ]);

  const total = totalResult[0]?.total ?? 0;

  return NextResponse.json({
    data: rows,
    page,
    limit,
    total,
    totalPages: Math.ceil(total / limit),
  });
}
