# Auth package: design

Status: accepted after council review (round 1 of 1); the sessions increment is built
(`packages/auth`).
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

Package `@effect-backend/auth`, which exports:

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
  SHA-256 hash, and returns the token and its expiry.
- `validate(token)` parses the token, then runs one `update ... returning`
  that matches the id, the hash and `expires_at > now()`. When
  `refreshed_at` is at least one refresh interval old, it sets `refreshed_at
  = now()` and `expires_at = greatest(expires_at, least(now() + idle,
  absolute_expires_at))`, so concurrent requests never move the expiry
  back. It returns the session id, or none. A malformed token, a wrong
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
the HTTP part of the package, which comes with password sign-in.

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
  table and provides the lookup that password sign-in calls, as an adapter
  in the sense of ADR 0003. The password feature defines that adapter's
  contract in its own design section.

## Tests

On the database `effect_backend_auth`, declared in `cartridge.json`:

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
