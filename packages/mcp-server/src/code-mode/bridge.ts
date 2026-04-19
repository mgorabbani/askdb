// Code Mode bridge — turns the existing executeQueryOperation into the
// four external_* host functions exposed inside the QuickJS sandbox.
//
// Every call from the sandbox routes through executeQueryOperation, which
// already enforces every askdb security invariant (hidden tables, hidden
// fields, allowlisted operations, forbidden aggregation stages, audit log,
// query-pattern recording). The sandbox cannot bypass it because that
// function is the only path the bridge exposes.

import type { CodeModeBridge } from "./runtime.js";

interface ParsedQuery {
  collection: string;
  operation: string;
  filter?: Record<string, unknown>;
  pipeline?: Record<string, unknown>[];
  field?: string;
  limit?: number;
  connectionId?: string;
}

interface ToolTextContent {
  type: "text";
  text: string;
}

interface ToolResult {
  content: ToolTextContent[];
  isError?: boolean;
}

export type ExecuteQueryOperation = (
  toolName: string,
  parsed: ParsedQuery,
  queryStr?: string
) => Promise<ToolResult>;

interface BaseArgs {
  collection?: unknown;
  filter?: unknown;
  pipeline?: unknown;
  field?: unknown;
  limit?: unknown;
}

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label}: expected an object argument`);
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label}: "${label.split(":")[1]?.trim()}" must be a non-empty string`);
  }
  return value;
}

function asOptionalNumber(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label}: limit must be a finite number`);
  }
  return value;
}

function asOptionalRecord(
  value: unknown,
  label: string
): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label}: filter must be an object`);
  }
  return value as Record<string, unknown>;
}

function asPipeline(value: unknown, label: string): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label}: pipeline must be an array`);
  }
  return value.map((stage, idx) => {
    if (stage === null || typeof stage !== "object" || Array.isArray(stage)) {
      throw new Error(`${label}: pipeline[${idx}] must be an object`);
    }
    return stage as Record<string, unknown>;
  });
}

function unwrap(result: ToolResult): unknown {
  const text = result.content[0]?.text ?? "";
  if (result.isError) {
    throw new Error(text || "Bridge call failed");
  }
  if (text === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Build the four external_* functions exposed inside the sandbox. The
 * execute-typescript tool resolves a target database before entering the
 * sandbox and passes its connectionId here so every bridge call routes to the
 * same database without the guest needing to thread it through.
 */
export function makeBridge(
  execute: ExecuteQueryOperation,
  connectionId?: string
): CodeModeBridge {
  return {
    external_find: async (rawArgs) => {
      const args = asObject(rawArgs, "external_find") as BaseArgs;
      const parsed: ParsedQuery = {
        collection: asString(args.collection, "external_find: collection"),
        operation: "find",
        filter: asOptionalRecord(args.filter, "external_find"),
        limit: asOptionalNumber(args.limit, "external_find"),
        connectionId,
      };
      return unwrap(await execute("code-mode:find", parsed));
    },

    external_aggregate: async (rawArgs) => {
      const args = asObject(rawArgs, "external_aggregate") as BaseArgs;
      const parsed: ParsedQuery = {
        collection: asString(args.collection, "external_aggregate: collection"),
        operation: "aggregate",
        pipeline: asPipeline(args.pipeline, "external_aggregate"),
        limit: asOptionalNumber(args.limit, "external_aggregate"),
        connectionId,
      };
      return unwrap(await execute("code-mode:aggregate", parsed));
    },

    external_count: async (rawArgs) => {
      const args = asObject(rawArgs, "external_count") as BaseArgs;
      const parsed: ParsedQuery = {
        collection: asString(args.collection, "external_count: collection"),
        operation: "count",
        filter: asOptionalRecord(args.filter, "external_count"),
        connectionId,
      };
      return unwrap(await execute("code-mode:count", parsed));
    },

    external_distinct: async (rawArgs) => {
      const args = asObject(rawArgs, "external_distinct") as BaseArgs;
      const parsed: ParsedQuery = {
        collection: asString(args.collection, "external_distinct: collection"),
        operation: "distinct",
        field: asString(args.field, "external_distinct: field"),
        filter: asOptionalRecord(args.filter, "external_distinct"),
        limit: asOptionalNumber(args.limit, "external_distinct"),
        connectionId,
      };
      return unwrap(await execute("code-mode:distinct", parsed));
    },
  };
}
