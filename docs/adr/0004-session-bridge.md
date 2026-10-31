---
status: proposed
---

# Auth implementations meet row-level security at one session bridge

An app can choose how sign-in works: the SQL auth functions from
graphile-starter, or Yielded Auth (`docs/research/yielded.md`). Row-level
security must work the same with either. The project therefore fixes only
the point where the two meet Postgres, called the session bridge, and treats
each sign-in system as an adapter behind it.

## The session bridge

The bridge has one SQL side and one TypeScript side.

**SQL side.** Policies refer only to these two functions, which every auth
implementation must provide:

- `app_public.current_session_id()` reads the transaction setting
  `my.session_id`.
- `app_public.current_user_id()` returns the user of that session, or null
  when the session does not exist, is revoked, or has expired. It checks
  expiry in SQL (security rule 7). It is `SECURITY DEFINER` with a fixed
  `search_path` (security rule 4).

The template's `current_user_id()` does not check expiry yet
(`effect-web-template/migrations/current/0110-sessions.sql:69-71`).

**TypeScript side.** A service, here called `RequestSession`, turns the
current request into an optional session id. The visitor pool's transaction
sets `my.session_id` from it and switches to the visitor role. The project
owns that transaction; the auth implementation provides `RequestSession`.

## The two implementations

|                          | Starter SQL                         | Yielded Auth                                            |
| ------------------------ | ----------------------------------- | ------------------------------------------------------- |
| Sign-in logic            | SQL functions the visitor calls     | TypeScript, Yielded package                             |
| Writes                   | `SECURITY DEFINER` functions        | Owner pool, through Effect SQL                          |
| Sessions table           | `app_private.sessions`              | Yielded session role mapped onto `app_private.sessions` |
| Password hash            | bcrypt in pgcrypto                  | Argon2id or scrypt                                      |
| `RequestSession`         | cookie `id.secret`, SHA-256 lookup  | `getSession()` from Yielded                             |
| HTTP contract and client | package `HttpApi` group             | Yielded `AuthContract` and client                       |
| Apps that use it         | dfg.rocks, setlist, postgres.garden | none                                                    |

Both share the users table: Yielded maps its subject onto the app's
`app_public.users`.

## Consequences

- Policies, app SQL and visitor-scoped services do not change when an app
  picks the other implementation.
- The frontend does change: each implementation has its own HTTP endpoints and
  client. The choice is made when an app starts. Moving an existing app from
  one to the other is a data migration (password hashes, session rows) plus a
  frontend change, not a configuration switch.
- Each implementation must pass the same bridge tests: a valid session gives
  its user; an expired, revoked or unknown session gives null; and the
  visitor role cannot read the sessions table.
- Two implementations double the auth code that must be kept secure. Under
  ADR 0003 a second adapter ships only when an app uses it. Yielded Auth has
  no app yet, so it ships after the spike shows the bridge works and one app
  or the reference app adopts it.
