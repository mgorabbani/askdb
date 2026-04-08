# dbgate — Complete Mock Flow

> End-to-end walkthrough: from a fresh VPS to a team member asking Claude about company data.

---

## Act 1: Installation (2 minutes)

### Scene 1.1 — SSH into a fresh VPS

```
local$ ssh root@203.0.113.42

Welcome to Ubuntu 24.04 LTS
root@vps:~#
```

### Scene 1.2 — Run the installer

```
root@vps:~# curl -sSL https://get.dbgate.dev | bash

  ┌─────────────────────────────────────┐
  │   dbgate — Self-Hosted Installer    │
  └─────────────────────────────────────┘

Checking system...
  ✓ OS: Ubuntu 24.04 LTS (amd64)
  ✗ Docker not found — installing...
    ✓ Docker installed (v27.5.1)
  ✓ Docker Compose available
  ✓ Secrets generated
  ✓ Public IP: 203.0.113.42

Pulling images...
  ✓ caddy:2-alpine
  ✓ dbgate/web:latest
  ✓ dbgate/mcp-server:latest
  ✓ postgres:16-alpine

Starting dbgate...
  ✓ All services started

  ┌──────────────────────────────────────────────┐
  │                                              │
  │  dbgate is running!                          │
  │                                              │
  │  Open: http://203.0.113.42                   │
  │                                              │
  │  Create your admin account to get started.   │
  │                                              │
  └──────────────────────────────────────────────┘
```

**SSH session done. Everything else is in the browser.**

### Scene 1.3 — What's running on the VPS now

```
root@vps:~# docker ps --format "table {{.Names}}\t{{.Image}}\t{{.Status}}"

NAMES              IMAGE                      STATUS
dbgate-caddy-1     caddy:2-alpine            Up 30 seconds
dbgate-web-1       dbgate/web:latest         Up 28 seconds
dbgate-mcp-server  dbgate/mcp-server:latest  Up 28 seconds
dbgate-app-db-1    postgres:16-alpine        Up 30 seconds
```

4 containers. No Node.js on the host. No npm. Just Docker.

---

## Act 2: First-Run Setup (1 minute)

### Scene 2.1 — Open the browser

CTO opens `http://203.0.113.42`:

