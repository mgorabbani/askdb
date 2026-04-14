import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { config as loadEnv } from "dotenv";

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

type UIMode = "vite-dev" | "static" | "none";
const uiMode: UIMode = process.env.UI_DEV_MIDDLEWARE === "1"
  ? "vite-dev"
  : process.env.SERVE_UI === "1"
    ? "static"
    : "none";

const PORT = parseInt(process.env.PORT ?? "3100", 10);

async function main() {
  const app = express();

  // Body parsing — note better-auth needs the raw stream, so mount auth BEFORE json()
  app.use("/api/auth", authRouter);
  app.use(createMcpOAuthRouter());

  app.use(express.json({ limit: "1mb" }));

  // Health check
  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, uiMode, timestamp: new Date().toISOString() });
  });

  // Tells the UI whether the first-run /setup flow should be shown.
  app.get("/api/setup-status", async (_req, res) => {
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

  app.listen(PORT, () => {
    console.log(`[server] listening on http://localhost:${PORT} (uiMode=${uiMode})`);
  });

  startSyncScheduler();
}

main().catch((err) => {
  console.error("[server] fatal error:", err);
  process.exit(1);
});
