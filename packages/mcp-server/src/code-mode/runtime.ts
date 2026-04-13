// Code Mode runtime — runs untrusted TypeScript-ish source inside a
// QuickJS-WASM isolate. The isolate has no network, no filesystem, no
// process, no require/import. The only callables it sees are the
// external_* bridge functions and a captured console.

import {
  newAsyncContext,
  type QuickJSAsyncContext,
  type QuickJSHandle,
} from "quickjs-emscripten";

export interface CodeModeLimits {
  timeoutMs: number;
  memoryBytes: number;
  maxBridgeCalls: number;
  maxResultBytes: number;
}

export const DEFAULT_LIMITS: CodeModeLimits = {
  timeoutMs: 30_000,
  memoryBytes: 128 * 1024 * 1024,
  maxBridgeCalls: 50,
  maxResultBytes: 256 * 1024,
};

export interface ConsoleEntry {
  level: "log" | "info" | "warn" | "error";
  message: string;
}

export interface BridgeCallRecord {
  fn: string;
  argsJson: string;
  durationMs: number;
  error?: string;
}

export interface CodeModeBridge {
  external_find: (args: unknown) => Promise<unknown>;
  external_aggregate: (args: unknown) => Promise<unknown>;
  external_count: (args: unknown) => Promise<unknown>;
  external_distinct: (args: unknown) => Promise<unknown>;
}

export interface CodeModeResult {
  ok: boolean;
  result?: unknown;
  error?: string;
  console: ConsoleEntry[];
  bridgeCalls: BridgeCallRecord[];
  durationMs: number;
}

/** Convert a host JS value into a fresh guest handle. Caller owns the result. */
function jsToHandle(ctx: QuickJSAsyncContext, value: unknown): QuickJSHandle {
  if (value === null) return ctx.null;
  if (value === undefined) return ctx.undefined;
  if (typeof value === "boolean") return value ? ctx.true : ctx.false;
  if (typeof value === "number") return ctx.newNumber(value);
  if (typeof value === "string") return ctx.newString(value);
  if (typeof value === "bigint") return ctx.newNumber(Number(value));
  if (value instanceof Date) return ctx.newString(value.toISOString());
  if (Array.isArray(value)) {
    const arr = ctx.newArray();
    value.forEach((item, idx) => {
      const h = jsToHandle(ctx, item);
      ctx.setProp(arr, idx, h);
      h.dispose();
    });
    return arr;
  }
  if (typeof value === "object") {
    const maybeToJSON = (value as { toJSON?: () => unknown }).toJSON;
    if (typeof maybeToJSON === "function") {
      try {
        return jsToHandle(ctx, maybeToJSON.call(value));
      } catch {
        return ctx.newString(String(value));
      }
    }
    const obj = ctx.newObject();
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const h = jsToHandle(ctx, v);
      ctx.setProp(obj, k, h);
      h.dispose();
    }
    return obj;
  }
  return ctx.undefined;
}

function extractMessage(dumped: unknown): string {
  if (dumped && typeof dumped === "object" && "message" in dumped) {
    return String((dumped as { message: unknown }).message);
  }
  return String(dumped);
}

