# Backend concerns across the apps

This matrix compares how seven apps implement each backend concern. It decides
what the framework holds, where it needs extension points, and what stays in
the apps.

- Evidence: one file per app in `apps/`, written to the rows in `ROWS.md`.
  Every claim there cites `path:line` in the app repo.
- SQL drift: `sql-drift.md` compares the bodies of the SQL functions that the
  Postgres apps share. Regenerate it with `bun scripts/sqlDrift.ts`.
- Surveyed: 2026-10-31.

## Terms

- **Core**: at least three apps do the same thing. The framework owns it.
- **Extension point**: in the terms of `docs/adr/0003`, a service with more
  than one adapter. At least three apps need the concern, but they do it
  differently. The framework defines the interface; the app supplies the part
  that differs.
- **App-only**: fewer than three apps need it. It stays in the app.
- **Security rule**: a property the framework would enforce even when no app
  does it yet, because breaking it is a security defect. These come from the
  bugs this survey found, not from counting apps. This is a proposed second
  way into the framework besides the rule of three; it needs your approval.
- **Below three: decision for you**: fewer than three apps do it, but the
  template has it. Under the rule of three it stays out; you decide whether to
  make an exception.
- **Owner pool / visitor pool**: the owner pool connects as the role that owns
  the schema and bypasses row-level security (RLS). The visitor pool connects
  as the API login and switches to the visitor role for each request
  transaction, so RLS applies.

Counts are out of the seven apps. The template (`effect-web-template`) is a
merge of these apps, so it is not counted; its column shows the current best
version of each pattern.

## The apps

| App               | Database                             | Users and auth      |
| ----------------- | ------------------------------------ | ------------------- |
| dfg.rocks         | Postgres, owner + visitor pools, RLS | yes                 |
| setlist           | Postgres, owner + visitor pools, RLS | yes                 |
| postgres.garden   | Postgres, owner + visitor pools, RLS | yes                 |
| dfg.codes         | Postgres, owner + visitor pools, RLS | GitHub sign-in only |
| knowledgebase     | Postgres, one pool, no RLS           | yes                 |
| twitter-bookmarks | SQLite                               | no, single user     |
| budget            | SQLite, Effect v3                    | no, single user     |

## Matrix

| #   | Concern           | Apps that agree                                                                                                                                                                                                                                  | Template                                | Class                                                                                  |
| --- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------- | -------------------------------------------------------------------------------------- |
| 1   | HTTP API          | `HttpApi` contract: 6 (not twitter-bookmarks). Server host differs: `BunHttpServer` 2, `NodeHttpServer` 3 (two under Bun, knowledgebase on Node), a web handler inside `Bun.serve` or TanStack Start 2                                           | `HttpApi`, Bun and Node entry points    | Core: `HttpApi`. Extension point: server host                                          |
| 2   | Query layer       | Kysely as query builder: all 5 Postgres apps. Execution differs: Kysely compiles and `@effect/sql` `SqlClient` runs it in 2 (dfg.rocks, setlist, each with its own bridge); `pg` + Kysely runs it in 3. `SqlClient` also serves both SQLite apps | `pg` + Kysely                           | Core: Kysely builder. Open decision: execution path                                    |
| 3   | Config            | Effect `Config`: 3 (setlist, knowledgebase, twitter-bookmarks). Schema decode of `process.env` at import: 2. Mixed or raw: 2                                                                                                                     | Effect `Config`                         | Core: Effect `Config`                                                                  |
| 4   | Pools and roles   | Owner + visitor pools with transaction-local role and session: 4. In every app the platform (`ops`, cartridge) creates the roles, not the repo                                                                                                   | same                                    | Core                                                                                   |
| 5   | Connection access | Handle as an Effect service: 3 (dfg.rocks, setlist, knowledgebase). Closures: 1. Module globals: 1. No app restricts by type which tables the visitor handle reaches                                                                             | Service, typed to `app_public`          | Core: service. Security rule: visitor types hold only what the visitor may reach       |
| 6   | Database errors   | SQLSTATE and custom 5-letter codes mapped to domain or HTTP errors: all 5 Postgres apps. The codes (`CREDS`, `LOCKD`, `WEAKP`, ...) come from the shared SQL functions in 3                                                                      | Per-call error map, unknown codes die   | Core. The code list ships with the SQL that raises it                                  |
| 7   | Migrations        | graphile-migrate: all 5 Postgres apps. `app_public` / `app_private`: 4. Both SQLite apps run idempotent `CREATE TABLE IF NOT EXISTS` at boot                                                                                                     | graphile-migrate                        | Core. See "Release gap" below                                                          |
| 8   | Sessions          | Opaque `id.secret` cookie, SHA-256 of the secret stored, 30-day expiry: 4 (dfg.rocks, postgres.garden, dfg.codes, knowledgebase). setlist stores a bare UUID                                                                                     | `id.secret`, hashed                     | Core                                                                                   |
| 9   | Password auth     | graphile-starter SQL functions, bcrypt in SQL, 3-failure lockout: 3 (dfg.rocks, setlist, postgres.garden). knowledgebase has its own SQL with argon2                                                                                             | Starter functions, reworked             | Core, but the bodies have drifted (see below)                                          |
| 10  | OAuth             | 3 apps sign in with OAuth: GitHub through `arctic` (postgres.garden), GitHub by hand (dfg.codes), Google and Apple through `arctic` (dfg.rocks). setlist keeps the starter SQL but no code calls it                                              | GitHub through `arctic`, state + PKCE   | Extension point: provider. Core: state + PKCE flow and `link_or_register_user` storage |
| 11  | Authorization     | RLS keyed on `current_user_id()`: 4. A group concept with an owner flag: 2 (dfg.rocks families, setlist bands); postgres.garden has an organizations schema that no code uses. An app role enum: 2                                               | RLS, organizations                      | Core: RLS identity. Groups: below three, decision for you                              |
| 12  | Rate limits       | Effect `RateLimiter`: 2 (dfg.rocks in memory, setlist on Valkey). SQL attempt table: 1. None: 2                                                                                                                                                  | `RateLimiter`, in memory                | Below three: decision for you                                                          |
| 13  | Realtime          | SSE: 3 (dfg.rocks, setlist, knowledgebase uses `pg_notify`). Outbox table + LISTEN wake-up: 1                                                                                                                                                    | SSE, outbox, replay                     | Core: SSE. Outbox: below three, decision for you                                       |
| 14  | Worker and mail   | graphile-worker: 4. Starter mail tasks (verify, reset, delete account): 3                                                                                                                                                                        | graphile-worker, Effect `Mailer`        | Core                                                                                   |
| 15  | Tests             | vitest with `@effect/vitest`: 3. In-process HTTP: 2. A separate test database: 2; 3 test against the dev database                                                                                                                                | In-process HTTP, separate test database | Core: vitest. The template's isolation is the target                                   |
| 16  | Telemetry         | `Effect.fn` spans: most. `Otlp.layerFromConfig`: 2. OTLP exporter configured in the cartridge but not wired: 1                                                                                                                                   | OTLP + DevTools                         | Core (small)                                                                           |
| 17  | API contract      | Shared `HttpApi` with `HttpApiClient` in the browser: 6                                                                                                                                                                                          | Shared `HttpApi`                        | Core. The framework stops at the contract                                              |
| 18  | Deployment        | server-ansible `cartridge.json`: 6 (not budget). API and worker as two services from one image: 3                                                                                                                                                | same                                    | Outside the framework, but schema delivery must fit the cartridge `migrate` step       |
| 19  | App features      | Billing, charts, playgrounds, notes, scrapers, budgets                                                                                                                                                                                           | Posts, comments, stars                  | App-only                                                                               |

