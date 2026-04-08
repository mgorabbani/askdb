#!/usr/bin/env node

import { Command } from "commander";
import { authCommand, logoutCommand, statusCommand } from "./commands/auth.js";
import { tablesCommand, describeCommand } from "./commands/tables.js";
import { schemaCommand } from "./commands/schema.js";
import { connectionsCommand, useCommand } from "./commands/connections.js";
import { memoryCommand } from "./commands/memory.js";

const program = new Command()
  .name("askdb")
  .description("Ask your database anything. CLI for askdb.")
  .version("0.1.0");

// Auth
program.addCommand(authCommand);
program.addCommand(logoutCommand);
program.addCommand(statusCommand);

// Connections
program.addCommand(connectionsCommand);
program.addCommand(useCommand);

// Schema & data
program.addCommand(tablesCommand);
program.addCommand(describeCommand);
program.addCommand(schemaCommand);

// Memory
program.addCommand(memoryCommand);

program.parse();
