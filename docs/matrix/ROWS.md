# Matrix rows and cell rules

Every app file in `docs/matrix/apps/` uses these rows, in this order, so the
files join into one table.

## Cell states

Each row starts with one state:

- **present**: the app has it. Describe what it does.
- **absent**: the app could have it but does not.
- **N/A**: the row cannot apply (for example, RLS rows in a SQLite app).

Then describe the implementation. Cite every claim as `path:line` in the app
repo. Cite a bug fix as a commit SHA with one line on what it fixed. Find bug
fixes with `git log -p --follow` on the files behind each row.

Describe what exists. Do not compare with another app or the template; the
comparison happens later, across all files.

## Rows

1. **Runtime and HTTP layer**: Bun or Node, platform package, HTTP server and
   router (`HttpApi`, `HttpRouter`, other), how the server starts.
2. **Versions and data stack**: Effect version; `@effect/sql-pg`,
   `@effect/sql-sqlite-*`, or `pg` + Kysely; Kysely version; graphile-migrate
   and graphile-worker versions.
3. **Config and env**: Effect `Config` or another parser; env file loading;
   scripts that generate `.env`; required variables.
4. **Pools and roles**: how many pools; role names (owner, authenticator,
   visitor); how the visitor role and the session are set per request
   (transaction-local `set_config`, `SET ROLE`, other); what happens outside a
   request.
5. **Typed handles**: how query code gets a connection (service, parameter,
   global); whether types restrict which schemas or tables a handle can reach.
6. **Database error mapping**: how SQLSTATE and custom codes become domain
   errors and HTTP statuses; what happens to unknown errors.
7. **Migrations and codegen**: migration tool and layout; schemas
   (`app_public`, `app_private`, `app_hidden`, other); `afterReset`; type
   codegen tool, its trigger, and its output path.
8. **Sessions and cookies**: cookie format, signing or hashing, storage table,
   expiry and sliding, logout, session lookup per request.
9. **Password auth**: register, login, verify email, forgot and reset
   password, change password; which steps are SQL functions and which are
   TypeScript; password hashing location and algorithm; lockout.
10. **OAuth**: providers, library, account linking, how identities are stored.
11. **Authorization**: RLS policies, organizations and memberships, roles
    inside the app, checks done in TypeScript.
12. **Rate limiting**: store, keys, limits, client IP handling.
13. **Realtime**: SSE or WebSocket, LISTEN/NOTIFY, outbox, replay.
14. **Worker and mail**: job runner, tasks, mail transport and providers,
    templates.
15. **Test harness and test database**: runner, in-process HTTP or TCP, test
    database creation and reset, fixtures, how auth is faked or done.
16. **Telemetry and logging**: OTLP, DevTools, log format, spans.
17. **API contract with the frontend**: shared schemas, `HttpApi` client,
    RPC, other.
18. **Deployment**: cartridge.json, Docker, ops, process layout.
19. **App-only backend features**: backend features no framework would own
    (one line each).

## SQL surface (Postgres apps only)

After the rows, list from `migrations/committed/` and `migrations/current/`:

- every function in `app_public`, `app_private` and `app_hidden`: signature,
  `SECURITY DEFINER` or not, one-line purpose;
- every table with RLS enabled, and its policies (name, command, one-line
  condition);
- every grant to the visitor role (table, columns, command);
- role names and how roles are created (setup script, `afterReset.sql`).

This section decides the schema delivery design, so be complete.