## What the evidence says

### The SQLite apps need almost nothing from auth

twitter-bookmarks and budget have no users, no sessions and no auth. They
share four rows with the Postgres apps: the `HttpApi` contract, Effect
`Config`, the `@effect/sql` `SqlClient`, and telemetry. SQLite support in the
auth core would therefore serve no app. A Postgres-first framework, with the
runtime, config, contract and telemetry pieces usable alone, covers both
SQLite apps.

### The shared SQL has drifted, and fixes do not spread

Three Postgres apps (dfg.rocks, setlist, postgres.garden) and the template
share 20 auth functions from graphile-starter (`sql-drift.md`). Five are
identical in all four. `change_password`,
`reset_password`, `really_create_user` and `link_or_register_user` exist in 3
to 5 versions. The survey found security bugs that a fix in one copy did not
reach in the others:

- setlist and dfg.rocks share one `reset_password` body, and it accepts a reset
  token of any age. The template checks token age.
- setlist fixed NULL secrets that let `login`, `reset_password` and
  `change_password` accept any input, but only in `migrations/current/`.
- dfg.rocks revoked execute on billing functions, but recreating them in a later
  migration granted them back to the visitor through default privileges.
- The template's star functions are `SECURITY DEFINER` with no fixed
  `search_path`.

Each one is filed in prog under its app. Together they are the main argument
for the framework: one owned copy of the auth SQL, with tests, delivered to
every app.

### Release gap

Production in dfg.rocks migrates only `migrations/committed/`, but its code
needs `migrations/current/`. setlist's deploy config has no migrate step at
all, and its account-takeover fix exists only in `current/`. knowledgebase
and the template have nothing in `committed/`. Schema delivery must make "the code needs schema
version N" something a check can see, not a convention.

### Candidate security rules

From the bugs above, each to become a test (step 2 of the plan):

1. A visitor handle's type names only what the visitor may reach.
2. Every `app_public` table has RLS enabled.
3. The set of functions the visitor may execute equals a declared list.
4. Every `SECURITY DEFINER` function sets `search_path`.
5. Every secret check rejects a NULL stored value.
6. Every emailed token has an expiry that the check enforces.
7. The session check in SQL enforces expiry itself (postgres.garden checks
   only in TypeScript).

## Open decisions

1. **SQLite.** Decided: auth, migrations and the worker require Postgres
   (`docs/adr/0001-postgres-only-auth.md`).
2. **Query execution.** Two apps already run Kysely-compiled SQL through
   `SqlClient`, each with its own bridge; three run Kysely on `pg`. `SqlClient`
   is the one interface that also serves the SQLite apps, and pg-sourcerer
   generates `SqlClient` code. One shared bridge would replace two copies.
3. **Frontend.** Six apps share an `HttpApi` contract and use five different
   frontend stacks. The framework stops at the contract.
