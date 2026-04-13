import { Router, type Router as ExpressRouter } from "express";
import { and, eq, desc, count, db, schema } from "@askdb/shared";
import { requireSession, type AuthedRequest } from "../lib/session.js";

const { auditLogs, connections } = schema;

export const auditRouter: ExpressRouter = Router();
auditRouter.use(requireSession);

auditRouter.get("/", async (req, res) => {
  const r = req as AuthedRequest;

  const page = Math.max(1, parseInt(String(req.query.page ?? "1"), 10));
  const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? "50"), 10)));
  const connectionId = typeof req.query.connectionId === "string" ? req.query.connectionId : null;
  const action = typeof req.query.action === "string" ? req.query.action : null;

  const offset = (page - 1) * limit;

  const conditions = [eq(connections.userId, r.session.user.id)];
  if (connectionId) conditions.push(eq(auditLogs.connectionId, connectionId));
  if (action) conditions.push(eq(auditLogs.action, action));

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

  res.json({
    data: rows,
    page,
    limit,
    total,
    totalPages: Math.ceil(total / limit),
  });
});
