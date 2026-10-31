---
status: accepted
---

# Queries run through Effect's SqlClient

Every query the framework runs goes through Effect's `SqlClient`
(`effect/sql`, driver `@effect/sql-pg`), and apps write their queries as
`SqlClient` statements. The framework ships no query builder.

The visitor role and the session are transaction-local settings, so every
query of a request must run on the transaction's connection. `SqlClient`
keeps that connection in the fiber's context, so a query cannot leave the
transaction by mistake, and each pool has its own transaction, so the owner
pool and the API pool never share one. With `pg` used directly, each query
must be handed the connection by hand, and one that is not runs outside the
visitor role.

## Considered options

- **`pg` with Kysely's own driver**, as three apps run today. Rejected for
  the reason above.
- **Kysely compiled, run through `SqlClient`**, as setlist and dfg.rocks do.
  Deferred: it adds a second way to write a query before the first is
  proven. An adapter can be added later without changing this decision.
- **Reylo** (typed `.sql` files). Rejected: it decodes rows itself and runs
  only on the drivers it lists, and `@effect/sql-pg` is not one of them.

## Consequences

- An app that adopts the package rewrites its Kysely queries as `SqlClient`
  statements, or keeps its own bridge as setlist and dfg.rocks do today.
- `SqlError` arrives classified, and the driver's SQLSTATE code is on its
  cause, which `mapSqlState` reads.
- `@effect/sql-pg` refuses a statement on a released connection lease, so a
  fiber that outlives a request cannot query in the next request's
  transaction. The visitor package's tests hold the driver to this; another
  driver must pass the same tests.
