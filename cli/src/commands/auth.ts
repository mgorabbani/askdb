import { Command } from "commander";
import chalk from "chalk";
import open from "open";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { saveConfig, loadConfig } from "../config.js";

export const authCommand = new Command("auth")
  .description("Authenticate with your askdb instance")
  .argument("<server-url>", "URL of your askdb instance (e.g. http://localhost:3000)")
  .option("--key <api-key>", "API key (skip browser auth)")
  .action(async (serverUrl: string, opts: { key?: string }) => {
    const url = serverUrl.replace(/\/$/, "");

    if (opts.key) {
      // Direct key mode
      saveConfig({ serverUrl: url, apiKey: opts.key });
      console.log(chalk.green("✓"), "Authenticated with", url);
      return;
    }

    // Browser-based auth flow:
    // 1. Start a tiny local server to receive the callback
    // 2. Open browser to askdb's auth page with callback URL
    // 3. User logs in, askdb redirects back with an API key
    console.log(chalk.blue("→"), "Opening browser for authentication...");

    const apiKey = await new Promise<string>((resolve, reject) => {
      const server = createServer((req: IncomingMessage, res: ServerResponse) => {
        const reqUrl = new URL(req.url ?? "/", "http://localhost");
        const key = reqUrl.searchParams.get("key");

        if (key) {
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(`
            <html><body style="font-family: system-ui; text-align: center; padding: 60px;">
              <h2>✓ Authenticated!</h2>
              <p>You can close this tab and return to the terminal.</p>
            </body></html>
          `);
          server.close();
          resolve(key);
        } else {
          res.writeHead(400, { "Content-Type": "text/plain" });
          res.end("Missing key parameter");
        }
      });

      server.listen(0, () => {
        const port = (server.address() as { port: number }).port;
        const callbackUrl = `http://localhost:${port}/callback`;
        const authUrl = `${url}/dashboard/keys?cli_callback=${encodeURIComponent(callbackUrl)}`;
        open(authUrl);
        console.log(
          chalk.dim(`  Waiting for auth callback on port ${port}...`)
        );
        console.log(
          chalk.dim(`  If browser didn't open, visit: ${authUrl}`)
        );
      });

      // Timeout after 2 minutes
      setTimeout(() => {
        server.close();
        reject(new Error("Authentication timed out"));
      }, 120_000);
    });

    saveConfig({ serverUrl: url, apiKey });
    console.log(chalk.green("✓"), "Authenticated with", url);
  });

export const logoutCommand = new Command("logout")
  .description("Remove stored credentials")
  .action(() => {
    const config = loadConfig();
    if (!config) {
      console.log("Not logged in.");
      return;
    }
    saveConfig({ serverUrl: "", apiKey: "" });
    console.log(chalk.green("✓"), "Logged out");
  });

export const statusCommand = new Command("status")
  .description("Show current auth status")
  .action(() => {
    const config = loadConfig();
    if (!config || !config.apiKey) {
      console.log(chalk.yellow("Not authenticated."), "Run `askdb auth <url>` to connect.");
      return;
    }
    console.log(chalk.green("✓"), "Connected to", config.serverUrl);
    if (config.connectionId) {
      console.log("  Connection:", config.connectionId);
    }
  });
