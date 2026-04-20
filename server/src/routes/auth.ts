import { Router, type Router as ExpressRouter, type Request } from "express";
import { toNodeHandler } from "better-auth/node";
import { db, recordAuthAudit } from "@askdb/shared";
import { auth } from "../lib/auth.js";

export const authRouter: ExpressRouter = Router();

// Map the better-auth path we care about auditing → the event name we emit.
// better-auth mounts sign-in/sign-up under /email (the email+password method).
const AUDITED_PATHS: Array<{ match: RegExp; event: string }> = [
  { match: /\/sign-in\/email/i, event: "auth.sign_in" },
  { match: /\/sign-up\/email/i, event: "auth.sign_up" },
];

function auditedPathEvent(req: Request): string | null {
  for (const { match, event } of AUDITED_PATHS) {
    if (match.test(req.path)) return event;
  }
  return null;
}

authRouter.use((req, res, next) => {
  const event = auditedPathEvent(req);
  if (!event) return next();

  res.on("finish", () => {
    const ok = res.statusCode >= 200 && res.statusCode < 300;
    // better-auth consumes the raw request stream, so we don't try to read
    // the email from the body here (it isn't parsed by express yet and we
    // don't want to log plaintext credentials in any case).
    recordAuthAudit(db, {
      event,
      outcome: ok ? "success" : "failure",
      ipAddress: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
      details: { status: res.statusCode },
    });
  });
  next();
});

authRouter.all("/*splat", toNodeHandler(auth));
