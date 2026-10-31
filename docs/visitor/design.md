# Visitor transaction library: design

Status: draft for council review. No code exists yet. Step 2 of the plan in
`README.md`.

## What it is

A package that runs each request's queries as the visitor role, inside one
transaction, with the request's session bound for row-level security. Every
Postgres app in the survey has its own copy of this code:

| App | Where | How it runs queries |
|---|---|---|
| effect-web-template | `server/requestDatabase.ts`, `server/db.ts` | Kysely on `pg`, Promise-based, wrapped in a `DbHandle` |
| setlist | `src/server/db.ts`, `src/server/effect-kysely.ts` (242 lines) | Kysely builders made into Effects, run by `SqlClient` |
| dfg.rocks | `server/db.ts` (180 lines) | Kysely compiles; `SqlClient` runs the SQL |

All three do the same four things: open a transaction on the API login's
pool, `set_config('role', <visitor>, true)`, `set_config('my.session_id',
<id>, true)`, and give the request's code a connection that stays inside that
transaction. They differ in how a query reaches the connection, and in how
database errors become domain errors.

## Decision: queries run through `SqlClient`

This settles open decision 2 of `docs/matrix/README.md`, and gets its own ADR
(0006).

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
- **pg-sourcerer generates `SqlClient` code**, which step 2's typed handles
  will use.
- **Errors arrive classified.** `SqlError` carries a reason (unique
  violation, constraint, permission, unknown) and the driver's original
  error, which holds the SQLSTATE code.

A query builder is optional and sits on top. Kysely stays usable the
dfg.rocks way: compile the builder, run the compiled SQL through `SqlClient`.
The library does not depend on Kysely; a small adapter module does.

## What the package provides

1. **Two pools.** `OwnerPool` (from `DATABASE_URL`, the migration login,
   sessions run as the owner role) and `ApiPool` (from `AUTH_DATABASE_URL`,
   the API login). Each is a `SqlClient` behind its own service tag.
2. **Startup check.** Building the `ApiPool` layer runs checks C1 and C2 of
   the security checker (`docs/checker/design.md`) and fails if either
   reports an error. A server with a wrong role setup does not start. ADR 0002
   requires this. The checks run on the API pool, because an app that signs
   in through SQL functions needs no owner pool at runtime. The API login can
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
   the session id; neither is ever interpolated into SQL text.
5. **Error mapping.** A function that turns `SqlError` into the app's tagged
   errors by SQLSTATE code, for the codes the caller names; every other
   database error becomes a logged defect. The apps raise their own 5-letter
   codes (for example `CREDS`, `TAKEN`) from SQL functions; those arrive as
   `UnknownError` with the code on the driver error, so the mapping decodes
   the code with a Schema, not a type guard.

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

Tests run against a database of their own, `effect_backend_visitor`,
declared in `cartridge.json` so `ops dev db` gives it the real role contract.
Each test creates its own small schema with a table under row-level security
and a policy on `current_user_id()`, and drops it after.

1. A query inside `Visitor.run` sees only the rows its session may see.
2. After `Visitor.run` returns, the same pooled connection runs as the API
   login again, with `my.session_id` empty: run 50 alternating requests for
   two sessions on a pool of size 1 and check every result.
3. A failure inside `Visitor.run` rolls back, and the next request on that
   connection is clean.
4. A query on `OwnerPool` inside `Visitor.run` does not join the visitor
   transaction.
5. The startup check refuses a database where the API login inherits the
   visitor role.
6. A function that raises `CREDS` maps to the caller's tagged error; an
   unmapped error becomes a defect.
7. Queries run concurrently inside `Visitor.run` (`Effect.all` with
   concurrency) all run on the transaction's one connection, in order, and
   all see the visitor's rows.
8. A fiber forked inside `Visitor.run` that queries after the transaction
   ends does not run as the visitor: it fails, or it runs on a fresh
   connection as the API login. Which one happens decides whether `Visitor.run`
   must forbid such forks; the test records it.

Then the checker passes on the test database, and the effect-web-template's
`requestDatabase.ts` can be rewritten on the library in a throwaway branch
with no change to its services' code beyond imports. That port is evidence,
not a migration.

## Open questions

- **Package layout.** The startup check reuses C1 and C2, so the checker's
  role module must be a library the visitor package imports. Proposed: a bun
  workspace with `packages/checker` (library and CLI) and `packages/visitor`.
- **Visitor role name.** Read from `DATABASE_VISITOR`, as the apps do, or
  derive it from the database name, as the checker does? Deriving removes a
  setting that can disagree with the database; reading it supports a host
  whose roles do not follow the provisioner's names.
- **Session id type.** The apps store UUIDs; Yielded uses its own ids. The
  bridge passes text, and `current_session_id()` casts.
