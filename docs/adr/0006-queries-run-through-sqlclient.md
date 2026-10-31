---
status: accepted
---

# Queries run through Effect's SqlClient

Every query the framework runs goes through Effect's `SqlClient`
(`effect/sql`, driver `@effect/sql-pg`). Kysely stays the query builder the
apps write in, through an adapter that compiles a builder and runs the
compiled SQL on `SqlClient`. The visitor package does not depend on Kysely.

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

## Consequences

- The effect-web-template, dfg.codes and postgres.garden change how their
  queries run when they adopt the package; their Kysely queries stay.
- setlist and dfg.rocks already run this way, each with its own bridge; one
  shared adapter replaces both.
- `SqlError` arrives classified, and the driver's SQLSTATE code is on its
  cause, which `mapSqlState` reads.
- `@effect/sql-pg` refuses a statement on a released connection lease, so a
  fiber that outlives a request cannot query in the next request's
  transaction. The visitor package's tests hold the driver to this; another
  driver must pass the same tests.
