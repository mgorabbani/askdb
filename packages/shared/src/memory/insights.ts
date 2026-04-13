import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { agentInsights } from "../db/schema.js";

export type AgentInsightCategory = "gotcha" | "pattern" | "tip";

interface SaveAgentInsightInput {
  apiKeyId: string;
  category: AgentInsightCategory;
  collection: string | null;
  connectionId: string;
  exampleQuery: string | null;
  insight: string;
  now?: Date;
}

interface SaveAgentInsightResult {
  id: string;
  status: "created" | "updated";
  useCount: number;
}

interface AgentInsightsDb {
  insert(table: typeof agentInsights): {
    values(values: typeof agentInsights.$inferInsert): {
      run(): unknown;
    };
  };
  select(): {
    from(table: typeof agentInsights): {
      where(condition: unknown): {
        get(): typeof agentInsights.$inferSelect | undefined;
      };
    };
  };
  update(table: typeof agentInsights): {
    set(values: Partial<typeof agentInsights.$inferInsert>): {
      where(condition: unknown): {
        run(): unknown;
      };
    };
  };
}

function findExistingAgentInsight(
  database: AgentInsightsDb,
  connectionId: string,
  collection: string | null,
  insight: string
) {
  const condition = collection
    ? and(
        eq(agentInsights.connectionId, connectionId),
        eq(agentInsights.collection, collection),
        eq(agentInsights.insight, insight)
      )
    : and(
        eq(agentInsights.connectionId, connectionId),
        isNull(agentInsights.collection),
        eq(agentInsights.insight, insight)
      );

  return database.select().from(agentInsights).where(condition).get();
}

export function saveAgentInsight(
  database: AgentInsightsDb,
  input: SaveAgentInsightInput
): SaveAgentInsightResult {
  const now = input.now ?? new Date();
  const existingInsight = findExistingAgentInsight(
    database,
    input.connectionId,
    input.collection,
    input.insight
  );

  if (existingInsight) {
    database
      .update(agentInsights)
      .set({
        apiKeyId: input.apiKeyId,
        category: input.category,
        exampleQuery: input.exampleQuery ?? existingInsight.exampleQuery,
        lastConfirmedAt: now,
        useCount: existingInsight.useCount + 1,
      })
      .where(eq(agentInsights.id, existingInsight.id))
      .run();

    return {
      id: existingInsight.id,
      status: "updated",
      useCount: existingInsight.useCount + 1,
    };
  }

  const id = randomUUID();
  database
    .insert(agentInsights)
    .values({
      id,
      apiKeyId: input.apiKeyId,
      category: input.category,
      collection: input.collection,
      connectionId: input.connectionId,
      createdAt: now,
      exampleQuery: input.exampleQuery,
      insight: input.insight,
      lastConfirmedAt: now,
      useCount: 1,
    })
    .run();

  return {
    id,
    status: "created",
    useCount: 1,
  };
}
