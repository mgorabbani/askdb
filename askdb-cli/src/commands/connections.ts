import { Command } from "commander";
import chalk from "chalk";
import { requireConfig, saveConfig, loadConfig } from "../config.js";
import { AskdbClient } from "../api.js";

export const connectionsCommand = new Command("connections")
  .description("List and select database connections")
  .action(async () => {
    const config = requireConfig();
    const client = new AskdbClient(config);

    const conns = await client.listConnections();
    if (conns.length === 0) {
      console.log(chalk.yellow("No connections found."), "Add one via the dashboard.");
      return;
    }

    console.log(chalk.bold("\nConnections:\n"));
    for (const c of conns) {
      const active = config.connectionId === c.id ? chalk.green(" ← active") : "";
      const status =
        c.syncStatus === "COMPLETED"
          ? chalk.green("synced")
          : c.syncStatus === "SYNCING"
            ? chalk.yellow("syncing")
            : chalk.dim(c.syncStatus.toLowerCase());

      console.log(`  ${chalk.cyan(c.name)}  ${chalk.dim(c.id.slice(0, 8))}  ${status}${active}`);
    }
    console.log();
    console.log(chalk.dim("  Use `askdb use <connection-id>` to select a connection."));
    console.log();
  });

export const useCommand = new Command("use")
  .description("Select a connection to use")
  .argument("<connection-id>", "Connection ID (or prefix)")
  .action(async (connectionId: string) => {
    const config = requireConfig();
    const client = new AskdbClient(config);

    const conns = await client.listConnections();
    const match = conns.find(
      (c) => c.id === connectionId || c.id.startsWith(connectionId)
    );

    if (!match) {
      console.error(chalk.red("✗"), `Connection "${connectionId}" not found.`);
      process.exit(1);
      return;
    }

    saveConfig({ ...config, connectionId: match.id });
    console.log(chalk.green("✓"), `Using connection "${match.name}" (${match.id.slice(0, 8)})`);
  });
