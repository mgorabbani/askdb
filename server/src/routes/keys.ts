import { Router, type Router as ExpressRouter } from "express";
import { and, eq, isNull, db, schema, generateApiKey } from "@askdb/shared";
import { requireSession, type AuthedRequest } from "../lib/session.js";

const { apiKeys } = schema;

export const keysRouter: ExpressRouter = Router();
keysRouter.use(requireSession);

keysRouter.get("/", async (req, res) => {
  const r = req as AuthedRequest;
  const keys = await db
    .select({
      id: apiKeys.id,
      prefix: apiKeys.prefix,
      label: apiKeys.label,
      createdAt: apiKeys.createdAt,
    })
    .from(apiKeys)
    .where(and(eq(apiKeys.userId, r.session.user.id), isNull(apiKeys.revokedAt)));
  res.json(keys);
});

keysRouter.post("/", async (req, res) => {
  const r = req as AuthedRequest;
  const { label } = req.body as { label?: string };
  const { fullKey, prefix, hash } = generateApiKey();

  await db.insert(apiKeys).values({
    prefix,
    keyHash: hash,
    label: label || null,
    userId: r.session.user.id,
  });

  res.json({ key: fullKey, prefix });
});

keysRouter.delete("/:id", async (req, res) => {
  const r = req as AuthedRequest;
  const [key] = await db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.id, req.params.id), eq(apiKeys.userId, r.session.user.id)));

  if (!key) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  await db.update(apiKeys).set({ revokedAt: new Date() }).where(eq(apiKeys.id, req.params.id));
  res.json({ ok: true });
});
