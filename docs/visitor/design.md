# Visitor transaction library: design

Status: revised after council review (round 1 of 1). No code exists yet. Step 2 of the plan in
`README.md`.

## What it is

A package that runs each request's queries as the visitor role, inside one
transaction, with the request's session bound for row-level security. Every
Postgres app in the survey has its own copy of this code:

| App                 | Where                                                         | How it runs queries                                    |
| ------------------- | ------------------------------------------------------------- | ------------------------------------------------------ |
| effect-web-template | `server/requestDatabase.ts`, `server/db.ts`                   | Kysely on `pg`, Promise-based, wrapped in a `DbHandle` |
| setlist             | `src/server/db.ts`, `src/server/effect-kysely.ts` (242 lines) | Kysely builders made into Effects, run by `SqlClient`  |
| dfg.rocks           | `server/db.ts` (180 lines)                                    | Kysely compiles; `SqlClient` runs the SQL              |

All three do the same four things: open a transaction on the API login's
pool, `set_config('role', <visitor>, true)`, `set_config('my.session_id',
<id>, true)`, and give the request's code a connection that stays inside that
transaction. They differ in how a query reaches the connection, and in how
database errors become domain errors.

## Decision: queries run through `SqlClient`

This settles open decision 2 of `docs/matrix/README.md`; the decision is ADR 0006.

The library runs every statement through Effect's `SqlClient`
(`effect/sql/SqlClient`, driver `@effect/sql-pg`). Reasons:

- **Transactions follow the fiber.** `SqlClient.withTransaction` stores the
  transaction's connection per client, and every statement that client runs
  inside the effect uses it. The visitor settings are transaction-local, so
  this is the property the library depends on. With `pg` directly, the
  connection must be passed by hand to every query, which is how a query
  escapes the transaction.
- **Two pools coexist.** Each `SqlClient` has its own transaction service, so
  the owner pool and the API pool can both be open in one request without
  sharing a transaction.
- **pg-sourcerer generates the table types** (step 2b) that `visitorDb` and
  `ownerDb` take, one set per role.
- **Errors arrive classified.** `SqlError` carries a reason (unique
  violation, constraint, permission, unknown) and the driver's original
  error, which holds the SQLSTATE code.

Apps write queries with Kysely through `visitorDb` and `ownerDb`, or as
`SqlClient` statements (ADR 0006). Each runner method takes the Schema of one
row; a query whose row type the Schema cannot accept does not compile, and a
row the Schema rejects at run time is a defect. Request code reaches the
visitor transaction through `VisitorTransaction`, which only `Visitor.run`
provides; a nested `withTransaction` on it is a savepoint, so a request can
recover from one failed statement.

## What the package provides

1. **Two pools.** `OwnerPool` (from `DATABASE_URL`, the migration login,
   sessions run as the owner role) and `ApiPool` (from `AUTH_DATABASE_URL`,
   the API login). Each is a `SqlClient` behind its own service tag.
2. **Startup check.** Building the `ApiPool` layer runs checks C1 and C2 of
   the security checker (`docs/checker/design.md`) and fails if either
   reports an error. A server with a wrong role setup does not start. ADR 0002
   requires this. It also checks that the API pool really connects as the
   API login (`session_user`), because C1 and C2 check roles by name and
   would pass with a URL for the migration login. The visitor role name is
   derived from the database name, as the checker does, with an optional
   override for a host whose roles use other names; the check then runs on
   the role that requests use. The checks run on the API pool, so the visitor library itself needs no
   owner pool. The API login can
   read every catalog the checks use (`pg_roles`, `pg_shdepend`,
   `pg_default_acl`, `pg_policy`, the ACL columns), and gets the same counts
   as a superuser on the setlist corpus database.
3. **`RequestSession`** (ADR 0004). A service with one method that returns
   the current request's session id as an `Option`. The auth implementation
   provides it; the library only reads it.
4. **`Visitor.run(effect)`.** Opens a transaction on `ApiPool`, sets the role
   and `my.session_id`, and runs `effect` with `SqlClient` provided as the API
   pool's client, so every query in it joins the transaction. The role name is
   a trusted value and is passed to `set_config` as a bound parameter, like
   the session id; neither is ever interpolated into SQL text. Three rules
   bound it:
   - **A fiber that outlives `Visitor.run` cannot query on its
     connection.** The transaction's connection travels in the fiber's
     context, and a forked fiber copies that context. If such a fiber could
     still use the connection after the pool gave it to the next request, its
     queries would run as another visitor with another session.
     `@effect/sql-pg` already refuses this: each transaction holds a lease on
     the connection, and a statement on a released lease fails with a
     connection error (`PgConnection.ts`, "Pinned connection was released").
     The library adds no check of its own; the escape tests keep the driver
     to this, and a different driver must pass the same tests. Work that must
     happen after the request uses `SqlClient`'s `afterCommit`, which removes
     the transaction from the context.
   - **`Visitor.run` does not nest.** A nested `withTransaction` is a
     savepoint, and `set_config(..., true)` inside it stays in force for the
     outer transaction, so a nested call with another session would change
     the outer request's identity. A nested `Visitor.run` fails as a defect.
     Ordinary nested transactions inside one `Visitor.run` stay allowed.
   - **Errors are mapped outside the transaction.** A failed statement aborts
     the Postgres transaction even when the code catches the mapped error, so
     `Visitor.run` rolls back first and maps after. Errors raised at commit
     (deferred constraints) are mapped the same way. Code that must recover
     from a failed statement and keep querying opens a nested transaction
     (a savepoint) around it.

   Limit: SQL that runs as the visitor can run `RESET ROLE` and return to the
   API login. The library runs only SQL the app wrote, so this is safe as
   long as no request can supply SQL text.

