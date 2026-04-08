import { Command } from "commander";
import chalk from "chalk";
import { requireConfig } from "../config.js";
import { AskdbClient } from "../api.js";

export const memoryCommand = new Command("memory")
  .description("View and manage query pattern memories")
  .action(async () => {
    const config = requireConfig();
    const client = new AskdbClient(config);

    const memories = await client.getMemories();
    if (memories.length === 0) {
      console.log(chalk.dim("No query patterns learned yet. Patterns are recorded as agents use the database."));
      return;
    }

    console.log(chalk.bold("\nLearned Query Patterns:\n"));
    for (const m of memories) {
      console.log(`  ${chalk.cyan(m.pattern)}  ${chalk.dim(`(${m.frequency}x)`)}`);
      console.log(`    ${m.description}`);
      if (m.exampleQuery) {
        console.log(`    ${chalk.dim(m.exampleQuery)}`);
      }
      console.log();
    }
  });

memoryCommand
  .command("add")
  .description("Manually add a query pattern")
  .requiredOption("-p, --pattern <pattern>", "Pattern key")
  .requiredOption("-d, --description <desc>", "Human-readable description")
  .option("-q, --query <query>", "Example query JSON")
  .option("-c, --collection <name>", "Primary collection")
  .action(
    async (opts: {
      pattern: string;
      description: string;
      query?: string;
      collection?: string;
    }) => {
      const config = requireConfig();
      const client = new AskdbClient(config);

      await client.addMemory({
        pattern: opts.pattern,
        description: opts.description,
        exampleQuery: opts.query,
        collection: opts.collection,
      });

      console.log(chalk.green("✓"), "Memory added:", opts.pattern);
    }
  );

memoryCommand
  .command("remove")
  .description("Remove a query pattern memory")
  .argument("<memory-id>", "Memory ID to remove")
  .action(async (memoryId: string) => {
    const config = requireConfig();
    const client = new AskdbClient(config);

    await client.deleteMemory(memoryId);
    console.log(chalk.green("✓"), "Memory removed");
  });
