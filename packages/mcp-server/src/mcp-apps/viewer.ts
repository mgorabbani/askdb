// MCP Apps integration: a small UI resource that renders query results as
// an interactive table inside hosts that support MCP Apps. Hosts without
// MCP Apps support ignore the `_meta.ui` hints and fall back to the tool's
// plain-text content.
//
// Spec: https://apps.extensions.modelcontextprotocol.io (2026-01-26)
//   - Tool `_meta.ui.resourceUri` links a tool to a ui:// resource.
//   - Resource `_meta` carries csp, permissions, prefersBorder, domain.
//   - Host → iframe: `ui/notifications/tool-result` carries `{ content,
//     structuredContent }`. The iframe sends `ui/initialize` first.

export const RESULT_VIEWER_URI = "ui://askdb/result-viewer";

export interface StructuredResult {
  kind: "rows";
  rows: Record<string, unknown>[];
  columns: string[];
  meta: {
    collection: string;
    connectionId: string;
    connectionName: string;
    operation: string;
    count: number;
    truncated: boolean;
  };
}

export function resultViewerToolMeta(): Record<string, unknown> {
  return {
    ui: {
      resourceUri: RESULT_VIEWER_URI,
    },
  };
}

export function resultViewerResourceMeta(): Record<string, unknown> {
  return {
    csp: {
      "script-src": ["'self'", "'unsafe-inline'"],
      "style-src": ["'self'", "'unsafe-inline'"],
      "connect-src": ["'self'"],
    },
    permissions: {},
    prefersBorder: true,
  };
}

export function buildStructuredResult(
  rows: Record<string, unknown>[],
  info: {
    collection: string;
    connectionId: string;
    connectionName: string;
    operation: string;
    truncated: boolean;
  }
): StructuredResult {
  return {
    kind: "rows",
    rows,
    columns: inferColumns(rows),
    meta: {
      collection: info.collection,
      connectionId: info.connectionId,
      connectionName: info.connectionName,
      operation: info.operation,
      count: rows.length,
      truncated: info.truncated,
    },
  };
}

function inferColumns(rows: Record<string, unknown>[]): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  for (const row of rows.slice(0, 50)) {
    if (!row || typeof row !== "object") continue;
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key);
        order.push(key);
      }
    }
  }
  return order;
}

export function resultViewerHtml(): string {
  return VIEWER_HTML;
}

