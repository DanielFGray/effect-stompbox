# Auth package: design

Status: accepted after council review (round 1 of 1); the sessions increment is built
(`src/auth`).
Step 3 of the plan in `README.md`, second half. This document covers the
first increment: the users and sessions tables and the session bridge of
ADR 0004. Password sign-in, email, and OAuth come later as their own
features, each with its own section here before its code.

## The problem

Every surveyed Postgres app with row-level security keeps its own copy of the
same session SQL, and the copies differ (`docs/matrix/sql-drift.md`):

- `current_session_id` exists in three versions and `current_user_id` in two.
- The template's `current_user_id()` does not check expiry
  (`effect-web-template/migrations/current/0110-sessions.sql:69-71`), so a
  policy accepts an expired session if the server sets its id.
- Session lifetimes are fixed in SQL functions, so an app that wants another
  lifetime edits its copy.

## What the increment ships

Subpath `@danielfgray/stompbox/auth`, which exports:

1. **The feature `auth`**, a directory of migrations for the runner
   (ADR 0007). Later auth features depend on it.
2. **The service `Sessions`**: create, validate and revoke sessions, on the
   owner pool.
3. **The bridge tests** of ADR 0004, run against the feature.

## The SQL of the feature `auth`

Terms:

- **Session token**: the value the browser holds, `<id>.<secret>`. `id` is
  the session's uuid; `secret` is 32 random bytes, hex-encoded.
- **Idle expiry**: a session ends when it is unused for this long. Using it
  moves its end forward.
- **Absolute expiry**: a session ends at this time, used or not.

Objects:

1. Schemas `auth` (the visitor may use it) and `auth_private` (it may not).
2. `auth.users (id uuid primary key default gen_random_uuid(), created_at
   timestamptz)`. It holds identity only. Profile columns (username, name,
   avatar) differ in every app, so the app keeps them in its own table with a
   foreign key to `auth.users(id)`. The visitor has no grant on `auth.users`.
3. `auth_private.sessions (id uuid primary key, user_id uuid references
   auth.users on delete cascade, secret_hash bytea, created_at, refreshed_at,
   expires_at, absolute_expires_at)`, every column `not null`, with
   row-level security on and no grant to the visitor. Check constraints:
   the hash is 32 bytes, and `created_at <= refreshed_at`, `refreshed_at <
   expires_at`, `expires_at <= absolute_expires_at`. One comparison,
   `expires_at > now()`, decides whether a session is live. An index on
   `user_id` serves `revokeAll` and the cascade from `auth.users`.
4. `auth.current_session_id() returns uuid`: the session named by the
   transaction setting `my.session_id` when that session is live, otherwise
   null. Only the server sets the setting, after `validate`, so a value that
   is not a uuid is a server bug and the cast raises an error.
5. `auth.current_user_id() returns uuid`: the user of that live session, or
   null.

Both functions are `SECURITY DEFINER` with `search_path = pg_catalog,
pg_temp` (C7), executable by the visitor and not by PUBLIC. Both mean "the
live session", so a policy gets the same answer from either.

The visitor reaches exactly: usage on `auth`, and execute on the two
functions. The feature needs no extension: `gen_random_uuid()` and
`sha256()` are built into Postgres 13 and later.

## The service `Sessions`

The server, not SQL, creates and checks sessions, on the owner pool. The
template already works this way: its SQL `login` returns a user and the
server creates the session.

- `create(userId)` makes a secret with Effect's `SecureRandom`, stores its
  SHA-256 hash, and returns the token, its idle expiry and its absolute
  expiry.
- `validate(token)` parses the token, then runs one `update ... returning`
  that matches the id, the hash and `expires_at > now()`. When
  `refreshed_at` is at least one refresh interval old, it sets `refreshed_at
  = now()` and `expires_at = greatest(expires_at, least(now() + idle,
  absolute_expires_at))`, so concurrent requests never move the expiry
  back. It returns the session id and its user id, or none. A malformed token, a wrong
  secret, and an expired, revoked or unknown session all give none. A
  revoke that commits first wins; the update then matches no row.
