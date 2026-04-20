# Code Mode

The `execute-typescript` MCP tool lets the AI write a small TypeScript program that composes multiple Mongo or Postgres queries inside a sandboxed [QuickJS](https://bellard.org/quickjs/) WebAssembly isolate. One round trip in, one structured result out — instead of N+1 separate tool calls.

## Why it matters

- **Math is correct.** Sums, averages, percentages run as actual JavaScript inside the sandbox. The model decides what to compute; the sandbox computes it.
- **Token cost drops.** A query that touches 500 documents lives and dies inside the isolate. Only the final result crosses the wire to the model.
- **Security is unchanged.** Every `external_*` call inside the sandbox routes through the same `executeQueryOperation` that the direct `find`/`aggregate`/`count`/`distinct` tools use. Hidden fields are stripped before data crosses into the sandbox. The isolate has no `fs`, no `process`, no `require`, no `fetch`, no globals at all beyond the four bridge functions.

## Example

```ts
const top = await external_find({ collection: "products", limit: 5 });
const ratings = await Promise.all(
  top.map((p) =>
    external_find({ collection: "ratings", filter: { productId: p._id } })
  )
);
return top.map((p, i) => ({
  name: p.name,
  avgRating: ratings[i].reduce((s, r) => s + r.score, 0) / ratings[i].length,
}));
```

## Limits

Per execution:

- 30s wall-clock timeout
- 128MB memory
- 50 bridge calls
- 256KB serialized result

Disable the tool entirely by adding `execute-typescript` to `ASKDB_MCP_DISABLED_TOOLS`.
