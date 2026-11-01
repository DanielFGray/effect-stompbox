---
status: accepted
---

# Queries run through Effect's SqlClient

Every query the framework runs goes through Effect's `SqlClient`
(`effect/sql`, driver `@effect/sql-pg`). Apps write queries with Kysely: the
framework compiles each Kysely builder and runs the SQL through `SqlClient`
(`VisitorDb` and `OwnerDb`). A plain `SqlClient` statement also works.

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
- **Plain `SqlClient` statements only.** Rejected after the knowledgebase
  port (`examples/knowledgebase/`): all five Postgres apps write Kysely, and
  a wrong column in a `SqlClient` statement is a runtime error, not a compile
  error. Kysely with table types per role (step 2b) makes a query outside the
  visitor's reach a compile error.
- **Reylo** (typed `.sql` files). Rejected: it decodes rows itself and runs
  only on the drivers it lists, and `@effect/sql-pg` is not one of them.

## Consequences

- An app that adopts the package keeps its Kysely queries and drops its own
  bridge (setlist and dfg.rocks each have one).
- `SqlError` arrives classified, and the driver's SQLSTATE code is on its
  cause, which `mapSqlState` reads.
- `@effect/sql-pg` refuses a statement on a released connection lease, so a
  fiber that outlives a request cannot query in the next request's
  transaction. The visitor package's tests hold the driver to this; another
  driver must pass the same tests.
