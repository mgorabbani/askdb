// Code Mode MCP tool registration.

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { makeBridge, type ExecuteQueryOperation } from "./bridge.js";
import {
  DEFAULT_LIMITS,
  runCodeMode,
  type CodeModeLimits,
} from "./runtime.js";

export const TYPESCRIPT_TOOL_DESCRIPTION = `Execute a TypeScript program inside a sandboxed QuickJS-WASM isolate. Use this when you need to compose multiple Mongo queries, batch in parallel with Promise.all, do math/aggregations correctly in JavaScript, or filter and reduce results that one aggregation pipeline cannot express cleanly.

The program runs with no network, no filesystem, no process, no require/import, no globals beyond what is listed below. The only callables that exist inside the sandbox are:

  declare function external_find(args: {
    collection: string;
    filter?: Record<string, unknown>;
    limit?: number;            // max 500
  }): Promise<Record<string, unknown>[]>;

  declare function external_aggregate(args: {
    collection: string;
    pipeline: Record<string, unknown>[];
    limit?: number;            // max 500
  }): Promise<Record<string, unknown>[]>;

  declare function external_count(args: {
    collection: string;
    filter?: Record<string, unknown>;
  }): Promise<{ count: number }>;

  declare function external_distinct(args: {
    collection: string;
    field: string;
    filter?: Record<string, unknown>;
    limit?: number;            // max 500
  }): Promise<unknown[]>;

  console.log(...args), console.info, console.warn, console.error
    // captured and returned alongside your result

Write your program as a sequence of statements. Use \`return value\` to emit a result. Top-level await is supported.

All collection-visibility, hidden-field stripping, and forbidden-stage checks fire automatically inside the bridge — same enforcement as the direct find/aggregate/count/distinct tools. Hidden collections throw "not accessible". Forbidden stages ($merge, $out, $collStats, $currentOp, $listSessions) throw. $lookup into a hidden collection throws.

Limits per execution:
- 30s wall-clock timeout
- 128MB memory
- Max 50 external_* calls
- Max 256KB serialized result

Example — average rating per top-5 product:

  const top = await external_find({
    collection: "products",
    filter: { active: true },
    limit: 5,
  });

  const ratings = await Promise.all(
    top.map((p) =>
      external_find({ collection: "ratings", filter: { productId: p._id } })
    )
  );

  return top.map((product, i) => {
    const scores = ratings[i].map((r) => r.score);
    const avg = scores.reduce((s, x) => s + x, 0) / scores.length;
    return { name: product.name, avgRating: Math.round(avg * 100) / 100 };
  });`;

export interface ExecuteTypescriptHooks {
  writeAuditLog: (
    action: string,
    connectionId: string,
    apiKeyId: string,
    opts: {
      query?: string;
      collection?: string;
      executionMs?: number;
      docCount?: number;
    }
  ) => void;
  rememberSuccess: (toolName: string) => void;
  rememberError: (toolName: string, message: string) => void;
}

export interface ResolvedConnection {
  id: string;
  name: string;
}

export type ConnectionResolver = (
  connectionId?: string
) =>
  | { ok: true; connection: ResolvedConnection }
  | { ok: false; error: string };

export interface ExecuteTypescriptOptions {
  server: McpServer;
  apiKeyId: string;
  resolveConnection: ConnectionResolver;
  hasMultipleConnections: boolean;
  executeQueryOperation: ExecuteQueryOperation;
  hooks: ExecuteTypescriptHooks;
  limits?: CodeModeLimits;
}

export function registerExecuteTypescriptTool({
  server,
  apiKeyId,
  resolveConnection,
  hasMultipleConnections,
  executeQueryOperation,
  hooks,
  limits = DEFAULT_LIMITS,
}: ExecuteTypescriptOptions): void {
  server.registerTool(
    "execute-typescript",
    {
      title: "Execute TypeScript (Code Mode)",
      description:
        TYPESCRIPT_TOOL_DESCRIPTION +
        (hasMultipleConnections
          ? "\n\nThis user has multiple databases connected. Pass `connectionId` to scope every external_* call inside the sandbox to the chosen database. Run the tool once per database if you need cross-DB composition."
          : ""),
      annotations: { readOnlyHint: true },
      inputSchema: {
        source: z
          .string()
          .min(1)
          .describe(
            "TypeScript source. Use top-level await and `return value` to emit a result."
          ),
        connectionId: z
          .string()
          .optional()
          .describe(
            "Which database the external_* calls target. Omit when only one database is connected."
          ),
      },
    },
    async ({ source, connectionId }) => {
      const resolved = resolveConnection(connectionId);
      if (!resolved.ok) {
        hooks.rememberError("execute-typescript", resolved.error);
        return {
          content: [{ type: "text" as const, text: resolved.error }],
          isError: true,
        };
      }
      const conn = resolved.connection;
      const bridge = makeBridge(executeQueryOperation, conn.id);

      const result = await runCodeMode(source, bridge, limits);

      hooks.writeAuditLog("execute-typescript", conn.id, apiKeyId, {
        query: source,
        executionMs: result.durationMs,
        docCount: result.bridgeCalls.length,
      });

      if (!result.ok) {
        hooks.rememberError(
          "execute-typescript",
          result.error ?? "Unknown error"
        );
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  ok: false,
                  error: result.error,
                  console: result.console,
                  bridgeCalls: result.bridgeCalls.map((c) => ({
                    fn: c.fn,
                    durationMs: c.durationMs,
                    error: c.error,
                  })),
                  durationMs: result.durationMs,
                },
                null,
                2
              ),
            },
          ],
          isError: true,
        };
      }

      hooks.rememberSuccess("execute-typescript");
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                ok: true,
                result: result.result,
                console: result.console,
                bridgeCalls: result.bridgeCalls.length,
                durationMs: result.durationMs,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );
}
