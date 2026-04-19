# AskDB — Landing Page Brief

A handoff document for the landing page developer. Everything you need to build `askdb.com` (or wherever it lives) is here: positioning, copy, structure, assets, SEO, and tech notes.

**Project:** AskDB
**Tagline:** Give AI agents safe access to your database.
**Subhead:** Your MongoDB or Postgres, sandboxed. Your fields, controlled. One MCP endpoint for every AI tool.
**Repo:** https://github.com/mgorabbani/askdb
**License:** AGPL v3 (self-hostable open source)

---

## 1. Goal of the landing page

One job: convert a technical founder / engineer / data-curious PM into **one of three actions**, ranked by intent:

1. **Install on VPS** — primary CTA (`curl | sudo bash` one-liner).
2. **Try locally with Docker** — secondary CTA (for evaluators).
3. **Star on GitHub** — low-commitment fallback.

Visitors are technical. No fluff. No animated gradients for their own sake. Show them the product, show them the command, let them leave.

---

## 2. Page structure (sections, in order)

> **Important:** Section 2 is a demo video — muted autoplay, no controls, looping. See section details below.

### Section 1 — Hero

- **Logo** (top-left): `docs/assets/logo.png` — 48px height.
- **Nav** (top-right): `Features` · `How it works` · `Docs` · `GitHub` · `Install` (primary button).
- **Headline:** *Give AI agents safe access to your database.*
- **Subhead:** *Your MongoDB or Postgres, sandboxed. Your fields, controlled. One `/mcp` endpoint for Claude, ChatGPT, Cursor, and anything else that speaks MCP.*
- **Primary CTA:** `Install on your VPS →` (scrolls to install section or opens docs).
- **Secondary CTA:** `Try locally with Docker` (opens docker section).
- **Trust row (small, under CTAs):** "Works with Claude · ChatGPT · Cursor · any MCP client" — with monochrome logos if possible.
- **Hero visual (right side, or below on mobile):** the existing `docs/assets/cover-github.png` or a new dashboard screenshot.

### Section 2 — Demo video (muted autoplay)

**This is the hero conversion moment.** The developer will be handed an MP4 file (`demo.mp4`) by the product team.

Requirements:

- Full-width container, max-width ~1100px, rounded corners, subtle shadow.
- `<video>` tag with these **exact** attributes:
  - `autoplay`
  - `muted` (REQUIRED — browsers block autoplay without it)
  - `loop`
  - `playsinline` (iOS Safari requirement)
  - `preload="metadata"` or `preload="auto"` depending on file size
  - **no `controls`** — user asked for controls-off
- Provide a **poster image** fallback (first frame as JPG/WebP, ~100KB) using the `poster` attribute.
- Lazy-load with `IntersectionObserver` so the video only starts playing when scrolled into view (saves bandwidth, improves LCP).
- Include a small caption underneath: *"AskDB dashboard — connect, configure visibility, copy MCP URL."*

Suggested implementation:

```html
<section class="demo">
  <video
    autoplay
    muted
    loop
    playsinline
    preload="metadata"
    poster="/assets/demo-poster.jpg"
    aria-label="AskDB product demo">
    <source src="/assets/demo.mp4" type="video/mp4" />
    <source src="/assets/demo.webm" type="video/webm" />
  </video>
  <p class="caption">AskDB dashboard — connect a database, toggle visibility, copy the MCP URL.</p>
</section>
```

Accessibility: since there is no sound, adding `aria-label` is enough. No captions track required.

### Section 3 — "AskDB is right for you if"

Bulleted checklist (copy from README, verbatim):

- You need **business answers from your database** without writing queries.
- You want AI agents to **query real data**, not stale CSV exports.
- You refuse to **share raw database credentials** with AI tools.
- You need **field-level control** over what AI can see (GDPR, PII, compliance).
- You want **one MCP endpoint** that works across Claude, ChatGPT, and Cursor.
- You want **audit logs** for every AI query against your data.
- You want to **self-host** everything — your server, your data, your rules.

### Section 4 — Features (4×3 grid, 11 cards)

Eleven feature cards, title + one-line description, icon optional. Layout as 3×3 with two extra cards pinned below — or 4×3 with one wide card — whichever renders cleanly on mobile.