```
┌─────────────────────────────────────────────────────────────────────┐
│  ○ ○ ○  http://203.0.113.42                                        │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│                        ┌─────────────────────┐                      │
│                        │     dbgate           │                      │
│                        └─────────────────────┘                      │
│                                                                     │
│                   Welcome to dbgate                                 │
│                                                                     │
│           Create your admin account to get started.                 │
│                                                                     │
│           Email                                                     │
│           ┌─────────────────────────────────┐                       │
│           │ sarah@acmecorp.com              │                       │
│           └─────────────────────────────────┘                       │
│                                                                     │
│           Password                                                  │
│           ┌─────────────────────────────────┐                       │
│           │ ••••••••••••••••                │                       │
│           └─────────────────────────────────┘                       │
│                                                                     │
│           Confirm Password                                          │
│           ┌─────────────────────────────────┐                       │
│           │ ••••••••••••••••                │                       │
│           └─────────────────────────────────┘                       │
│                                                                     │
│           ┌─────────────────────────────────┐                       │
│           │        Create Account           │                       │
│           └─────────────────────────────────┘                       │
│                                                                     │
│           This page only appears once.                              │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### Scene 2.2 — Redirect to empty dashboard

```
┌─────────────────────────────────────────────────────────────────────┐
│  ○ ○ ○  http://203.0.113.42/dashboard                              │
├──────────┬──────────────────────────────────────────────────────────┤
│          │                                                          │
│ dbgate   │  Dashboard                          sarah@acmec... ▼    │
│          │                                                          │
│ ─────    │  ┌───────────────────────────────────────────────────┐   │
│          │  │                                                   │   │
│ Dashboard│  │  No databases connected yet.                      │   │
│ Team     │  │                                                   │   │
│ API Keys │  │  ┌─────────────────────────────────────┐          │   │
│ Audit Log│  │  │   + Connect your first database     │          │   │
│ Settings │  │  └─────────────────────────────────────┘          │   │
│          │  │                                                   │   │
│          │  │  Quick start:                                     │   │
│          │  │  1. Connect a database (Postgres, MongoDB, MySQL) │   │
│          │  │  2. Choose which fields AI can see                │   │
│          │  │  3. Get your MCP URL for Claude/ChatGPT           │   │
│          │  │                                                   │   │
│          │  └───────────────────────────────────────────────────┘   │
│          │                                                          │
└──────────┴──────────────────────────────────────────────────────────┘
```

---

## Act 3: Connect a Database (3 minutes)

### Scene 3.1 — Step 1: Select type

```
┌──────────┬──────────────────────────────────────────────────────────┤
│          │                                                          │
│ dbgate   │  Connect Database          Step 1 of 4                  │
│          │                                                          │
│          │  Select your database type:                              │
│          │                                                          │
│          │  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐     │
│          │  │  PostgreSQL  │ │   MongoDB    │ │    MySQL     │     │
│          │  │              │ │  [selected]  │ │              │     │
│          │  └──────────────┘ └──────────────┘ └──────────────┘     │
│          │                                                          │
│          │                             ┌──────────┐                 │
│          │                             │   Next   │                 │
│          │                             └──────────┘                 │
└──────────┴──────────────────────────────────────────────────────────┘
```

### Scene 3.2 — Step 2: Connection string

```
┌──────────┬──────────────────────────────────────────────────────────┤
│          │                                                          │
│ dbgate   │  Connect Database          Step 2 of 4                  │
│          │                                                          │
│          │  Paste your MongoDB connection string:                   │
│          │                                                          │
│          │  ┌───────────────────────────────────────────────────┐   │
│          │  │ mongodb+srv://admin:****@cluster0.abc123.mongodb. │   │
│          │  │ net/acme_production                               │   │
│          │  └───────────────────────────────────────────────────┘   │
│          │                                                          │
│          │  Connection name:                                        │
│          │  ┌───────────────────────────────────────────────────┐   │
│          │  │ acme-production                                   │   │
│          │  └───────────────────────────────────────────────────┘   │
│          │                                                          │
│          │  ┌───────────────────────────────────────────────────┐   │
│          │  │ ✓ Connected successfully                          │   │
│          │  │   MongoDB 7.0 · 14 collections · 52,341 documents │   │
│          │  └───────────────────────────────────────────────────┘   │
│          │                                                          │
│          │  We'll create a sandboxed copy in a Docker container.    │
│          │  Your production database is never modified.             │
│          │                                                          │
│          │  ┌──────────┐  ┌──────────┐                              │
│          │  │   Back   │  │   Next   │                              │
│          │  └──────────┘  └──────────┘                              │
└──────────┴──────────────────────────────────────────────────────────┘
```

### Scene 3.3 — Loading: creating sandbox

```
┌──────────┬──────────────────────────────────────────────────────────┤
│          │                                                          │
│ dbgate   │  Connect Database          Step 3 of 4                  │
│          │                                                          │
│          │  Creating your sandbox...                                │
│          │                                                          │
│          │  ┌───────────────────────────────────────────────────┐   │
│          │  │  ✓ Spinning up sandbox container (mongo:7)        │   │
│          │  │  ✓ Dumping data from production (mongodump)       │   │
│          │  │  ✓ Restoring into sandbox (mongorestore)          │   │
│          │  │  ◔ Scanning for PII fields...                     │   │
│          │  │    ░░░░░░░░████████████████████████ 82%           │   │
│          │  └───────────────────────────────────────────────────┘   │
└──────────┴──────────────────────────────────────────────────────────┘
```

### Scene 3.4 — Step 3: Schema browser with real sample data

**This is the key screen.** CTO sees real data from the latest row of each collection and toggles visibility per field.

```
┌──────────┬──────────────────────────────────────────────────────────┤
│          │                                                          │
│ dbgate   │  Connect Database          Step 3 of 4                  │
│          │                                                          │
│          │  ✓ Sandbox created. Choose which fields AI can see:      │
│          │                                                          │
│          │  Sync schedule: [Manual ▼]                                │
│          │                                                          │
│          │  ▼ 👁 users (15,234 docs)                                │
│          │  ┌─────────────┬──────────┬─────────────────────┬──────┐ │
│          │  │ Field       │ Type     │ Sample (latest row) │ Show │ │
│          │  ├─────────────┼──────────┼─────────────────────┼──────┤ │
│          │  │ _id         │ ObjectId │ 6621a3f4e8b2...     │ [✓]  │ │
│          │  │ email       │ String   │ sarah@acmecorp.com  │ [ ] ⚠│ │
│          │  │ full_name   │ String   │ Sarah Chen          │ [ ] ⚠│ │
│          │  │ password    │ String   │ $2b$10$xK9v...      │ [ ] ⚠│ │
│          │  │ phone       │ String   │ +1-415-555-0123     │ [ ] ⚠│ │
│          │  │ plan        │ String   │ pro                 │ [✓]  │ │
│          │  │ company     │ String   │ Acme Corp           │ [✓]  │ │
│          │  │ created_at  │ Date     │ 2026-01-15T10:30:00 │ [✓]  │ │
│          │  │ last_login  │ Date     │ 2026-04-06T14:22:00 │ [✓]  │ │
│          │  └─────────────┴──────────┴─────────────────────┴──────┘ │
│          │  ⚠ = PII detected — recommended to hide from AI          │
│          │                                                          │
│          │  ► 👁 orders (89,201 docs)       1 field hidden          │
│          │  ► 👁 products (342 docs)        all visible             │
│          │  ► 👁 campaigns (128 docs)       all visible             │
│          │  ► 👁 subscriptions (8,901 docs) 1 field hidden          │
│          │  ► 🚫 _migrations (47 docs)     [entire table hidden]    │
│          │  ► 🚫 _sessions (12,003 docs)   [entire table hidden]    │
│          │                                                          │
│          │  Summary: 5 tables visible, 2 hidden | 6 fields hidden   │
│          │                                                          │
│          │  ┌──────────┐  ┌─────────────────────────┐               │
│          │  │   Back   │  │  Save & Deploy MCP  →   │               │
│          │  └──────────┘  └─────────────────────────┘               │
└──────────┴──────────────────────────────────────────────────────────┘
```

**What the CTO sees:**
- Real data from production — they need to see actual values to decide what to hide
- PII fields (email, name, phone, password) auto-detected and **pre-unchecked** (hidden by default)
- Internal tables (_migrations, _sessions) auto-hidden
- Sync schedule right on this page
- Changes take effect immediately — no re-sync needed

### Scene 3.5 — Step 4: MCP URL ready

```
┌──────────┬──────────────────────────────────────────────────────────┤
│          │                                                          │
│ dbgate   │  Connect Database          Step 4 of 4  ✓               │
│          │                                                          │
│          │  ┌───────────────────────────────────────────────────┐   │
│          │  │  ✅ acme-production is ready!                     │   │
│          │  │  Your MCP server is live. Connect any AI agent.   │   │
│          │  └───────────────────────────────────────────────────┘   │
│          │                                                          │
│          │  Your MCP Server:                                        │
│          │  ┌────────────────────────────────────────────┬──────┐   │
│          │  │ http://203.0.113.42/mcp                    │ Copy │   │
│          │  └────────────────────────────────────────────┴──────┘   │
│          │                                                          │
│          │  Your API Key:                                           │
│          │  ┌────────────────────────────────────────────┬──────┐   │
│          │  │ dbg_sk_a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6   │ Copy │   │
│          │  └────────────────────────────────────────────┴──────┘   │
│          │  ⚠ Save this key now. It won't be shown again.          │
│          │                                                          │
│          │  Choose your platform:                                   │
│          │  ┌───────────┐ ┌───────────┐ ┌───────────┐              │
│          │  │  Claude   │ │  ChatGPT  │ │  Cursor   │              │
│          │  │  Desktop  │ │           │ │           │              │
│          │  │ [selected]│ │           │ │           │              │
│          │  └───────────┘ └───────────┘ └───────────┘              │
│          │                                                          │
│          │  Add this to your Claude Desktop config:                 │
│          │  ┌───────────────────────────────────────────────────┐   │
│          │  │ {                                                 │   │
│          │  │   "mcpServers": {                                 │   │
│          │  │     "company-data": {                             │   │
│          │  │       "type": "url",                              │   │
│          │  │       "url": "http://203.0.113.42/mcp",          │   │
│          │  │       "headers": {                                │   │
│          │  │         "Authorization": "Bearer dbg_sk_a1b2..."  │   │
│          │  │       }                                           │   │
│          │  │     }                                             │   │
│          │  │   }                                               │   │
│          │  │ }                                       [Copy]    │   │
│          │  └───────────────────────────────────────────────────┘   │
│          │                                                          │
│          │  Then restart Claude Desktop. You're done!               │
│          │  Try asking: "How many users signed up this week?"       │
│          │                                                          │
└──────────┴──────────────────────────────────────────────────────────┘
```

---

## Act 4: AI Agent Queries Data

### Scene 4.1 — CTO asks Claude a question

```
┌─────────────────────────────────────────────────────────────────────┐
│  Claude                                              New Chat       │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  company-data (MCP)                                Connected        │
│                                                                     │
│  Sarah: How many users signed up this week?                         │
│                                                                     │
│  Claude: I'll check your database for this week's signups.          │
│                                                                     │
│  Using tool: list_tables                                            │
│  → Found 5 accessible collections                                  │
│                                                                     │
│  Using tool: describe_table (users)                                 │
│  → 5 fields visible, db_type: mongodb                              │
│                                                                     │
│  Using tool: query                                                  │
│  → { "collection": "users", "operation": "aggregate",              │
│      "pipeline": [                                                  │
│        { "$match": { "created_at": {                                │
│            "$gte": "2026-03-31T00:00:00Z" } } },                   │
│        { "$count": "total" }                                        │
│      ] }                                                            │
│  → Result: { "total": 142 }                                        │
│                                                                     │
│  **142 users signed up this week** (since March 31, 2026).          │
│                                                                     │
│  That's a 23% increase compared to last week. Want me to break      │
│  this down by plan type?                                            │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### Scene 4.2 — What Claude actually sees

