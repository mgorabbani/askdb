import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { config as loadEnv } from "dotenv";
import rateLimit from "express-rate-limit";
import cookieParser from "cookie-parser";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
loadEnv({ path: path.join(repoRoot, ".env") });

// Resolve DATABASE_PATH relative to repo root so it works regardless of cwd.
if (process.env.DATABASE_PATH && !path.isAbsolute(process.env.DATABASE_PATH)) {
  process.env.DATABASE_PATH = path.resolve(repoRoot, process.env.DATABASE_PATH);
}

const { default: express } = await import("express");
const { authRouter } = await import("./routes/auth.js");
const { isSignupLocked } = await import("./lib/auth.js");
const { createMcpOAuthRouter, getMcpPublicUrl } = await import("./lib/mcp-oauth.js");
const { connectionsRouter } = await import("./routes/connections.js");
const { keysRouter } = await import("./routes/keys.js");
const { auditRouter } = await import("./routes/audit.js");
const { startSyncScheduler } = await import("@askdb/shared");
const { createMcpRouter, createMcpTokenVerifier } = await import("@askdb/mcp-server");
const { getOAuthProtectedResourceMetadataUrl } = await import(
  "@modelcontextprotocol/sdk/server/auth/router.js"
);
const { requireBearerAuth } = await import(
  "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js"
);

type UIMode = "vite-dev" | "static" | "none";
const uiMode: UIMode = process.env.UI_DEV_MIDDLEWARE === "1"
  ? "vite-dev"
  : process.env.SERVE_UI === "1"
    ? "static"
    : "none";

const PORT = parseInt(process.env.PORT ?? "3100", 10);

async function main() {
  const app = express();

  // Trust only the Caddy sidecar (Docker bridge subnets) and loopback.
  // Never `true` or `1` — both let a client talking directly to port 3100
  // forge X-Forwarded-For. See commit 0970e24 for prior art.
  app.set("trust proxy", ["127.0.0.1/32", "::1/128", "172.16.0.0/12", "10.0.0.0/8"]);

  // Parse cookies — needed for CSRF double-submit on consent form.
  // Does not consume request body, so order relative to better-auth is fine.
  app.use(cookieParser());

  // Rate-limit OAuth endpoints (30 req/min per IP, independent budget per path
  // so an attacker can't starve /token by hammering /register).
  // Must be mounted BEFORE createMcpOAuthRouter() so it runs first.
  // Do NOT apply to /mcp — SSE connections are long-lived and would trip the limit.
  const makeOAuthLimiter = () =>
    rateLimit({ windowMs: 60_000, max: 30, standardHeaders: true, legacyHeaders: false });
  app.use("/authorize", makeOAuthLimiter());
  app.use("/token", makeOAuthLimiter());
  app.use("/register", makeOAuthLimiter());
  app.use("/revoke", makeOAuthLimiter());

  // Body parsing — note better-auth needs the raw stream, so mount auth BEFORE json()
  app.use("/api/auth", authRouter);
  app.use(createMcpOAuthRouter());

  // /mcp — StreamableHTTP transport with bearer auth and scoped JSON parser
  const mcpPublicUrl = getMcpPublicUrl();
  const tokenVerifier = createMcpTokenVerifier({ mcpPublicUrl });
  const resourceMetadataUrl = new URL(
    getOAuthProtectedResourceMetadataUrl(mcpPublicUrl)
  );
  const { router: mcpRouter, onShutdown: onMcpShutdown } = createMcpRouter();

  app.use(
    "/mcp",
    requireBearerAuth({ verifier: tokenVerifier, resourceMetadataUrl: resourceMetadataUrl.href }),
    express.json({ limit: "4mb" }),
    mcpRouter
  );

  app.use(express.json({ limit: "1mb" }));

  // Health check
  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, uiMode, timestamp: new Date().toISOString() });
  });

  // Tells the UI whether the first-run /setup flow should be shown.
  // Only reveal setup status to same-origin callers. Anonymous external
  // probes get a generic 200 so attackers can't tell if an admin exists.
  app.get("/api/setup-status", async (req, res) => {
    const origin = req.get("origin");
    const sameOrigin = typeof origin === "string" && origin === process.env.BETTER_AUTH_URL;
    if (!sameOrigin) {
      res.json({ ok: true });
      return;
    }
    res.json({ needsSetup: !(await isSignupLocked()) });
  });

  app.get("/api/mcp/config", (_req, res) => {
    res.json({
      mcpUrl: getMcpPublicUrl().href,
      oauth: true,
    });
  });

  // API routes
  app.use("/api/connections", connectionsRouter);
  app.use("/api/keys", keysRouter);
  app.use("/api/audit", auditRouter);

  // UI mode
  if (uiMode === "vite-dev") {
    const uiRoot = path.resolve(repoRoot, "ui");
    if (!existsSync(path.join(uiRoot, "vite.config.ts")) && !existsSync(path.join(uiRoot, "vite.config.js"))) {
      console.warn(`[ui] vite-dev mode requested but no vite.config found in ${uiRoot}. Starting API only.`);
    } else {
      const { createServer: createViteServer } = await import("vite");
      const vite = await createViteServer({
        root: uiRoot,
        server: { middlewareMode: true },
        appType: "spa",
      });
      app.use(vite.middlewares);
      console.log(`[ui] vite dev middleware mounted from ${uiRoot}`);
    }
  } else if (uiMode === "static") {
    const distDir = path.resolve(repoRoot, "ui/dist");
    if (!existsSync(distDir)) {
      console.warn(`[ui] static mode requested but ${distDir} does not exist. Starting API only.`);
    } else {
      app.use(express.static(distDir));
      app.get("/*splat", (_req, res) => {
        res.sendFile(path.join(distDir, "index.html"));
      });
      console.log(`[ui] serving static UI from ${distDir}`);
    }
  }

  const server = app.listen(PORT, () => {
    console.log(`[server] listening on http://localhost:${PORT} (uiMode=${uiMode})`);
  });

  async function shutdown() {
    console.log("[server] shutting down...");
    await onMcpShutdown();
    server.close(() => {
      console.log("[server] HTTP server closed");
      process.exit(0);
    });
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  startSyncScheduler();
}

main().catch((err) => {
  console.error("[server] fatal error:", err);
  process.exit(1);
});
