import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_LIMITS,
  runCodeMode,
  type CodeModeBridge,
  type CodeModeLimits,
} from "./runtime.js";
import { makeBridge, type ExecuteQueryOperation } from "./bridge.js";

function noopBridge(): CodeModeBridge {
  return {
    external_find: async () => [],
    external_aggregate: async () => [],
    external_count: async () => ({ count: 0 }),
    external_distinct: async () => [],
  };
}

test("runCodeMode returns a simple value", async () => {
  const result = await runCodeMode(`return 1 + 2;`, noopBridge());
  assert.equal(result.ok, true);
  assert.equal(result.result, 3);
  assert.equal(result.bridgeCalls.length, 0);
});

test("runCodeMode returns an object", async () => {
  const result = await runCodeMode(
    `return { hello: "world", n: 42, list: [1,2,3] };`,
    noopBridge()
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.result, { hello: "world", n: 42, list: [1, 2, 3] });
});

test("runCodeMode captures console.log and console.error", async () => {
  const result = await runCodeMode(
    `console.log("hello", { a: 1 }); console.error("oops"); return null;`,
    noopBridge()
  );
  assert.equal(result.ok, true);
  assert.equal(result.console.length, 2);
  assert.equal(result.console[0]?.level, "log");
  assert.match(result.console[0]?.message ?? "", /hello/);
  assert.equal(result.console[1]?.level, "error");
});

test("runCodeMode bridge call returns data and is recorded", async () => {
  const bridge: CodeModeBridge = {
    ...noopBridge(),
    external_find: async (args) => {
      assert.deepEqual(args, { collection: "users", limit: 2 });
      return [{ _id: "a", name: "Alice" }, { _id: "b", name: "Bob" }];
    },
  };

  const result = await runCodeMode(
    `
      const docs = await external_find({ collection: "users", limit: 2 });
      return docs.map(d => d.name);
    `,
    bridge
  );

  assert.equal(result.ok, true);
  assert.deepEqual(result.result, ["Alice", "Bob"]);
  assert.equal(result.bridgeCalls.length, 1);
  assert.equal(result.bridgeCalls[0]?.fn, "external_find");
  assert.equal(result.bridgeCalls[0]?.error, undefined);
});

test("runCodeMode propagates bridge rejection as a JS error", async () => {
  const bridge: CodeModeBridge = {
    ...noopBridge(),
    external_find: async () => {
      throw new Error("Collection \"secrets\" is not accessible.");
    },
  };

  const result = await runCodeMode(
    `
      try {
        await external_find({ collection: "secrets" });
        return "should not reach";
      } catch (e) {
        return "caught: " + (e && e.message ? e.message : String(e));
      }
    `,
    bridge
  );

  assert.equal(result.ok, true);
  assert.match(String(result.result), /caught: Collection "secrets" is not accessible/);
  assert.equal(result.bridgeCalls.length, 1);
  assert.match(result.bridgeCalls[0]?.error ?? "", /not accessible/);
});

test("runCodeMode runs Promise.all in parallel", async () => {
  let inflight = 0;
  let maxInflight = 0;
  const bridge: CodeModeBridge = {
    ...noopBridge(),
    external_count: async () => {
      inflight += 1;
      maxInflight = Math.max(maxInflight, inflight);
      await new Promise((r) => setTimeout(r, 10));
      inflight -= 1;
      return { count: 1 };
    },
  };

  const result = await runCodeMode(
    `
      const results = await Promise.all([
        external_count({ collection: "a" }),
        external_count({ collection: "b" }),
        external_count({ collection: "c" }),
      ]);
      return results.reduce((s, r) => s + r.count, 0);
    `,
    bridge
  );

  assert.equal(result.ok, true);
  assert.equal(result.result, 3);
  assert.equal(result.bridgeCalls.length, 3);
  assert.ok(maxInflight >= 2, `expected parallel execution, max inflight was ${maxInflight}`);
});

test("runCodeMode enforces max bridge call cap", async () => {
  const limits: CodeModeLimits = { ...DEFAULT_LIMITS, maxBridgeCalls: 3 };

  const result = await runCodeMode(
    `
      let n = 0;
      try {
        for (let i = 0; i < 10; i++) {
          await external_count({ collection: "a" });
          n++;
        }
      } catch (e) {
        return { n, err: e.message };
      }
      return { n };
    `,
    noopBridge(),
    limits
  );

  assert.equal(result.ok, true);
  const r = result.result as { n: number; err?: string };
  assert.equal(r.n, 3);
  assert.match(r.err ?? "", /Bridge call limit exceeded/);
});

