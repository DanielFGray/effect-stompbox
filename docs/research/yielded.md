# Yielded (yielded.dev) as a feature source

Read on 2026-10-31 from the source at `github.com/yielded-dev/auth` commit
`ba456e0` and `github.com/yielded-dev/sync` commit `71519bd`. Nothing here was
run.

Yielded is a set of MIT-licensed Effect v4 libraries: Auth, Sync and Agent.
All are in beta: Auth `0.1.0-beta.47`, Sync `0.1.0-beta.4`, each requiring
`effect ^4.1.0`.

## Auth

`@yielded/auth` implements sign-in in TypeScript and leaves storage to
services the app provides. This is the shape of ADR 0003: auth is a feature,
and each storage role (`Password.PasswordPersistence` and others) is a service
with adapters.

- **Methods:** passwords (Argon2id or scrypt), sessions, OAuth with about 30
  providers (GitHub, Google, Apple among them), OpenID Connect, passkeys, TOTP,
  email and phone codes.
- **Sessions:** `stateful`, `stateless` (signed token) or `stateAssisted`.
  A stateful session row holds the subject id, a SHA-256 digest of the token,
  `expiresAt` and `absoluteExpiresAt`
  (`packages/auth-persistence/src/internal/models/session-model.ts:83-88`,
  `internal/crypto.ts:14-17`).
- **Storage:** `@yielded/auth-persistence` maps auth roles onto tables the app
  names, through Effect SQL, on PostgreSQL and SQLite. The app writes the DDL.
  A Drizzle adapter can generate it instead.
- **Kysely:** Kysely can own the tables and migrations, but writes that must
  commit together have to go through the adapter's Effect SQL client
  (`docs/src/content/docs/reference/adapters.md:511-516`).
- **Contract:** one `AuthContract` gives the server routes, an `HttpClient`
  client and Effect Atom bindings.

### How it fits row-level security

The RLS pattern needs Postgres to know the current user. Today the visitor
pool sets `my.session_id`, and `current_user_id()` reads the sessions table.
If the app maps Yielded's session role onto its own `app_private.sessions`
table, `current_user_id()` can read the subject id and check `expiresAt` in
SQL, so security rule 7 still holds. The token digest is SHA-256, as in four
of the apps. This is a reading of the model, not a test.

What changes compared with the starter SQL:

- Sign-in logic leaves Postgres. Postgres keeps the tables, `current_user_id()`
  and the policies. The SQL the framework must deliver and upgrade becomes much
  smaller, and the copied, drifted auth functions (`docs/matrix/sql-drift.md`)
  are replaced by a versioned npm package.
- Auth writes go through the owner pool, not through `SECURITY DEFINER`
  functions that the visitor may call.
- Lockout and rate limits move from SQL to Yielded's own policy
  (`guide/rate-limits.md`, not yet read).
- Existing bcrypt hashes from pgcrypto would need a rehash on next sign-in.
  Yielded has `rehashIfCurrent` for parameter changes; bcrypt input support is
  not checked.

### Risks

- Beta, one organization, 47 beta releases. The API may still change.
- Its correctness claims (commit rules for custom storage, replay) are
  detailed, and a custom adapter must uphold them.
- It decides the data stack: Effect SQL for auth writes. That favours
  `SqlClient` in open decision 2.

## Sync

`@yielded/sync` keeps client state in step with server state through typed
`Source` and `Action` definitions. Its server hosts are Cloudflare Workers and
Durable Objects (also through Alchemy), and its client storage is IndexedDB.
There is no Postgres or LISTEN/NOTIFY host. Using it on the Postgres stack
means writing that host adapter. Three apps use realtime, all as SSE.

## Agent

`@yielded/agent` runs LLM agent loops with Effect AI. No surveyed app needs it.
