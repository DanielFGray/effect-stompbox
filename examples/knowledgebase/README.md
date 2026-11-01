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
  username, and `AccountDirectory` tells password sign-in how to find a user
  by it.
- **No cookie code.** The auth package sets, reads and clears the session
  cookie.

## What the framework must add

Check: `bunx tsc --noEmit -p examples/knowledgebase` lists each missing part.

1. **Done: `visitorDb` and `ownerDb`** (`@effect-backend/visitor`): run
   Kysely builders through the pool's `SqlClient` and decode each row with a
   Schema (ADR 0006). The example code still uses an earlier sketch
   (`VisitorDb.of`); the real form is `db.all(Schema, (k) => ...)`. A `visitorDb`
   query needs the transaction that only `Visitor.run` provides,
   so one outside a request does not compile. setlist's
   `src/server/effect-kysely.ts` is the prior art.
2. **Table types per role** (step 2b): `VisitorTables` holds only what the
   visitor may reach, so a query outside that does not compile.
   `OwnerTables` holds everything.
3. **The `passwords` feature and `Passwords`** (`@effect-backend/auth`):
   `createUser`, `signIn`, and later `changePassword`. Argon2id through
   Effect's `Kdf` (`BunCrypto.layerKdf`), a dummy hash for an unknown user,
   and a new session at every sign-in.
4. **`UserDirectory`** (`@effect-backend/auth`): the adapter the app provides
   to find a user by the name it signs in with.
5. **`@effect-backend/auth/api`**, safe to import in the browser: the
   `SignedIn` middleware and the `InvalidCredentials` error.
6. **`@effect-backend/auth/http`**: `SignedInLive`, which reads the cookie,
   validates the session, provides `CurrentSession`, and runs the handler in
   one visitor transaction; and `SessionCookie.set` and `.clear`.
7. **`OwnerPool.sqlClient`**: a layer that gives `deliver` the owner pool as
   its `SqlClient`, for the migrate entry point.
8. **`@effect-backend/testing`**: `TestApp`, which delivers the features into
   the test database, runs the app in process, and gives each client its own
   cookie jar.

## Open questions this slice raises

- **Recovering from a database error inside a request.** Answered: a
  nested `withTransaction` on `VisitorTransaction` is a savepoint, and the
  visitor package tests that a request recovers from one failed statement.
- **Long requests.** The events stream must not hold a visitor transaction
  open. It stays outside `SignedInLive`, and needs its own session check.
- **Rate limits.** knowledgebase, setlist and dfg.rocks each limit sign-in
  differently (an SQL table, Valkey, memory). That makes it an extension
  point; it is out of this slice.