- `deleteExpired` deletes sessions whose `expires_at` has passed. The app's
  worker runs it on a schedule.
- `revoke(sessionId)` deletes one session; `revokeAll(userId)` deletes all
  of a user's sessions.

The three lifetimes (idle 7 days, absolute 30 days, refresh 1 hour) come from
`Config` with these defaults, so an app changes them without editing SQL.
`Config` refuses a lifetime that is not positive, and a refresh interval
that is not shorter than the idle lifetime. A change applies to later
refreshes; each session keeps the absolute expiry it was created with.

Reading the cookie and providing `RequestSession` for each request belongs to
the HTTP part of the package (below).

## Choices made

- **The server makes the secret, not SQL.** SQL would need `pgcrypto`'s
  `gen_random_bytes`, and the host creates extensions in a schema the package
  does not control (ADR 0002), which a function with a fixed `search_path`
  cannot find by name.
- **One id, not a separate cookie id.** The template stores a public
  `cookie_id` beside the uuid. The secret already protects the token, and
  `my.session_id` is set only by the server after `validate`, so a second id
  adds a column and an index without adding a check.
- **Revoke deletes the row.** No app keeps revoked sessions.
- **Sessions run on the owner pool.** The owner login already does runtime
  work (the worker, ADR 0002), and the template validates sessions on it.
  The API login cannot hold the functions instead, because C1 forbids it
  any direct privilege. The visitor cannot hold them either: a visitor that
  can create a session can sign in as any user.
- **Expiry is checked in SQL**, in `current_user_id()`, so a policy never
  sees an expired session even if the server sets its id (security rule 7).

## Decided for later features

- **The app owns the username.** It keeps the username in its own profile
  table, finds the user id itself, and passes it to password sign-in (see
  the feature `passwords`).

## The feature `passwords`

Password sign-in follows graphile-starter: SQL hashes, checks and counts
failed attempts; the server creates the session. It depends on `auth`.

Terms:

- **Lockout**: after 3 failed attempts within 5 minutes, sign-in for that
  user fails with SQLSTATE `LOCKD` until the window passes.

Objects:

1. `auth_private.passwords (user_id uuid primary key references auth.users
   on delete cascade, hash bytea not null, failed_attempts int not null,
   first_failed_at timestamptz, updated_at timestamptz not null)`, with
   row-level security on and no grant to the visitor. A user with no
   password has no row, so no code path compares against a null hash.
2. `auth_private.set_password(user_id uuid, password text) returns void`:
   stores the Argon2id hash and clears the failure count.
3. `auth_private.check_password(user_id uuid, password text) returns
   boolean`: raises `LOCKD` during a lockout; returns false for a wrong
   password, an unknown user or a user with no password; returns true and
   clears the failure count for the right one. A wrong password records
   the failure and returns false instead of raising, so the record commits.
   An unknown user still costs one hash, so the reply time does not show
   whether the user exists.

The hash is `pgsodium.crypto_pwhash_str` (Argon2id, libsodium's
interactive limits), checked with `crypto_pwhash_str_verify`. The functions
need no pgsodium server key. pgsodium is not a trusted extension, so the
host provisioner creates it as a superuser (ADR 0002); the runner does not.
The host also takes `PUBLIC`'s usage on the schema `pgsodium` away and gives
it to the owner, so the visitor cannot call pgsodium (check C3).
pgsodium has its own fixed schema `pgsodium`, so the functions name it under
a fixed `search_path`. The stored value is the 128-byte result as returned,
NUL padding included, because `crypto_pwhash_str_verify` reads it as a C
string.

The password reaches Postgres in plaintext. The server always binds it as a
parameter, never in SQL text, and the host keeps it out of the server log
(ADR 0002).

The service `Passwords`, on the owner pool:

- `createUser(password)` inserts a user and its password and returns the
  user id. The caller runs it in its own owner transaction with the app's
  profile insert, so a failed profile insert leaves no user.
