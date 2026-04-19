export interface ServerControls {
  disabledItems: Set<string>;
  readOnly: boolean;
}

export interface InitializeInsight {
  category: string;
  collection: string | null;
  insight: string;
}

export interface DatabaseSummary {
  id: string;
  name: string;
  description: string | null;
  databaseName: string;
}

export interface ConfigResourcePayloadInput {
  connectionId: string;
  disabledItems: Iterable<string>;
  readOnly: boolean;
  resources: string[];
  toolNames: string[];
}

export interface DebugState {
  lastError: string | null;
  lastErrorAt: string | null;
  lastSuccessAt: string | null;
  lastTool: string | null;
}

export interface ToolPolicy {
  category: "askdb" | "mongodb";
  operation: "connect" | "metadata" | "read" | "update";
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return /^(1|true|yes|on)$/i.test(value.trim());
}

function parseList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(/[,\s]+/)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

export function readServerControls(
  env: NodeJS.ProcessEnv = process.env
): ServerControls {
  const disabledItems = new Set([
    ...parseList(env.ASKDB_MCP_DISABLED_TOOLS),
    ...parseList(env.MDB_MCP_DISABLED_TOOLS),
  ]);

  const readOnly = parseBoolean(
    env.ASKDB_MCP_READ_ONLY ?? env.MDB_MCP_READ_ONLY,
    true
  );

  return { disabledItems, readOnly };
}

export function isToolEnabled(
  controls: ServerControls,
  toolName: string,
  policy: ToolPolicy
): boolean {
  const normalizedToolName = toolName.toLowerCase();
  if (controls.disabledItems.has(normalizedToolName)) return false;
  if (controls.disabledItems.has(policy.category)) return false;
  if (controls.disabledItems.has(policy.operation)) return false;
  if (
    controls.readOnly &&
    policy.category === "mongodb" &&
    !["connect", "metadata", "read"].includes(policy.operation)
  ) {
    return false;
  }
  return true;
}

export function buildInitializeInstructions(
  insights: InitializeInsight[],
  databases: DatabaseSummary[] = []
): string {
  const lines = [
    "askdb follows MongoDB MCP patterns with askdb-specific safety and memory extensions.",
  ];

  if (databases.length > 1) {
    lines.push(
      `This user has ${databases.length} databases connected. Start by reading \`databases://overview\` or calling \`list-databases\` to see what each one is for, then pass \`connectionId\` to the other tools to target a specific database.`
    );
  } else if (databases.length === 1) {
    lines.push(
      "This user has one database connected; `connectionId` can be omitted on every tool call."
    );
  }

  lines.push(
    "Preferred workflow: read `databases://overview` (and `schema://overview` for a single DB) or call `list-databases` / `list-collections`, then call `collection-schema` for an unfamiliar collection, then use `find`, `aggregate`, `count`, or `distinct`.",
    "Prefer the specific query tools over the low-level `query` compatibility tool.",
    "All collection and field visibility rules are enforced server-side. Hidden fields never appear in query results or schema outputs.",
    "Use `sample-documents` only when you need raw examples after reviewing schema metadata.",
    "Use `save-insight` only after a successful session to store durable gotchas, patterns, or tips for future agents."
  );

  const gotchas = insights
    .filter((insight) => insight.category === "gotcha")
    .slice(0, 3);

  if (gotchas.length > 0) {
    lines.push(
      "Known gotchas: " +
        gotchas
          .map((insight) =>
            insight.collection
              ? `${insight.collection}: ${insight.insight}`
              : insight.insight
          )
          .join(" | ")
    );
  }

  return lines.join("\n");
}

/**
 * Plain-language brief the agent reads first. Each database gets a short entry
 * with its purpose so the agent can decide where to look before querying.
 */
export function buildDatabasesOverviewMarkdown(
  databases: DatabaseSummary[]
): string {
  if (databases.length === 0) {
    return [
      "# Databases",
      "",
      "No databases are connected yet. Ask the user to connect one in the askdb dashboard before running queries.",
    ].join("\n");
  }

  const header = [
    "# Databases",
    "",
    databases.length === 1
      ? "This user has one database connected."
      : `This user has ${databases.length} databases connected. Pick the one whose description best matches the question, then pass its \`connectionId\` to any tool call. You can also query across multiple databases by running tools once per \`connectionId\`.`,
    "",
  ];

  const entries = databases.map((db, index) => {
    const lines: string[] = [];
    lines.push(`## ${index + 1}. ${db.name}`);
    lines.push("");
    lines.push(
      `- **connectionId**: \`${db.id}\` (pass this to any query tool to target this database)`
    );
    lines.push(`- **Database name**: \`${db.databaseName}\``);
    lines.push(
      `- **What it contains**: ${
        db.description?.trim() ||
        "_No description yet. Ask the user to add one in the askdb dashboard so agents can tell this database apart._"
      }`
    );
    return lines.join("\n");
  });

  return [...header, entries.join("\n\n")].join("\n");
}

export function buildConfigResourcePayload(
  input: ConfigResourcePayloadInput
) {
  return {
    server: "askdb",
    mode: {
      readOnly: input.readOnly,
      hiddenFieldsEnforced: true,
      hiddenCollectionsEnforced: true,
      auditLoggingEnabled: true,
      tenantScopedConnection: true,
    },
    connection: {
      connectionId: input.connectionId,
    },
    controls: {
      disabledItems: [...input.disabledItems].sort(),
    },
    resources: input.resources,
    tools: input.toolNames,
  };
}

export function buildInsightsResourceMarkdown(insights: InitializeInsight[]): string {
  const lines = ["# Saved Insights", ""];

  if (insights.length === 0) {
    lines.push("No saved insights yet.");
    return lines.join("\n");
  }

  const groups: Record<string, InitializeInsight[]> = {};
  for (const insight of insights) {
    const key = insight.category;
    groups[key] ??= [];
    groups[key].push(insight);
  }

  for (const [category, items] of Object.entries(groups)) {
    lines.push(`## ${category}`, "");
    for (const insight of items) {
      lines.push(
        `- ${
          insight.collection ? `${insight.collection}: ${insight.insight}` : insight.insight
        }`
      );
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

export function buildDebugResourcePayload(
  connectionId: string,
  debugState: DebugState
) {
  return {
    connectionId,
    debug: debugState,
  };
}
