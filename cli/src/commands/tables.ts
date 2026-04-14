import { Command } from "commander";
import chalk from "chalk";
import { requireConfig } from "../config.js";
import { AskdbClient } from "../api.js";

export const tablesCommand = new Command("tables")
  .description("List all visible collections")
  .action(async () => {
    const config = requireConfig();
    const client = new AskdbClient(config);

    const tables = await client.listTables();
    if (tables.length === 0) {
      console.log(chalk.yellow("No visible collections found."));
      return;
    }

    console.log(chalk.bold("\nCollections:\n"));
    for (const t of tables) {
      console.log(`  ${chalk.cyan(t.name)}  ${chalk.dim(`${t.docCount.toLocaleString()} docs`)}`);
    }
    console.log();
  });

export const describeCommand = new Command("describe")
  .description("Describe fields in a collection")
  .argument("<collection>", "Collection name")
  .action(async (collection: string) => {
    const config = requireConfig();
    const client = new AskdbClient(config);

    const fields = await client.describeTable(collection);
    if (fields.length === 0) {
      console.log(chalk.yellow("No visible fields."));
      return;
    }

    console.log(chalk.bold(`\n${collection} fields:\n`));

    // Calculate column widths
    const nameWidth = Math.max(5, ...fields.map((f) => f.name.length));
    const typeWidth = Math.max(4, ...fields.map((f) => f.type.length));

    console.log(
      `  ${chalk.dim("Field".padEnd(nameWidth))}  ${chalk.dim("Type".padEnd(typeWidth))}  ${chalk.dim("Sample")}`
    );
    console.log(
      `  ${"─".repeat(nameWidth)}  ${"─".repeat(typeWidth)}  ${"─".repeat(30)}`
    );

    for (const f of fields) {
      const sample = f.sampleValue
        ? f.sampleValue.length > 40
          ? f.sampleValue.slice(0, 40) + "…"
          : f.sampleValue
        : chalk.dim("—");
      console.log(
        `  ${f.name.padEnd(nameWidth)}  ${chalk.yellow(f.type.padEnd(typeWidth))}  ${sample}`
      );
    }
    console.log();
  });
