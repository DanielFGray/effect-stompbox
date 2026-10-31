---
status: accepted
---

# Auth, migrations and the worker require Postgres

The framework is built for Postgres, graphile-migrate and graphile-worker. Its
auth is SQL that runs inside Postgres: functions, row-level security policies
and grants. The SQLite apps (twitter-bookmarks, budget) have no users and no
auth, so supporting SQLite there would serve no app (`docs/matrix/README.md`).
Decided by the user on 2026-10-31.

## Consequences

- An app on SQLite can use only the parts that do not need Postgres: the
  runtime layer, config, the `HttpApi` contract and telemetry. It gets no auth,
  no migrations and no worker.
- A SQLite mode is allowed later, but it must not change the Postgres design.
- SQLite drivers are specific to the runtime (`@effect/sql-sqlite-bun`,
  `@effect/sql-sqlite-node`), so a SQLite mode needs one driver layer per
  runtime. The Postgres driver runs on both.
