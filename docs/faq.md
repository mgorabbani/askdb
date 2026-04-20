# FAQ

## How long does setup take?

Under 10 minutes. Paste your MongoDB or PostgreSQL URL, configure visibility, copy the MCP URL into your AI tool.

## Does AskDB write to my production database?

Never. It connects read-only to run `mongodump` (Mongo) or `pg_dump` (Postgres), then all queries go against the sandbox copy.

## How is field filtering different from data masking?

Data masking replaces values with fakes. AskDB simply omits hidden fields entirely — the AI doesn't know they exist.

## Which databases are supported?

MongoDB and PostgreSQL are both first-class today — pick the engine when you add a connection, or mix them in the same workspace. MySQL is next on the roadmap. The adapter interface is ready for more.

## How does the sandbox stay fresh?

Manual sync — click "Sync Now" in the dashboard. Scheduled sync is on the roadmap.

## Is this secure enough for production data?

AskDB enforces read-only access, field stripping at query time, query validation (allowlist only), encrypted connection strings, and full audit logging. See the [Security section in the README](../README.md#security).

## What AskDB is not

|                              |                                                                                                |
| ---------------------------- | ---------------------------------------------------------------------------------------------- |
| **Not a database.**          | AskDB stores configs and audit logs. Your data stays in MongoDB or Postgres.                   |
| **Not a BI tool.**           | No dashboards, no charts. AskDB gives AI agents structured access to your data.                |
| **Not an agent framework.**  | We don't build agents. We give them safe, controlled access to your database.                  |
| **Not a data masking tool.** | No fake data, no tokenization. Hidden fields are simply omitted from responses.                |
| **Not multi-tenant.**        | Single-user, self-hosted. Multi-user and teams are on the roadmap.                             |