When Claude calls `describe_table("users")`, the hidden fields **don't exist** in the response:

```json
{
  "table": "users",
  "db_type": "mongodb",
  "row_count": 15234,
  "columns": [
    { "name": "_id",        "type": "ObjectId" },
    { "name": "plan",       "type": "String"   },
    { "name": "company",    "type": "String"   },
    { "name": "created_at", "type": "Date"     },
    { "name": "last_login", "type": "Date"     }
  ]
}
```

**Not returned at all:** `email`, `full_name`, `password`, `phone`

Claude doesn't know these fields exist. It can't query them, reference them, or ask about them. They're simply invisible.

When Claude runs a query, even `SELECT *` or `find({})`, those fields are stripped from the result rows before returning.

---

## Act 5: Invite a Team Member (2 minutes)

### Scene 5.1 — CTO invites the head of marketing

```
┌──────────┬──────────────────────────────────────────────────────────┤
│          │                                                          │
│ dbgate   │  Team                                                    │
│          │                                                          │
│          │  Members                                                 │
│          │  ┌───────────────────────────────────────────────────┐   │
│          │  │ sarah@acmecorp.com       Owner    1 key   Active │   │
│          │  └───────────────────────────────────────────────────┘   │
│          │                                                          │
│          │  Invite new member                                       │
│          │                                                          │
│          │  Email: [ mike@acmecorp.com                         ]    │
│          │  Role:  [ Analyst ▼ ]                                    │
│          │  Can query all visible tables. Cannot edit schema.       │
│          │                                                          │
│          │  ┌──────────────────┐                                    │
│          │  │  Send Invite  →  │                                    │
│          │  └──────────────────┘                                    │
└──────────┴──────────────────────────────────────────────────────────┘
```

