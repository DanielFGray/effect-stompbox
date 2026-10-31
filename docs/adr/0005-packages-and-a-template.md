---
status: accepted
---

# Packages for what Postgres buys; a template for the rest

Every assumption the project makes buys a guarantee. Assuming Postgres buys
row-level security, visitor handles typed to what the visitor may reach, and
auth SQL that runs in the same transaction as the data. Effect alone cannot
give these, and they are where the survey found five of its nine bugs. The
other concerns (config, `HttpApi`, telemetry, rate limits, SSE, the choice of
Bun or Node) are already covered by Effect, and wrapping them would add a layer
that only renames Effect. Decided by the user on 2026-10-31.

The product is therefore two kinds of thing:

- **Packages** own the security-critical code and SQL: the security checker,
  the visitor transaction library, and auth with its SQL. They carry versions,
  so a fix reaches every app through an upgrade.
- **A template** holds the rest as plain Effect code that the app owns after
  it copies the template. The reference app is built from it.

## Considered options

- **A copied starter only** (graphile-starter's model). Each copy drifts, and
  fixes do not spread: `docs/matrix/sql-drift.md` shows four copies of the
  same auth SQL in up to five versions.
- **A framework that wraps Effect** with a stack layer and adapters for every
  database. It loses the Postgres guarantees, and what remains is Effect.

## Consequences

- No package exports a stack layer. The template composes its own layers.
- An app can drop any package and keep the others, because each is ordinary
  Effect code behind its own service.
- The security checker comes first: it works on existing apps with no
  migration, and it gives every later step a test.