- `set(userId, password)` sets or replaces a password.
- `signIn(userId: Option<string>, password)` checks the password and
  creates a session. It fails with `InvalidCredentials` or `AccountLocked`.
  The app finds the user id from the name the user typed; none means no
  such user. The caller must not run it inside a transaction that rolls
  back on `InvalidCredentials`: the rollback would also remove the failure
  record, and the lockout would never start.

Password rules (length, breached-password lists) belong to the app's API
schema; the feature stores any password the app accepts.

`AccountLocked` is a separate error, as in graphile-starter, so a caller
learns that a name exists after 3 failed attempts: an unknown user never
locks. The app can answer both errors the same way if that matters to it.

## The HTTP part

Two entry points, so a browser bundle never imports server code:

1. **`@danielfgray/stompbox/auth/api`** imports only `effect` (and types from the
   visitor package). It holds what the browser and the server share:
   - `SignedIn`, an `HttpApiMiddleware` with the security scheme "API key in
     the cookie `__Host-session`". It provides `CurrentSession` and
     `VisitorTransaction` to the endpoints it guards, and fails with
     `Unauthorized` (401) when the request has no live session.
   - `CurrentSession`: the request's `{ sessionId, userId }`.
   - `InvalidCredentials` (401) and `AccountLocked` (429).
2. **`@danielfgray/stompbox/auth/http`**, server only:
   - `SignedInLive`, the layer that implements `SignedIn` with `Sessions`
     and `Visitor`.
   - `SessionCookie.set(session)` and `SessionCookie.clear`, for the
     handlers that sign in and sign out.

`SignedInLive` validates the cookie's token, then runs the endpoint in one
`Visitor.run`, with `RequestSession` set to the session id. The endpoint's
payload decoding, handler and response encoding are all inside that one
transaction, so a typed error from the handler rolls the transaction back
and still reaches the client with its own status. A database error at
begin or commit fails `SignedIn` with `DatabaseError`, which `SignedIn`
declares, so an app that uses it needs the boundary from
`@danielfgray/stompbox/http/server` to answer it; without one the client
receives the `DatabaseError` itself, with Postgres's message and report. A streaming response body is read after
the transaction ends, so a streaming endpoint must not use `SignedIn`.

The cookie:

- Its name has one source: the security scheme on `SignedIn`.
- `__Host-` makes the browser refuse it unless it is `Secure`, has `Path=/`
  and no `Domain`, so a sibling subdomain cannot set it. The app is served
  over HTTPS. Chrome and Firefox also accept a `Secure` cookie from
  `http://localhost`; for local development in another browser, serve
  HTTPS.
- `HttpOnly`, so page scripts cannot read the token; `SameSite=Lax`, so a
  cross-site form post does not carry it.
- It expires at the session's absolute expiry. `validate` never moves the
  absolute expiry, so no request needs to set the cookie again; an idle
  session that ended leaves a cookie that validates to none.
- `clear` sends the same name, `Path` and `Secure` with an expiry in the
  past, or the browser keeps the old cookie.

A sign-in always creates a new session and sets the cookie; it never reuses
the session the browser sent.

## Tests

On the database `stompbox_auth`, declared in `cartridge.json`:

1. A valid session gives its user from `auth.current_user_id()` inside a
   visitor run; an expired, revoked or unknown session gives null; no session
   gives null.
2. The visitor cannot read `auth_private.sessions` or `auth.users`.
3. `validate`: a wrong secret, a malformed token and an expired session give
   none. A session used after the refresh interval moves `expires_at`, and
   never past `absolute_expires_at`. Two concurrent validations leave the
   later expiry. A revoked session validates to none. Time comes from the
   database: the test moves a session's times, it does not wait.
4. The checker's C3 against a reviewed surface list, C4, and C5 to C8 pass
   after the feature is installed.
5. Through the HTTP entry points, in process: sign-in sets the cookie with
   the attributes above and the absolute expiry; a missing, malformed,
   wrong or revoked session gives 401; a private handler sees its own user
   in `auth.current_user_id()`; a typed handler error keeps its status;
   sign-out revokes the session and clears the cookie.