/** Run untrusted source inside a fresh QuickJS isolate. */
export async function runCodeMode(
  source: string,
  bridge: CodeModeBridge,
  limits: CodeModeLimits = DEFAULT_LIMITS
): Promise<CodeModeResult> {
  const consoleEntries: ConsoleEntry[] = [];
  const bridgeCalls: BridgeCallRecord[] = [];
  const startedAt = Date.now();

  const ctx = await newAsyncContext();
  ctx.runtime.setMemoryLimit(limits.memoryBytes);
  ctx.runtime.setMaxStackSize(1 * 1024 * 1024);

  const deadline = startedAt + limits.timeoutMs;
  let timedOut = false;
  ctx.runtime.setInterruptHandler(() => {
    if (Date.now() > deadline) {
      timedOut = true;
      return true;
    }
    return false;
  });

  const drainJobs = () => {
    try {
      ctx.runtime.executePendingJobs();
    } catch {
      // Drain failures show up on the next eval/dump path.
    }
  };

  try {
    // ── console.* capture ──
    const consoleObj = ctx.newObject();
    for (const level of ["log", "info", "warn", "error"] as const) {
      const fn = ctx.newFunction(level, (...argHandles) => {
        const parts = argHandles.map((h) => {
          try {
            const v = ctx.dump(h);
            return typeof v === "string" ? v : JSON.stringify(v);
          } catch {
            return "[unserializable]";
          }
        });
        consoleEntries.push({ level, message: parts.join(" ") });
        return ctx.undefined;
      });
      ctx.setProp(consoleObj, level, fn);
      fn.dispose();
    }
    ctx.setProp(ctx.global, "console", consoleObj);
    consoleObj.dispose();

    // ── external_* bridge ──
    let bridgeCallCount = 0;
    const bind = (
      name: keyof CodeModeBridge,
      impl: (args: unknown) => Promise<unknown>
    ) => {
      const fn = ctx.newFunction(name, (argHandle) => {
        const callStart = Date.now();
        bridgeCallCount += 1;
        const record: BridgeCallRecord = {
          fn: name,
          argsJson: "",
          durationMs: 0,
        };
        bridgeCalls.push(record);

        const promise = ctx.newPromise();

        const fail = (msg: string) => {
          record.error = msg;
          record.durationMs = Date.now() - callStart;
          const err = ctx.newError(msg);
          promise.reject(err);
          err.dispose();
        };

        if (bridgeCallCount > limits.maxBridgeCalls) {
          fail(`Bridge call limit exceeded (${limits.maxBridgeCalls})`);
          promise.settled.then(drainJobs);
          return promise.handle;
        }

        let parsedArgs: unknown;
        try {
          parsedArgs = ctx.dump(argHandle);
          record.argsJson = JSON.stringify(parsedArgs ?? null);
        } catch (err) {
          fail(
            `Failed to read arguments: ${
              err instanceof Error ? err.message : String(err)
            }`
          );
          promise.settled.then(drainJobs);
          return promise.handle;
        }

        impl(parsedArgs).then(
          (result) => {
            record.durationMs = Date.now() - callStart;
            try {
              const handle = jsToHandle(ctx, result);
              promise.resolve(handle);
              handle.dispose();
            } catch (err) {
              fail(
                `Failed to marshal result: ${
                  err instanceof Error ? err.message : String(err)
                }`
              );
            }
          },
          (err: unknown) => {
            fail(err instanceof Error ? err.message : String(err));
          }
        );

        promise.settled.then(drainJobs);
        return promise.handle;
      });
      ctx.setProp(ctx.global, name, fn);
      fn.dispose();
    };

    bind("external_find", bridge.external_find);
    bind("external_aggregate", bridge.external_aggregate);
    bind("external_count", bridge.external_count);
    bind("external_distinct", bridge.external_distinct);

    // ── Eval user source ──
    // Wrap as an async IIFE so the model can use top-level `await` and
    // `return value` to emit a result.
    const wrapped = `(async () => {\n${source}\n})()`;
    const evalResult = await ctx.evalCodeAsync(wrapped, "user.ts");

    if (evalResult.error) {
      const dumped = ctx.dump(evalResult.error);
      evalResult.error.dispose();
      return {
        ok: false,
        error: timedOut
          ? `Timeout after ${limits.timeoutMs}ms`
          : extractMessage(dumped),
        console: consoleEntries,
        bridgeCalls,
        durationMs: Date.now() - startedAt,
      };
    }

    // The IIFE evaluates to a guest Promise. Drain pending jobs and yield
    // the host event loop until the promise settles or the deadline expires.
    const promiseHandle = evalResult.value;
    let valueHandle: QuickJSHandle | null = null;
    let errorHandle: QuickJSHandle | null = null;
    try {
      while (true) {
        drainJobs();
        const state = ctx.getPromiseState(promiseHandle);
        if (state.type === "fulfilled") {
          valueHandle = state.value;
          break;
        }
        if (state.type === "rejected") {
          errorHandle = state.error;
          break;
        }
        if (Date.now() > deadline) {
          timedOut = true;
          break;
        }
        await new Promise((resolve) => setImmediate(resolve));
      }
    } finally {
      promiseHandle.dispose();
    }

    if (timedOut) {
      if (valueHandle) valueHandle.dispose();
      if (errorHandle) errorHandle.dispose();
      return {
        ok: false,
        error: `Timeout after ${limits.timeoutMs}ms`,
        console: consoleEntries,
        bridgeCalls,
        durationMs: Date.now() - startedAt,
      };
    }

    if (errorHandle) {
      const dumped = ctx.dump(errorHandle);
      errorHandle.dispose();
      return {
        ok: false,
        error: extractMessage(dumped),
        console: consoleEntries,
        bridgeCalls,
        durationMs: Date.now() - startedAt,
      };
    }

    const value = valueHandle ? ctx.dump(valueHandle) : undefined;
    if (valueHandle) valueHandle.dispose();

    let serialized: string;
    try {
      serialized = JSON.stringify(value ?? null);
    } catch (err) {
      return {
        ok: false,
        error: `Result is not JSON-serializable: ${
          err instanceof Error ? err.message : String(err)
        }`,
        console: consoleEntries,
        bridgeCalls,
        durationMs: Date.now() - startedAt,
      };
    }

    if (serialized.length > limits.maxResultBytes) {
      return {
        ok: false,
        error: `Result too large: ${serialized.length} bytes (limit ${limits.maxResultBytes})`,
        console: consoleEntries,
        bridgeCalls,
        durationMs: Date.now() - startedAt,
      };
    }

    return {
      ok: true,
      result: value,
      console: consoleEntries,
      bridgeCalls,
      durationMs: Date.now() - startedAt,
    };
  } catch (err: unknown) {
    return {
      ok: false,
      error: timedOut
        ? `Timeout after ${limits.timeoutMs}ms`
        : err instanceof Error
          ? err.message
          : String(err),
      console: consoleEntries,
      bridgeCalls,
      durationMs: Date.now() - startedAt,
    };
  } finally {
    try {
      ctx.dispose();
    } catch {
      // Best-effort dispose.
    }
  }
}