test("runCodeMode rejects oversized result", async () => {
  const limits: CodeModeLimits = { ...DEFAULT_LIMITS, maxResultBytes: 100 };
  const result = await runCodeMode(
    `return "x".repeat(500);`,
    noopBridge(),
    limits
  );
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /Result too large/);
});

test("runCodeMode returns syntax error", async () => {
  const result = await runCodeMode(`this is not valid javascript ;;;`, noopBridge());
  assert.equal(result.ok, false);
  assert.ok(result.error && result.error.length > 0);
});

test("runCodeMode returns thrown error from user code", async () => {
  const result = await runCodeMode(
    `throw new Error("boom"); return 1;`,
    noopBridge()
  );
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /boom/);
});

test("runCodeMode interrupts an infinite loop via timeout", async () => {
  const limits: CodeModeLimits = { ...DEFAULT_LIMITS, timeoutMs: 200 };
  const start = Date.now();
  const result = await runCodeMode(`while (true) {}`, noopBridge(), limits);
  const elapsed = Date.now() - start;
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /Timeout|interrupted/i);
  assert.ok(elapsed < 5000, `expected fast timeout, got ${elapsed}ms`);
});

test("runCodeMode has no fs, no process, no require, no fetch", async () => {
  const result = await runCodeMode(
    `
      return {
        fs: typeof fs,
        process: typeof process,
        require: typeof require,
        fetch: typeof fetch,
        Buffer: typeof Buffer,
      };
    `,
    noopBridge()
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.result, {
    fs: "undefined",
    process: "undefined",
    require: "undefined",
    fetch: "undefined",
    Buffer: "undefined",
  });
});

test("makeBridge enforces bridge call shape and unwraps MCP results", async () => {
  const calls: { tool: string; parsed: unknown }[] = [];
  const fakeExecute: ExecuteQueryOperation = async (toolName, parsed) => {
    calls.push({ tool: toolName, parsed });
    return {
      content: [
        { type: "text" as const, text: JSON.stringify([{ _id: "1", n: 7 }]) },
      ],
    };
  };

  const bridge = makeBridge(fakeExecute);
  const docs = (await bridge.external_find({
    collection: "users",
    filter: { active: true },
    limit: 10,
  })) as { _id: string; n: number }[];

  assert.equal(docs.length, 1);
  assert.equal(docs[0]?.n, 7);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.tool, "code-mode:find");
  assert.deepEqual(calls[0]?.parsed, {
    collection: "users",
    operation: "find",
    filter: { active: true },
    limit: 10,
    connectionId: undefined,
  });
});

test("makeBridge forwards its connectionId so sandbox calls hit the chosen DB", async () => {
  const calls: { tool: string; parsed: unknown }[] = [];
  const fakeExecute: ExecuteQueryOperation = async (toolName, parsed) => {
    calls.push({ tool: toolName, parsed });
    return { content: [{ type: "text" as const, text: "[]" }] };
  };

  const bridge = makeBridge(fakeExecute, "conn_multi");
  await bridge.external_find({ collection: "users" });

  assert.equal(
    (calls[0]?.parsed as { connectionId?: string }).connectionId,
    "conn_multi"
  );
});

test("makeBridge throws when the underlying tool returns an error", async () => {
  const fakeExecute: ExecuteQueryOperation = async () => ({
    content: [
      { type: "text" as const, text: 'Collection "secrets" is not accessible.' },
    ],
    isError: true,
  });

  const bridge = makeBridge(fakeExecute);
  await assert.rejects(
    () => bridge.external_find({ collection: "secrets" }),
    /not accessible/
  );
});

test("makeBridge rejects malformed args", async () => {
  const fakeExecute: ExecuteQueryOperation = async () => ({
    content: [{ type: "text" as const, text: "[]" }],
  });
  const bridge = makeBridge(fakeExecute);

  await assert.rejects(() => bridge.external_find("not-an-object"), /expected an object/);
  await assert.rejects(
    () => bridge.external_find({ collection: 42 }),
    /must be a non-empty string/
  );
  await assert.rejects(
    () => bridge.external_aggregate({ collection: "x", pipeline: "not-array" }),
    /pipeline must be an array/
  );
});