### Scene 5.2 — Mike receives email, sets up account

```
From: dbgate <noreply@203.0.113.42>
To: mike@acmecorp.com
Subject: Sarah gave you access to company data in Claude

Sarah (sarah@acmecorp.com) has given you access to Acme Corp's
company data through dbgate.

You can now ask questions about company data directly in Claude,
ChatGPT, or Cursor — no SQL required.

[Set Up Your Account →]
```

Mike clicks the link, creates a password, and sees his personal MCP URL + API key with platform-specific copy instructions.

### Scene 5.3 — Mike opens ChatGPT

```
┌─────────────────────────────────────────────────────────────────────┐
│  ChatGPT                                                            │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  Mike: Which marketing campaigns drove the most signups last month? │
│                                                                     │
│  ChatGPT: Let me check your company's data.                        │
│                                                                     │
│  Here are the top campaigns by signups in March 2026:               │
│                                                                     │
│  1. google-sem-brand — 312 signups (34%)                            │
│  2. twitter-launch-thread — 187 signups (20%)                       │
│  3. producthunt-launch — 156 signups (17%)                          │
│  4. newsletter-march — 89 signups (10%)                             │
│  5. referral-program — 78 signups (8%)                              │
│                                                                     │
│  Want me to compare the conversion rates across these channels?     │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

**Mike never sees:** SQL, connection strings, config files, or the dashboard. He just asks questions and gets answers.

---

## Act 6: Audit Log

### Scene 6.1 — CTO reviews what's been queried

```
┌──────────┬──────────────────────────────────────────────────────────┤
│          │                                                          │
│ dbgate   │  Audit Log                       Filter ▼  Export CSV   │
│          │                                                          │
│          │  ┌────────────────────────────────────────────────────┐  │
│          │  │ Time       User     Action    Collections   Rows ms│  │
│          │  ├────────────────────────────────────────────────────┤  │
│          │  │ 14:32:01  mike     query     campaigns       5  87│  │
│          │  │ 14:31:58  mike     describe  users           —  12│  │
│          │  │ 14:31:55  mike     list_tab  —               —   8│  │
│          │  │ 14:22:15  sarah    query     users           3  45│  │
│          │  │ 14:22:01  sarah    query     users           1  32│  │
│          │  │ 14:21:55  sarah    describe  users           —  11│  │
│          │  │ 14:21:52  sarah    list_tab  —               —   9│  │
│          │  └────────────────────────────────────────────────────┘  │
│          │                                                          │
│          │  Showing 7 entries                       ◄ 1 ►          │
└──────────┴──────────────────────────────────────────────────────────┘
```

Every query is logged — who asked, what tool was called, which collections were accessed, how many rows returned, and execution time.

---

## Act 7: Add Custom Domain

```
┌──────────┬──────────────────────────────────────────────────────────┤
│          │                                                          │
│ dbgate   │  Settings → Domain                                       │
│          │                                                          │
│          │  Current: http://203.0.113.42                             │
│          │                                                          │
│          │  Custom domain:                                          │
│          │  [ data.acmecorp.com                               ]     │
│          │                                                          │
│          │  1. Add DNS A record → 203.0.113.42                      │
│          │  2. Click "Verify & Enable"                              │
│          │                                                          │
│          │  ┌──────────────────────┐                                │
│          │  │  Verify & Enable  →  │                                │
│          │  └──────────────────────┘                                │
│          │                                                          │
│          │  After verification:                                     │
│          │  Dashboard: https://data.acmecorp.com                    │
│          │  MCP:       https://data.acmecorp.com/mcp                │
│          │  SSL: Auto via Let's Encrypt (Caddy)                     │
└──────────┴──────────────────────────────────────────────────────────┘
```

---

## Act 8: Sync & Refresh

A week later, Sarah wants fresh data. She clicks "Sync Now" on the connection page:

```
┌──────────┬──────────────────────────────────────────────────────────┤
│          │                                                          │
│ dbgate   │  acme-production                                         │
│          │                                                          │
│          │  Status: 🟢 Healthy                                      │
│          │  Type: MongoDB · 14 collections · 52K docs               │
│          │  Last synced: 7 days ago                                 │
│          │  Sync schedule: [Manual ▼]                                │
│          │  Sandbox: dbgate-sandbox-acme-prod (mongo:7)              │
│          │                                                          │
│          │  ┌───────────────┐  ┌───────────────┐                    │
│          │  │  Sync Now     │  │  View Schema  │                    │
│          │  └───────────────┘  └───────────────┘                    │
│          │                                                          │
│          │  (after clicking Sync Now)                                │
│          │                                                          │
│          │  ✓ Connected to production (read-only)                   │
│          │  ✓ Dumping latest data (mongodump)                       │
│          │  ✓ Restoring to sandbox (mongorestore)                   │
│          │  ✓ Sync complete                                         │
│          │                                                          │
│          │  52,341 → 53,089 documents (+748 new)                   │
│          │  Visibility config unchanged (still applied at query time)│
│          │                                                          │
└──────────┴──────────────────────────────────────────────────────────┘
```

**Sync is just dump/restore.** No masking step, no post-processing. Fast. The visibility config is applied at query time by the MCP server, not baked into the sandbox data.

She can also change the sync schedule to "Daily" so this happens automatically.

---

## Act 9: CTO changes visibility config

Sarah decides the `company` field on users should also be hidden (a client asked for more privacy):

```
Goes to Schema Browser → users → unchecks "company" → clicks Save
```

**That's it.** No re-sync needed. The next time any AI agent calls `query` or `describe_table`, the `company` field simply won't be in the response. Takes effect in under a second.

---

## Timeline Summary

```
00:00  SSH into VPS
00:15  curl | bash (installer starts)
00:45  Docker installed automatically
01:30  All images pulled, services started
01:30  Open http://VPS_IP in browser
01:45  Admin account created
02:00  Click "Connect your first database"
02:15  Select MongoDB, paste connection string
02:30  Connection validated, sandbox creating...
03:30  Schema browser: review fields, toggle visibility
03:45  Click "Save & Deploy MCP"
04:00  Copy MCP config into Claude Desktop
04:15  Restart Claude Desktop
04:30  "How many users signed up this week?" → real answer

Total: ~4.5 minutes from empty VPS to AI answering data questions.
```

---

## What Each Person Experiences

### CTO (Sarah) — one-time setup, ~5 minutes
```
SSH → curl|bash → browser → create account → connect MongoDB →
see real sample data → toggle field visibility → copy MCP URL → invite team
```
Never touches config files or YAML after initial setup.
Can change visibility anytime — takes effect immediately, no re-sync.

### Team Member (Mike) — 2 minutes
```
receives email → clicks link → creates password → copies config →
pastes into ChatGPT → asks questions → gets answers
```
Never sees the dashboard, connection strings, or visibility settings.

### AI Agent (Claude/ChatGPT) — every query
```
user asks question → agent calls list_tables → calls describe_table →
writes query → calls query tool → gets results (hidden fields stripped) →
summarizes answer in plain language
```
Never knows hidden fields exist. Queries the sandbox, never production.