const VIEWER_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>askdb result viewer</title>
<style>
  :root {
    --fg: #111;
    --fg-muted: #666;
    --border: #e5e7eb;
    --bg: #fff;
    --bg-alt: #fafafa;
    --accent: #2563eb;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --fg: #e5e7eb;
      --fg-muted: #9ca3af;
      --border: #2a2a2a;
      --bg: #111;
      --bg-alt: #171717;
      --accent: #60a5fa;
    }
  }
  html, body { margin: 0; padding: 0; background: var(--bg); color: var(--fg); }
  body { font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  .toolbar {
    display: flex; gap: 8px; align-items: center;
    padding: 10px 12px; border-bottom: 1px solid var(--border);
    background: var(--bg-alt); position: sticky; top: 0; z-index: 1;
  }
  .title { font-weight: 600; font-size: 12px; }
  .meta { color: var(--fg-muted); font-size: 11px; }
  .search {
    margin-left: auto; flex: 0 1 220px; padding: 5px 8px;
    border: 1px solid var(--border); border-radius: 6px;
    background: var(--bg); color: var(--fg); font-size: 12px;
  }
  .count { color: var(--fg-muted); font-size: 11px; white-space: nowrap; }
  .wrap { max-height: min(70vh, 560px); overflow: auto; }
  table { border-collapse: collapse; width: 100%; font-size: 12px; }
  th, td { border-bottom: 1px solid var(--border); padding: 6px 10px; text-align: left; vertical-align: top; }
  th {
    background: var(--bg-alt); font-weight: 600; position: sticky; top: 0;
    font-size: 11px; color: var(--fg-muted); text-transform: uppercase; letter-spacing: 0.02em;
  }
  td { max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  td:hover { white-space: normal; overflow: visible; }
  .empty { padding: 32px; text-align: center; color: var(--fg-muted); }
  .json { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; color: var(--fg-muted); white-space: pre-wrap; }
</style>
</head>
<body>
  <div class="toolbar">
    <span class="title" id="title">Result</span>
    <span class="meta" id="meta"></span>
    <input class="search" id="search" placeholder="Filter rows…" />
    <span class="count" id="count"></span>
  </div>
  <div class="wrap"><div id="root" class="empty">Waiting for data…</div></div>
<script>
(function () {
  var state = { rows: [], columns: [], meta: null };
  var searchEl = document.getElementById("search");
  var titleEl = document.getElementById("title");
  var metaEl = document.getElementById("meta");
  var countEl = document.getElementById("count");
  var rootEl = document.getElementById("root");
  var nextRpcId = 1;

  searchEl.addEventListener("input", render);

  function post(msg) {
    try { window.parent.postMessage(msg, "*"); } catch (_) {}
  }

  function setStructured(s) {
    if (!s || typeof s !== "object") { clearEmpty("No data"); return; }
    if (Array.isArray(s)) {
      state.rows = s;
      state.columns = inferCols(s);
      state.meta = null;
    } else if (Array.isArray(s.rows)) {
      state.rows = s.rows;
      state.columns = Array.isArray(s.columns) && s.columns.length ? s.columns : inferCols(s.rows);
      state.meta = s.meta || null;
    } else {
      state.rows = [s];
      state.columns = inferCols([s]);
      state.meta = null;
    }
    render();
  }

  function setUnstructured(text) {
    try {
      var parsed = JSON.parse(text);
      if (Array.isArray(parsed)) { setStructured(parsed); return; }
      if (parsed && typeof parsed === "object") {
        if (Array.isArray(parsed.rows)) { setStructured(parsed); return; }
        setStructured({ rows: [parsed], columns: Object.keys(parsed) });
        return;
      }
    } catch (_) {}
    rootEl.className = "";
    rootEl.innerHTML = "";
    var pre = document.createElement("pre");
    pre.className = "json";
    pre.textContent = String(text);
    rootEl.appendChild(pre);
  }

  function inferCols(rows) {
    var seen = {}, order = [];
    for (var i = 0; i < Math.min(rows.length, 50); i++) {
      var r = rows[i];
      if (!r || typeof r !== "object") continue;
      for (var k in r) if (Object.prototype.hasOwnProperty.call(r, k) && !seen[k]) { seen[k] = 1; order.push(k); }
    }
    return order;
  }

  function fmt(v) {
    if (v === null || v === undefined) return "";
    if (typeof v === "object") return JSON.stringify(v);
    return String(v);
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function clearEmpty(msg) {
    rootEl.className = "empty";
    rootEl.textContent = msg;
    countEl.textContent = "";
  }

  function render() {
    if (state.meta) {
      titleEl.textContent = state.meta.operation ? (state.meta.operation + " · " + (state.meta.collection || "")) : "Result";
      var bits = [];
      if (state.meta.connectionName) bits.push(state.meta.connectionName);
      if (state.meta.truncated) bits.push("truncated");
      metaEl.textContent = bits.join(" · ");
    }
    if (!state.rows || state.rows.length === 0) { clearEmpty("No rows returned."); return; }
    var q = (searchEl.value || "").toLowerCase();
    var filtered = q ? state.rows.filter(function (r) {
      try { return JSON.stringify(r).toLowerCase().indexOf(q) !== -1; } catch (_) { return false; }
    }) : state.rows;
    countEl.textContent = filtered.length + (filtered.length === state.rows.length ? "" : " / " + state.rows.length) + " rows";
    var cols = state.columns && state.columns.length ? state.columns : inferCols(filtered);
    rootEl.className = "";
    var html = "<table><thead><tr>";
    for (var i = 0; i < cols.length; i++) html += "<th>" + esc(cols[i]) + "</th>";
    html += "</tr></thead><tbody>";
    for (var j = 0; j < filtered.length; j++) {
      var row = filtered[j];
      html += "<tr>";
      for (var k = 0; k < cols.length; k++) html += "<td>" + esc(fmt(row ? row[cols[k]] : undefined)) + "</td>";
      html += "</tr>";
    }
    html += "</tbody></table>";
    rootEl.innerHTML = html;
  }

  function ingestResult(params) {
    if (!params) return;
    if (params.structuredContent) { setStructured(params.structuredContent); return; }
    if (params.content && Array.isArray(params.content)) {
      var text = params.content
        .filter(function (b) { return b && b.type === "text" && typeof b.text === "string"; })
        .map(function (b) { return b.text; })
        .join("\\n");
      if (text) { setUnstructured(text); return; }
    }
    if (Array.isArray(params)) { setStructured(params); return; }
  }

  window.addEventListener("message", function (e) {
    var d = e && e.data;
    if (!d || typeof d !== "object") return;

    // MCP Apps 2026-01-26: host pushes results via this notification.
    if (d.method === "ui/notifications/tool-result" && d.params) {
      ingestResult(d.params);
      return;
    }

    // Tool-input pre-view so the app can render "pending" state while the
    // agent is still streaming args. We don't use the args directly today.
    if (d.method === "ui/notifications/tool-input" || d.method === "ui/notifications/tool-input-partial") {
      return;
    }

    // Graceful teardown request — respond so the host can reclaim resources.
    if (d.method === "ui/resource-teardown" && d.id != null) {
      post({ jsonrpc: "2.0", id: d.id, result: {} });
      return;
    }

    // Fallback: allow direct data pushes during local development.
    if (d.type === "askdb:data") { ingestResult(d.payload || d.data); return; }
  });

  // Spec handshake.
  post({
    jsonrpc: "2.0",
    id: nextRpcId++,
    method: "ui/initialize",
    params: {
      protocolVersion: "2026-01-26",
      clientInfo: { name: "askdb-result-viewer", version: "0.1.0" }
    }
  });

  if (window.__ASKDB_RESULT__) ingestResult(window.__ASKDB_RESULT__);
})();
</script>
</body>
</html>`;