1. **Sandbox Isolation** — Production data cloned into a Docker container. AI reads the copy, never the original.
2. **Field-Level Control** — Toggle any field or collection visible/hidden. Changes take effect immediately.
3. **PII Auto-Detection** — Fields like `email`, `password`, `ssn`, `phone` are detected and pre-hidden automatically.
4. **One Tool Surface, Two Engines** — MongoDB and PostgreSQL speak the same MCP vocabulary: `list-databases`, `list-collections`, `collection-schema`, `find`, `aggregate`, `count`, `distinct`, `sample-documents`, `execute-typescript`, `save-insight`. Postgres tables show up alongside Mongo collections.
5. **Query Validation** — Allowlist-only. Write operations rejected. Dangerous pipeline stages (`$merge`, `$out`, etc. on Mongo; any non-`SELECT` on Postgres) blocked.
6. **Audit Trail** — Every MCP query logged with timestamp, execution time, collection/table, and document/row count.
7. **API Key Auth** — Bearer token authentication. Keys shown once, stored hashed (SHA-256). Revoke anytime.
8. **Agent Memory** — Common query patterns tracked automatically. Agents learn your database over time.
9. **Schema Cache** — Full schema summary with field types, relationships, and descriptions — works for both Mongo collections and Postgres tables.
10. **Multi-Database Discovery** — Connect many databases across engines. Plain-language descriptions + a `databases://overview` resource + per-tool `connectionId` let the agent pick the right one on its own.
11. **MCP Apps Result Viewer** — `find`, `aggregate`, and `sample-documents` render an interactive table inside Claude Desktop / Claude Web / VS Code Copilot via the [MCP Apps](https://modelcontextprotocol.io/extensions/apps) extension. Non-Apps hosts fall back to plain JSON.

### Section 5 — Code Mode (highlight block)

A full-width dark block with a code snippet — this is the differentiator most competitors don't have.

- **Title:** *Code Mode — one round trip, not N+1.*
- **Body:** *The `execute-typescript` MCP tool lets the AI write a small TypeScript program that composes multiple Mongo queries inside a QuickJS WebAssembly isolate. One round trip in, one structured result out — instead of N+1 separate tool calls.*
- **Three bullet points:**
  - **Math is correct** — sums, averages, percentages run as real JavaScript.
  - **Token cost drops** — a query touching 500 docs lives and dies inside the isolate.
  - **Security unchanged** — same validation pipeline, hidden fields stripped before data crosses in.
- **Code block** (syntax-highlight as `ts`):

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

- **Fine print below:** *Limits per execution: 30s wall-clock timeout, 128MB memory, 50 bridge calls, 256KB serialized result.*

### Section 6 — How it works (3 steps)

Three-column layout, numbered 01/02/03, icon + title + one-line description.

| # | Step      | Description |
|---|-----------|-------------|
| 01 | **Connect** | Paste your MongoDB or PostgreSQL connection string in the dashboard. |
| 02 | **Configure** | Browse real sample data, toggle which fields the AI can see. |
| 03 | **Query** | Give your AI agent `https://<your-domain>/mcp` — done. |

Below the steps, render the ASCII architecture diagram from the README as a clean SVG:

```
┌─────────────────────────────────────────────────┐
│                   Your Server                     │
│                                                   │
│  ┌──────────────┐       ┌───────────────┐        │
│  │  Dashboard    │──────>│  SQLite       │        │
│  │  + API + MCP  │       │  (config only) │        │
│  │  :3100        │       └───────────────┘        │
│  └──────────────┘                                 │
│                          ┌───────────────┐        │
│                          │  Sandbox      │<── clone from prod
│                          │  Mongo / PG   │        │
│                          └───────────────┘        │
└─────────────────────────────────────────────────┘
         ^
         | MCP (Streamable HTTP)
   Claude / ChatGPT / Cursor
```

### Section 7 — Without AskDB / With AskDB (comparison table)

Two-column table. Left column muted/red tone, right column green tone.

| Without AskDB | With AskDB |
|---|---|
| You share raw MongoDB or Postgres credentials with AI tools and hope nothing gets written. | Sandbox isolation. AI queries a read-only copy. Production is never touched. |
| You export CSVs to ChatGPT. Data is stale within hours — and you just violated GDPR. | Real-time queries against live sandbox data. Fields with PII are auto-hidden. |
| You set up Metabase/Looker for weeks, and your AI agent still can't use it. | One MCP endpoint. Works with Claude, ChatGPT, Cursor in minutes. |
| Business team asks "how many pro users signed up this week?" and waits for an engineer. | They ask the AI agent directly. Answer in seconds. |
| You have no idea what your AI agent queried or when. | Full audit trail. Every query, every timestamp, every result count. |
| You want AI to see `orders` but not `email` or `credit_card` inside orders. | Field-level toggles. Hide specific fields, not entire collections. |

### Section 8 — Install (primary conversion)

Dark terminal-style block with the install command. Big copy-to-clipboard button.

```bash
curl -fsSL https://raw.githubusercontent.com/mgorabbani/askdb/main/install.sh | sudo bash
```

Below, small grid of three install modes:

- **Caddy (default)** — auto-provisioned HTTPS. Requires a domain + A record.
- **Proxyless** — bring your own reverse proxy (Coolify, Traefik, nginx). Binds `127.0.0.1:3100`.
- **Cloudflare Tunnel** — no open ports. Paste your tunnel token when prompted.

Fine print: *Total time on a fresh VPS: 2–3 minutes. Works on Ubuntu 22.04+ / Debian 12+.*

### Section 9 — Connecting your AI agent

Two tabs (Claude Desktop/Code, Cursor), each with a JSON config block.

**Claude Desktop / Claude Code:**

```json
{
  "askdb": {
    "type": "streamable-http",
    "url": "https://YOUR_SERVER/mcp",
    "headers": {
      "Authorization": "Bearer ask_sk_YOUR_KEY"
    }
  }
}
```

**Cursor:**

```json
{
  "mcpServers": {
    "askdb": {
      "url": "https://YOUR_SERVER/mcp",
      "headers": {
        "Authorization": "Bearer ask_sk_YOUR_KEY"
      }
    }
  }
}
```

Note below: *For remote clients (Claude web, ChatGPT), OAuth handles auth automatically — no key needed.*

### Section 10 — Security (trust block)

Grid of 9 short statements, each with a check icon:

1. Production databases are never written to — read-only connections only.
2. Hidden fields never appear in MCP responses — stripped at query time.
3. Hidden collections are never listed or queryable.
4. All queries are validated — only `find`, `aggregate`, `count`, `distinct` allowed.
5. Dangerous aggregation stages blocked — `$merge`, `$out`, `$collStats`, `$currentOp`, `$listSessions`.
6. `$lookup` on hidden collections is rejected.
7. Connection strings encrypted at rest (AES-256-GCM), never logged.
8. API keys hashed (SHA-256), shown once, never stored in plaintext.
9. Every MCP query logged to the audit trail.

Callout below: *Docker socket hardening: a `tecnativa/docker-socket-proxy` sidecar ensures AskDB never has direct access to `/var/run/docker.sock`.*

### Section 11 — FAQ (accordion)

- **How long does setup take?** Under 10 minutes. Paste your MongoDB or Postgres URL, configure visibility, copy the MCP URL into your AI tool.
- **Does AskDB write to my production database?** Never. It connects read-only to run `mongodump` (Mongo) or `pg_dump` (Postgres), then all queries go against the sandbox copy.
- **How is field filtering different from data masking?** Data masking replaces values with fakes. AskDB simply omits hidden fields entirely — the AI doesn't know they exist.
- **Which databases are supported today?** MongoDB and PostgreSQL are both first-class — pick the engine when you add a connection, or mix them in one workspace. MySQL is next on the roadmap.
- **Can I connect more than one database at once?** Yes. Every connection gets a plain-language description. Agents see a `databases://overview` plus a `list-databases` tool and pass a `connectionId` into every query call.
- **How does the sandbox stay fresh?** Manual sync — click "Sync Now" in the dashboard. Scheduled sync is on the roadmap.
- **Is this secure enough for production data?** AskDB enforces read-only access, field stripping at query time, query validation, encrypted connection strings, and full audit logging.
- **Is it really open source?** Yes — AGPLv3. Fork it, run it, modify it. If you run a modified version as a network service, share your modifications back.

### Section 12 — Final CTA

Repeat the install command, centered, with one line above: *Ready in 2 minutes on a fresh VPS.*

### Section 13 — Footer

- Left: logo + tagline + AGPLv3 note.
- Middle: Product (Features, How it works, Security, Roadmap).
- Middle-right: Resources (GitHub, Docs, Changelog, License).
- Right: Community (GitHub Issues, Discussions, Security Policy).
- Bottom line: *© AskDB. Open source under AGPLv3. Built for people who want AI to understand their data, not own it.*

---

## 3. Assets

All visual assets live in the repo under `docs/assets/`:

| File | Use |
|------|-----|
| `docs/assets/logo.png` | Nav logo (48px height). Also usable as favicon source. |
| `docs/assets/cover-github.png` | Hero visual / OG image / social preview. |
| `demo.mp4` | **To be provided separately** — goes in section 2. |
| `demo-poster.jpg` | **To be provided separately** — first frame of the video, used as `poster`. |

**Favicons / app icons:** generate from `logo.png` using `realfavicongenerator.net` or similar. Ship all standard sizes.

**OG image:** use `cover-github.png` (1200×630 is ideal; crop/pad if needed).

---

## 4. SEO & metadata

```html
<title>AskDB — Give AI agents safe access to your database</title>
<meta name="description" content="Self-hosted MCP bridge for MongoDB and PostgreSQL. Sandbox your databases, control which fields the AI can see, and plug one /mcp endpoint into Claude, ChatGPT, and Cursor." />

<meta property="og:title" content="AskDB — Give AI agents safe access to your database" />
<meta property="og:description" content="Your database, sandboxed. Your fields, controlled. One MCP endpoint for every AI tool." />
<meta property="og:image" content="https://askdb.com/og.png" />
<meta property="og:type" content="website" />
<meta property="og:url" content="https://askdb.com" />

<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="AskDB — Give AI agents safe access to your database" />
<meta name="twitter:description" content="Self-hosted MCP bridge for MongoDB and PostgreSQL." />
<meta name="twitter:image" content="https://askdb.com/og.png" />

<link rel="canonical" href="https://askdb.com" />
```

Target keywords (primary): *MCP MongoDB*, *MCP Postgres*, *MongoDB MCP server*, *PostgreSQL MCP server*, *AI database access*, *Claude MongoDB*, *Claude Postgres*, *ChatGPT MongoDB*, *self-hosted MCP*.

---

## 5. Technical requirements

- **Framework:** Next.js 15 (App Router) or Astro — either is fine. Static output preferred.
- **Styling:** Tailwind CSS v4. Match the repo's UI tone (shadcn/ui-adjacent, clean, minimal).
- **Fonts:** Inter for body, JetBrains Mono (or similar) for code blocks.
- **Colors:** neutral grayscale base, single accent color (pick one — electric blue `#3B82F6` or MCP purple `#8A2BE2` from the README badges). Dark mode supported.
- **Performance targets:**
  - Lighthouse performance score ≥ 95 on mobile.
  - LCP < 2.0s.
  - Video MUST NOT block LCP — use `preload="metadata"` and lazy-mount, poster image carries first paint.
  - Ship WebM + MP4 sources; WebM is ~30% smaller where supported.
- **Analytics:** PostHog (project already uses it). Drop in the snippet; no custom events needed initially.
- **Hosting:** Vercel or Cloudflare Pages. Static preferred. No server-side needed.
- **Forms:** none — the page has no forms. All CTAs are links.

---

## 6. Copy voice & rules

- Technical founder voice. Short sentences. No marketing fluff.
- Never say "revolutionary", "cutting-edge", "game-changing", or "unlock".
- Always show the command, the code, or the config — don't just describe it.
- Avoid emojis in the UI chrome. Fine inside tooltips or small trust signals if needed.
- When stating a limit or a guarantee, be specific: *"30s timeout, 128MB memory"* not *"fast and efficient"*.

---

## 7. Out of scope

- No pricing page (product is open source, self-host only).
- No signup / waitlist / lead capture.
- No chatbot, Intercom, or live chat.
- No blog (ship separately later if needed).
- No customer logos (no customers to list publicly yet).
- No animations beyond micro-interactions (hover states, subtle scroll reveal). No Lottie, no particle systems.

---

## 8. Questions to ask before starting

1. What's the final domain? (`askdb.com`, `askdb.dev`, something else?)
2. Who provides `demo.mp4` and `demo-poster.jpg`? What's the target file size budget?
3. Accent color — blue or purple? (Pick one and stick with it.)
4. Is there a separate `/docs` site, or should the landing page link into the GitHub README for everything?
5. Does PostHog need to be installed, or just a tracking ID added?

---

**End of brief.** Ping the product owner with any ambiguity before shipping.