5. **Error mapping.** `visitorDb` and `ownerDb` fail with `DatabaseError`,
   whose `PostgresReport` (code, message, detail, hint, constraint) is
   decoded from the driver error once, with a Schema. The apps raise their
   own 5-letter codes (for example `CREDS`, `TAKEN`) from SQL functions; those
   arrive as `UnknownError` with the code on the driver error. A service maps
   the codes it reacts to with `onSqlState({ CODE: (error) => DomainError })`;
   every other `DatabaseError` passes through to the handler's answer table
   (`docs/http/design.md`), which answers it or lets it die as a 500.
   `onSqlState` replaces `mapSqlState`, which made every unlisted code a
   defect at the service, so standard codes (unique, foreign key, row-level
   security) had to be listed in each service. Decided by the user on
   2026-11-13.

Outside a request, code uses `OwnerPool` explicitly. There is no default that
quietly runs as the owner: setlist's `Kysely` service defaults to the owner
pool (`src/server/db.ts:60-67`), so a service that forgets `withAuthContext`
runs with the owner's rights and no row-level security. The library makes
that impossible: `Visitor.run` is the only provider of the visitor's
`SqlClient`, and the owner's client has a different tag.

## Not in this step

- Typed handles that restrict a query to what the visitor may reach. They
  need pg-sourcerer's visitor model, which first needs the role inheritance
  fix filed for pg-sourcerer. They follow as step 2b.
- Auth functions and session tables (step 3).
- Migrating any app.

## How we know it works

Tests run against a database of their own, `stompbox_visitor`,
declared in `cartridge.json` so `ops dev db up` gives it the real role
contract.
Each test creates its own small schema with a table under row-level security
and a policy on `my.session_id` (the stand-in for `current_user_id()`, which
step 3 provides), and drops it after.

1. A query inside `Visitor.run` sees only the rows its session may see.
2. After `Visitor.run` returns, the same pooled connection runs as the API
   login again, with `my.session_id` empty: run 50 alternating requests for
   two sessions on a pool of size 1 and check every result.
3. A failure inside `Visitor.run` rolls back, and the next request on that
   connection is clean.
4. A query on `OwnerPool` inside `Visitor.run` does not join the visitor
   transaction.
5. The startup check refuses a database where the API login inherits the
   visitor role. Run by hand, because planting the fault needs a superuser:
   granting the visitor role to the API login with `inherit true` made the
   startup check fail with C1, and it started again after the grant was
   restored. The automated test plants a fault the API login can cause
   itself: a `DATABASE_VISITOR` override naming a role it cannot switch to.
6. A function that raises `CREDS` maps to the caller's tagged error, and a
   caller that names `23505` gets its tagged error for a unique violation;
   an unmapped error becomes a defect. A deferred constraint that fails at
   commit maps the same way.
7. Queries run concurrently inside `Visitor.run` (`Effect.all` with
   concurrency) all run on the transaction's one connection, in order, and
   all see the visitor's rows.
8. The escape test: on a pool of size 1, a request forks a fiber that
   queries after a delay, then returns; a second request for another session
   runs. The forked fiber's query must never run inside the second request's
   transaction. Repeat with the first request failing and with it
   interrupted.
9. A nested `Visitor.run` fails, and the outer request's session is
   unchanged.
10. The startup check refuses an API pool URL that connects as the migration
    login.
11. Work registered with `afterCommit` can start a new `Visitor.run`, and it
    sees the committed rows.

Then the checker passes on the test database.

The visitor library does not need the owner pool. The auth package does: its
`Sessions` service checks each request's session on it (`docs/auth/design.md`).

Row-level security limits what the visitor's queries return at run time.
It does not stop code from writing a query against a table the visitor
cannot reach; that query fails only when it runs. The typed handles of the
follow-up step close that gap at compile time, and until they ship it stays
open.

## Package layout

A bun workspace with `packages/checker` (library and CLI) and
`packages/visitor`. The visitor package imports C1 and C2 from the checker
for its startup check.

## Session id type

The apps store UUIDs; Yielded uses its own ids. The bridge passes text, and
`current_session_id()` casts.
