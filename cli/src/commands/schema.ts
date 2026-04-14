import { Command } from "commander";
import chalk from "chalk";
import { requireConfig } from "../config.js";
import { AskdbClient } from "../api.js";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "../config.js";

export const schemaCommand = new Command("schema")
  .description("Get the full agent-ready schema summary")
  .option("--save", "Save to ~/.askdb/schema.md")
  .option("--json", "Output as JSON instead of markdown")
  .action(async (opts: { save?: boolean; json?: boolean }) => {
    const config = requireConfig();
    const client = new AskdbClient(config);

    if (opts.json) {
      const schema = await client.getSchema();
      const output = JSON.stringify(schema, null, 2);
      if (opts.save) {
        const path = join(getConfigDir(), "schema.json");
        writeFileSync(path, output);
        console.log(chalk.green("✓"), "Saved to", path);
      } else {
        console.log(output);
      }
      return;
    }

    const markdown = await client.getSchemaSummary();

    if (opts.save) {
      const path = join(getConfigDir(), "schema.md");
      writeFileSync(path, markdown);
      console.log(chalk.green("✓"), "Saved to", path);
    } else {
      console.log(markdown);
    }
  });
