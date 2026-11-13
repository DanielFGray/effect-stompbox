# knowledgebase on the framework

This is the server of `~/build/knowledgebase` written as it should read on
the framework, before the framework can run it. Each import that does not
compile names a part the framework must add. When `tsc -p
examples/knowledgebase` passes and `test/Tasks.test.ts` passes, the
framework fits the app (README step 4).

The slice covers what touches the framework: delivery, register, sign-in,
sign-out, the profile, and tasks. Notes, the graph, embeddings and realtime
stay app code and move over unchanged once the slice works.

What changes for the app:

- **No query names the user.** Today every service adds `where account_id =
  …`. Here the request runs as the visitor, `tasks.account_id` defaults to
  `auth.current_user_id()`, and a policy limits every statement to the
  user's rows.
- **The app keeps only the username.** `auth.users`, password hashes and
  sessions belong to the auth package. The app's `accounts` table holds the
  username, finds the user id by it, and passes the id to password sign-in.
- **No cookie code.** The auth package sets, reads and clears the session
  cookie.

## What the framework must add

Check: `bunx tsc --noEmit -p examples/knowledgebase` lists each missing part.

1. **Done: `visitorDb` and `ownerDb`** (`@danielfgray/stompbox/visitor`): run
   Kysely builders through the pool's `SqlClient` and decode each row with a
   Schema (ADR 0006), as `db.all(Schema, (k) => ...)`. A `visitorDb` query needs the transaction that only `Visitor.run` provides,
   so one outside a request does not compile. setlist's
   `src/server/effect-kysely.ts` is the prior art.
2. **Table types per role** (step 2b): `VisitorTables` holds only what the
   visitor may reach, so a query outside that does not compile.
   `OwnerTables` holds everything.
3. **Done: the `passwords` feature and `Passwords`** (`@danielfgray/stompbox/auth`):
   `createUser`, `set` and `signIn`. SQL hashes with Argon2id (pgsodium),
   hashes once for an unknown user, and counts failures; `signIn` creates a
   new session every time.
4. **Dropped: `UserDirectory`.** The app finds the user id by name in its
   own table and passes it to `signIn` (`docs/auth/design.md`).
5. **Done: `@danielfgray/stompbox/auth/api`**, safe to import in the browser: the
   `SignedIn` middleware, `CurrentSession`, and the errors
   `InvalidCredentials` (401) and `AccountLocked` (429).
6. **Done: `@danielfgray/stompbox/auth/http`**: `SignedInLive`, which reads the cookie,
   validates the session, provides `CurrentSession`, and runs the handler in
   one visitor transaction; and `SessionCookie.set` and `.clear`.
7. **Dropped: `OwnerPool.sqlClient`.** `migrate.ts` gives `deliver` the owner
   pool with `Effect.provideService(SqlClient, owner)` for that one call, so
   no request code gets the owner as its `SqlClient`.
8. **Done: `@danielfgray/stompbox/testing`**: `TestApp.layer(app, { features,
   surface })` resets a database whose name ends in `_test`, delivers the
   features, runs checks C1 to C8, and runs the app in process.
   `TestApp.client(api)` gives a typed client with its own cookie jar, so
   each client is one browser. The client takes the API as an argument,
   because a service cannot carry the API's type.

## Open questions this slice raises

- **Recovering from a database error inside a request.** Answered: a
  nested `withTransaction` on `VisitorTransaction` is a savepoint, and the
  visitor package tests that a request recovers from one failed statement.
- **Long requests.** The events stream must not hold a visitor transaction
  open. It stays outside `SignedInLive`, and needs its own session check.
- **Rate limits.** knowledgebase, setlist and dfg.rocks each limit sign-in
  differently (an SQL table, Valkey, memory). That makes it an extension
  point; it is out of this slice.
