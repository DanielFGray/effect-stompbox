# knowledgebase

Repo: `~/build/knowledgebase`, read at commit `a6cb0c6` (branch head on 2026-10-31).
Every path below is relative to the repo root.

The app is a personal notes and tasks store with wiki links, tags, a link
graph, full-text search and embedding-based related notes. The TypeScript
server replaced an Elixir/Phoenix app in `675e381` (2026-07-25); history
before that date belongs to the earlier codebase.

## Rows

### 1. Runtime and HTTP layer

present. The runner is `nub` (`package.json:8`, `:12`, `Dockerfile:1`, `:27`);
the production entry is an esbuild bundle for `platform: "node"`,
`target: "node22"` (`scripts/serverBuild.ts:3-11`). The platform package is
`@effect/platform-node`. The server is `NodeHttpServer.layer(() => createServer(), { port, host })`
and starts with `NodeRuntime.runMain` (`server/src/main.ts:65-83`). Routing is
`HttpApiBuilder.layer(KnowledgebaseApi)` plus one `HttpRouter.add` route for
SSE (`server/src/app.ts:113-117`, `server/src/sse-route.ts:12-41`). Global
router middleware applies security headers, a development-only CORS rule for
`http://localhost:5173`, request logging and a defect-to-500 page
(`server/src/app.ts:14-109`). In production a server middleware serves the
built client from an in-memory file cache with SPA fallback
(`server/src/main.ts:23-63`, `server/src/static-files.ts:25-43`). In
development Vite proxies `/api` to port 3001 (`vite.config.ts:19-20`).

### 2. Versions and data stack

present. `effect` `4.1.0`, `@effect/platform-node` `4.1.0`, `@effect/vitest`
`4.1.0` (`package.json:56`, `:45`, `:82`; `nub.lock:2090`). Data access is
`pg` + Kysely: `pg` `^8.22.0`, `kysely` `^0.29.4` resolved to `0.29.7`
(`package.json:67`, `:65`; `nub.lock:2560`). `@effect/sql-pg` `4.1.0` is
declared (`package.json:46`) but no file in `server/`, `shared/`, `scripts/`
or `worker/` imports it. graphile-migrate `^2.0.0-rc.2` resolved to
`2.0.0-rc.6` (`package.json:57`, `nub.lock:2251`); graphile-worker `^0.17.3`
(`package.json:58`, `nub.lock:2255`); kysely-codegen `0.20.0`
(`nub.lock:2524`). Server code imports `effect/http/*` and
`effect/http-api/*` module paths (`server/src/main.ts:2-5`,
`server/src/app.ts:2-7`).

### 3. Config and env

present. Effect `Config` for every server setting: `NODE_ENV` as literals with
default `development` (`server/src/config.ts:8-11`), `PORT` and `HOST`
(default `0.0.0.0`) (`server/src/main.ts:66-68`), `DATABASE_URL` as
`Config.Redacted` (`server/src/db.ts:77`). The app code loads no env file; a
comment states that `nub` loads `.env` for scripts (`scripts/dbPrepareTest.ts:5-7`).
No script generates `.env`; `.env.example:1-7` lists `DATABASE_URL`,
`SHADOW_DATABASE_URL`, `TEST_DATABASE_URL`, `EMBEDDING_URL`, `PORT`, `HOST`,
`NODE_ENV`. The worker reads `EMBEDDING_URL` from `process.env`
(`worker/tasks/embedding-process.js:3`).
Fix: `d5dc796` moved the server from `assertEnv` (decoded `process.env` at
import and required `HOST`, `EMBEDDING_URL`, `SESSION_SECRET`) to `Config`;
the commit body says compose and cartridge deploys stopped at startup because
they set none of those, and that the old catch-all exited 0 on failure.

### 4. Pools and roles

present (one pool, no request roles). `PgDB` builds one `pg.Pool` from
`DATABASE_URL` inside one `Kysely<DB>` (`server/src/db.ts:87-97`). Two
short-lived extra connections exist: a startup client that registers the
`citext[]` parser (`server/src/db.ts:41-66`) and a dedicated LISTEN client
per `listen()` call (`server/src/db.ts:130-165`). No role switch, no
`set_config`, no `SET ROLE` per request: `rg -i` for `grant`, `policy`,
`row level` and `create role` in `migrations/`, `db-tests/` and `docker/`
finds none, and `server/src/db.ts` issues no session settings. The database
owner role is `knowledgebase_owner`, created by `ops dev db`, and the
migration login is a member (`.gmrc:2-3`). Production runs the API with the
`migration` login (`cartridge.json:26-32`). Code outside a request (seed,
tests) provides `CurrentSession` directly
(`shared/src/authentication.ts:7-18`).

### 5. Typed handles

present. Services get the handle by yielding the `PgDB` service
(`server/src/db.ts:75-171`, e.g. `server/src/services/tasks.ts:11`). `PgDB`
exposes `execute(query: (db: Kysely<DB>) => Promise<A>)`, `transaction(effect)`
and `listen(channel)` (`server/src/db.ts:101-167`). `transaction` keeps the
open `ControlledTransaction` in a fiber `Context.Reference`, so `execute`
inside the scope uses the transaction connection without a parameter
(`server/src/db.ts:68-73`, `:101-125`). The types do not restrict schemas:
`DB` lists `app_public.*`, `app_private.*`, `graphile_migrate.*` and
`pgsodium.*` tables (`server/src/generated/db.ts:238-258`, untracked).
Fix: `3d64082` "make note writes transactional" added the transaction path
used by note create and update (`server/src/services/notes.ts:171`, `:261`).

### 6. Database error mapping

present. Every driver error becomes `DatabaseError { code?, cause }`, with
`code` decoded from the driver error by Schema (`server/src/db.ts:22-39`).
`server/src/pgErrors.ts:5-10` names SQLSTATE `23505` and the custom codes
`R8LMT` (rate limit), `USRTK` (username taken), `CREDS` (invalid
credentials). Services map them with `catchTag("DatabaseError", …)` to
`RateLimitError` 429, `UsernameTakenError` 409, `InvalidCredentialsError` 401
(`server/src/services/accounts.ts:99-116`, `:165-185`, `:306-314`, `:349-355`;
statuses in `shared/src/errors.ts:24-40`). `catchDatabase` turns any other
`DatabaseError` into `InternalError` 500 with a fixed message and logs the
cause (`server/src/pgErrors.ts:18-29`). Defects that are not `Respondable`
get an HTML 500 page (`server/src/app.ts:50-75`).
Fix: `9341795` stopped `InternalError` from carrying `Database error: …`
text to the client and logs the error instead.

### 7. Migrations and codegen

present. graphile-migrate. The whole schema lives in `migrations/current/`
as numbered split files (`0050` to `0700`); `migrations/committed/` holds only
`.gitkeep`. `0310-account-auth.sql` includes
`migrations/fixtures/functions/account-auth.sql` with `--!include`
(`migrations/current/0310-account-auth.sql:14`). Schemas: `app_public` and
`app_private`, dropped and recreated by `0100-schemas.sql:1-4`; no
`app_hidden`. `afterReset` runs `ops dev db reset "$GM_DBNAME"` for the shadow
database, then `afterReset.sql`, which is `SELECT 1`
(`.gmrc:7-11`, `migrations/afterReset.sql:1-2`). `afterCurrent` runs the
pgTAP suite and then kysely-codegen (`.gmrc:12-21`). Codegen config:
`includePatterns: ["public.*"]`, `excludePatterns: ["graphile_*.*"]`, output
`server/src/generated/db.ts` (`.kysely-codegenrc.json:2-6`). The output is
gitignored (`.gitignore:4`) and the local
copy contains `app_*`, `graphile_migrate.*` and `pgsodium.*` tables
(`server/src/generated/db.ts:238-258`), which the include and exclude
patterns would not allow; the CLI source reads `includePattern` /
`excludePattern` (singular) (`node_modules/kysely-codegen/dist/cli/cli.js:69-70`).
The compose `migrate` service runs
`graphile-migrate migrate` (`docker-compose.yml:85`), which applies committed
migrations; with an empty `committed/`, only `watch --once` (`db:latest`,
`package.json:24`) and `test:db:prepare` (`scripts/dbPrepareTest.ts:28`)
apply the schema.

### 8. Sessions and cookies

present. Cookie `session` holds `cookieId.secret`, each 32 random bytes hex
(`server/src/services/accounts.ts:21-32`). Storage is
`app_private.session_tokens (id, token_hash unique, account_id, created_at)`
with SHA-256 of the whole token (`migrations/current/0301-sessions.sql:1-7`,
`server/src/services/accounts.ts:34-36`); `token_hash` has both a unique
constraint and a unique index (`migrations/current/0301-sessions.sql:3`, `:7`).
The SQL functions insert the session row
(`migrations/fixtures/functions/account-auth.sql:40-41`, `:97-98`). Expiry is
30 days absolute from `created_at`, checked on each lookup; an expired row is
deleted then (`server/src/services/accounts.ts:38`, `:230-239`). No sliding.
Cookie: HttpOnly, SameSite Lax, Path `/`, `Max-Age` 30 days, Secure when
`NODE_ENV=production` (`server/src/services/accounts.ts:40-47`,
`server/src/routes.ts:34`). Lookup per request: the `Authentication`
`HttpApiMiddleware` reads the cookie through `HttpApiSecurity.apiKey`
(`shared/src/authentication.ts:24-30`) and calls `validateSession`
(`server/src/services/auth-middleware.ts:7-21`); the SSE route calls it itself
(`server/src/sse-route.ts:19-26`). Logout deletes the current session row and
clears the cookie (`server/src/routes.ts:96-107`).
Fixes: `af8549a` "return session cookies from auth routes"; `420f0b0` added
`Max-Age` and `Secure` to the cookie and made logout delete one session and
clear the cookie, where it had deleted all sessions and left the cookie;
`997590e` replaced the per-service `authenticated()` helper and a second
session check with the middleware, and a failed lookup on the event stream
now answers 500 instead of 401.

### 9. Password auth

present. Register, login and change password; no email verification, no
forgot or reset password. Each step is a PL/pgSQL SECURITY DEFINER function
in `app_private`, called from `AccountService` with
`selectFrom(eb.fn("app_private.…"))`: `register_account`
(`migrations/fixtures/functions/account-auth.sql:1-48`,
`server/src/services/accounts.ts:79-139`), `login_account`
(`account-auth.sql:50-102`, `accounts.ts:141-206`), `change_account_password`
(`account-auth.sql:118-156`, `accounts.ts:327-364`). TypeScript generates the
session token and passes only its hash (`accounts.ts:80`, `:146`). Hashing
is in SQL: `pgsodium.crypto_pwhash_str`, stored base64
(`account-auth.sql:24-27`), verified with `crypto_pwhash_str_verify`
(`account-auth.sql:88-91`). Unknown usernames verify against a stored dummy
hash (`migrations/current/0310-account-auth.sql:1-12`,
`account-auth.sql:82-86`). Password change deletes every other session of the
account (`account-auth.sql:150-152`). No account lockout; limits are per IP
(row 12). Username change is plain Kysely (`accounts.ts:291-325`).
`scripts/dbSeed.ts:184` hashes seed passwords with `@node-rs/argon2` and
stores the PHC string unencoded, while `login_account` base64-decodes the
stored value (`account-auth.sql:88-89`). `server/test/dbSeed.test.ts` does
not log in a seeded account. Seeded accounts may fail to log in; not run, a
reader should confirm.
Fixes: `ecab8ea` "preserve current session after password change" passed the
current session id so the change keeps it; `3d64082` moved register, login
and change password into SQL with pgsodium and a fallback for legacy argon2
hashes; `7d98b0c` removed that legacy fallback and moved the functions into
the fixture file.

### 10. OAuth

absent. No OAuth code in `server/`, `shared/` or `migrations/`; the API
defines only username and password endpoints (`shared/src/httpApi.ts:41-62`).

### 11. Authorization

present (TypeScript only). No RLS, no organizations, no memberships, no
in-app roles. Every service reads `CurrentSession` and adds
`where account_id = …` to each query (e.g.
`server/src/services/tasks.ts:14-23`, `server/src/services/notes.ts:79`,
`server/src/services/graph.ts:28`). The API splits into a `public` group
(register, login, health) and an `api` group guarded as a whole by the
`Authentication` middleware (`shared/src/httpApi.ts:41-62`, `:64-249`). The
worker filters by the `accountId` in the job payload
(`worker/tasks/embedding-process.js:8-11`).

### 12. Rate limiting

present. Store: `app_private.login_attempts (ip_address, action, attempted_at)`
(`migrations/current/0302-login-attempts.sql:1-7`). Keys: IP plus action
`register` or `login`. Limits, checked inside the SQL functions before any
work: register 5 per hour (`account-auth.sql:13-22`), login 10 per 15 minutes
(`account-auth.sql:64-73`); both raise `R8LMT`. `register_account` records
every successful registration (`account-auth.sql:43-44`); TypeScript records
a `login` attempt after `CREDS` and a `register` attempt after `USRTK`
through `app_private.record_login_attempt`
(`server/src/services/accounts.ts:55-76`, `:124-129`, `:191-196`). Client IP
is the socket `request.remoteAddress`, fallback `0.0.0.0`
(`server/src/routes.ts:42`, `:57`); no forwarded header is read.
`server/test/rate-limit.test.ts:5-11` tests a local copy of the IP helper.
Fix: `9341795` replaced the hard-coded IP `127.0.0.1` with
`request.remoteAddress`, so limits apply per client.

### 13. Realtime

present. Triggers on `app_public.notes`, `app_public.tasks` and
`app_public.note_embeddings` call `app_private.notify_realtime(kind, id_column)`,
which sends `{kind, id, account_id}` with `pg_notify('realtime', …)`
(`migrations/current/0700-realtime.sql:15-43`). `PgDB.listen` streams a
channel's payloads over a dedicated `pg.Client` (`server/src/db.ts:127-165`).
`RealtimeEvents` decodes each payload with Schema, publishes to an unbounded
`PubSub`, and reconnects with exponential backoff capped at 30 s
(`server/src/services/realtime.ts:14-56`). `GET /api/events` is an SSE
`HttpRouter` route that filters events by account and sends a `:` comment
every 15 s (`server/src/sse-route.ts:12-41`,
`server/src/services/sse-stream.ts:8-13`). No outbox table, no replay or
`Last-Event-ID`. The client uses `EventSource` with credentials
(`app/src/lib/sse.ts:36`, `app/src/lib/realtime.tsx:25`).
Fix: `959b704` replaced an in-process `EventEmitter` bus; its body says a
second server instance and the worker could not announce changes.

### 14. Worker and mail

present (worker), absent (mail). graphile-worker runs from `worker/` with
`nubx --cwd worker graphile-worker` (`package.json:30`); one task,
`embedding-process`, in plain JavaScript
(`worker/tasks/embedding-process.js:1-75`). It reads the note, skips deleted,
archived or changed notes, calls an HTTP embedding service at `EMBEDDING_URL`
(30 s timeout), and upserts `app_public.note_embeddings`
(`worker/tasks/embedding-process.js:5-69`). The server enqueues with
`graphile_worker.add_job(…, job_key, …, 'replace')` in SQL, max 3 attempts
(`server/src/services/embeddings.ts:33-81`,
`server/src/lib/embedding-job.ts:1-14`). The worker schema is installed with
`graphile-worker --schema-only` (`package.json:31`). The embedding service is
a separate Python container (`docker-compose.yml:20-34`,
`embeddings/server.py`). No mail transport, templates or mail task.

### 15. Test harness and test database

present. Vitest 5 with two projects, `app` (jsdom) and `server` (node)
(`vitest.config.ts:16-45`, `package.json:102`). HTTP tests start the real
`application` layer on a free TCP port with `NodeHttpServer`, override config
with `ConfigProvider.fromUnknown({ DATABASE_URL: TEST_DATABASE_URL, NODE_ENV: "test" })`,
and wait for `/api/health` (`server/test/lib/http-api-test-server.ts:26-79`).
An `ApiClient` keeps the session cookie (`http-api-test-server.ts:87-148`).
Auth in tests goes through the real register and login endpoints; cleanup
deletes `itest-*` accounts and login attempts with a direct pool
(`server/test/lib/test-db.ts:17-30`). Database suites run only when
`RUN_DB_TESTS=1` (`server/test/http-api.test.ts:12`,
`server/test/realtime.test.ts:8`). The test database is reset by
`ops dev db reset`, then `graphile-migrate watch --once` and the worker schema
(`scripts/dbPrepareTest.ts:27-29`). pgTAP tests in `db-tests/` run after each
`current` migration (`.gmrc:13-16`, `package.json:17`). CI builds the
Postgres image, runs `db:setup` and `test:db:prepare`, then Vitest with
`RUN_DB_TESTS=1` (`.github/workflows/ci.yml:36-76`). Playwright e2e exists
(`package.json:19`, `e2e/knowledgebase.spec.ts`).

### 16. Telemetry and logging

present (spans and default logger only). Request middleware logs
`--> METHOD url` and `<-- METHOD url status` and opens `request.incoming` and
`request.complete` spans with a request id (`server/src/app.ts:30-48`).
Service methods use `Effect.fn("name")` spans (e.g.
`server/src/services/accounts.ts:79`, `:141`, `:208`). No OTLP or DevTools
package in `package.json:34-103` and no logger or tracer layer in
`server/src/main.ts`. Database queries have no spans
(`server/src/db.ts:101-108`).

### 17. API contract with the frontend

present. One `HttpApi` `KnowledgebaseApi` with groups `public` and `api`,
prefix `/api`, and Schema types in `shared/src/schemas.ts`
(`shared/src/httpApi.ts:41-251`). Errors carry `httpApiStatus`
(`shared/src/errors.ts:6-58`). The server implements it with
`HttpApiBuilder.group` (`server/src/routes.ts:32-302`); the client uses
`HttpApiClient.make(KnowledgebaseApi)` with `FetchHttpClient`
(`app/src/lib/api.ts:2-7`). The SSE event shape is a shared Schema
(`server/src/services/realtime.ts:6`). Register and login return
`HttpServerResponse.raw` with a JSON string body to set the cookie
(`server/src/routes.ts:39-68`).
Fix: `997590e` moved the HTTP error classes into `shared/` so `shared` no
longer imports server code; the body says this had pulled Kysely and `pg`
into the browser bundle.

### 18. Deployment

present. Three-stage Docker image on `ghcr.io/nubjs/nub` that builds the Vite
client and the esbuild server bundle and runs `nub dist/server/main.js`
(`Dockerfile:1-27`). `cartridge.json` declares database `knowledgebase` with
extensions `uuid-ossp`, `pgcrypto`, `pg_hashids`, `pgsodium`, `vector`,
`citext`, `pgtap` (`cartridge.json:4-9`) and one service
`knowledgebase-api` on port 3000 with no routes, using the `migration` login
as `DATABASE_URL` (`cartridge.json:10-35`). The cartridge has no migrate
block, no worker service and no embeddings service. `docker-compose.yml`
runs `db` (custom Postgres 18 image with pgvector, pg_hashids, pgsodium,
pgtap: `docker/Dockerfile.postgres:1-44`), `embeddings`, `app`, `worker` and
a one-shot `migrate` (`docker-compose.yml:1-95`). Local development uses the
shared `ops dev db` cluster (`package.json:22-26`,
`docker-compose.dev.yml:1-6`). `rel/overlays/bin/migrate` and
`rel/overlays/bin/server` are Elixir release scripts
(`rel/overlays/bin/migrate:5`, `rel/overlays/bin/server:5`); nothing in
`package.json`, `Dockerfile` or `cartridge.json` calls them.

### 19. App-only backend features

present.
- Tags, wiki links and link refs extracted from Markdown by immutable PL/pgSQL into generated columns (`migrations/current/0250-note-derivation.sql:1-227`, `migrations/current/0400-notes.sql:9-11`).
- Multi-language full-text search vectors kept by triggers (`migrations/current/0400-notes.sql:37-104`).
- Embeddings with pgvector HNSW and related-note scores (`migrations/current/0600-embeddings.sql:1-15`, `server/src/services/embeddings.ts:83-115`).
- Note link graph, neighborhoods, orphans and tag usage (`server/src/services/graph.ts`).
- Note title de-duplication with ` (n)` suffix on unique violation (`server/src/services/notes.ts:173-212`).
- Markdown rendering and HTML sanitizing (`server/src/lib/markdown.ts`, `server/src/lib/html-sanitizer.ts`).
- Tasks with due dates and completion (`migrations/current/0500-tasks.sql:1-17`, `server/src/services/tasks.ts`).

## SQL surface

The app uses one pool, one login and no RLS (row 4). No grants, policies,
`row level security` or `create role` appear in `migrations/`, `db-tests/`
or `docker/`.

### Functions

`app_public`:

| Function | SECURITY DEFINER | Purpose | Cite |
| --- | --- | --- | --- |
| `update_timestamp() returns trigger` | no | Sets `updated_at = now()` | `migrations/current/0200-utility.sql:1-7` |
| `_note_mask_inline_code(line text) returns text` | no (immutable, strict) | Blanks inline code spans | `migrations/current/0250-note-derivation.sql:3-54` |
| `_note_get_clean_lines(body text) returns table(ln int, line text)` | no (immutable, strict) | NFC-normalizes, skips fenced blocks, masks inline code | `0250-note-derivation.sql:58-121` |
| `note_extract_tags(body text) returns citext[]` | no (immutable, strict) | `#tag` list, de-duplicated in first-seen order | `0250-note-derivation.sql:125-154` |
| `note_extract_links(body text) returns jsonb` | no (immutable, strict) | `[[type:ref\|label]]` links as JSON array | `0250-note-derivation.sql:159-190` |
| `note_extract_link_refs(body text) returns citext[]` | no (immutable, strict) | References of `note` links, de-duplicated | `0250-note-derivation.sql:194-227` |
| `build_note_search_vector(lang regconfig, title text, tags citext[], body_markdown text) returns tsvector` | no (immutable) | Weighted A/B/C tsvector | `migrations/current/0400-notes.sql:50-60` |
| `notes_rebuild_search_vectors() returns trigger` | no | Upserts vectors for every enabled language | `0400-notes.sql:63-82` |
| `search_langs_backfill() returns trigger` | no | Builds vectors for all notes when a language is added | `0400-notes.sql:85-102` |

`app_private`:

| Function | SECURITY DEFINER | Purpose | Cite |
| --- | --- | --- | --- |
| `register_account(p_username text, p_password text, p_ip_address text, p_token_hash text) returns app_public.accounts` | yes, `search_path = pg_catalog, app_private, app_public` | Rate check, hash, insert account, secret, session, attempt; raises `R8LMT`, `USRTK` | `migrations/fixtures/functions/account-auth.sql:1-48` |
| `login_account(p_username text, p_password text, p_ip_address text, p_token_hash text) returns app_public.accounts` | yes, same path | Rate check, verify with dummy hash for unknown users, insert session; raises `R8LMT`, `CREDS` | `account-auth.sql:50-102` |
| `record_login_attempt(p_action text, p_ip_address text) returns boolean` | yes, `search_path = pg_catalog, app_private` | Inserts a `login_attempts` row | `account-auth.sql:104-114` |
| `change_account_password(p_account_id uuid, p_current_password text, p_new_password text, p_current_session_id uuid) returns boolean` | yes, `search_path = pg_catalog, app_private, app_public` | Verifies, rehashes, deletes other sessions; raises `CREDS` | `account-auth.sql:116-156` |
| `notify_realtime() returns trigger` | no, `search_path = pg_catalog, public, pg_temp` | `pg_notify('realtime', {kind, id, account_id})` | `migrations/current/0700-realtime.sql:15-31` |

No `app_hidden` schema.

### Triggers

| Trigger | Table | Function | Cite |
| --- | --- | --- | --- |
| `accounts_updated_at` | `app_public.accounts` before update | `update_timestamp` | `0300-accounts.sql:13-15` |
| `notes_updated_at` | `app_public.notes` before update | `update_timestamp` | `0400-notes.sql:21-23` |
| `notes_search_vectors_trg` | `app_public.notes` after insert or update of title, body_markdown | `notes_rebuild_search_vectors` | `0400-notes.sql:80-82` |
| `search_langs_backfill_trg` | `app_public.search_langs` after insert | `search_langs_backfill` | `0400-notes.sql:100-102` |
| `tasks_updated_at` | `app_public.tasks` before update | `update_timestamp` | `0500-tasks.sql:15-17` |
| `note_embeddings_updated_at` | `app_public.note_embeddings` before update | `update_timestamp` | `0600-embeddings.sql:10-12` |
| `notes_notify_realtime`, `tasks_notify_realtime`, `note_embeddings_notify_realtime` | notes, tasks, note_embeddings after insert/update/delete | `notify_realtime` | `0700-realtime.sql:33-43` |

(Trigger cites are under `migrations/current/`.)

### Tables

`app_public`: `accounts` (`0300-accounts.sql:1-6`), `notes` (`0400-notes.sql:1-19`),
`search_langs` (`0400-notes.sql:37-39`, seeded with `english` at `:104`),
`note_search_vectors` (`0400-notes.sql:41-48`), `tasks` (`0500-tasks.sql:1-13`),
`note_embeddings` with `vector(384)` and an HNSW index (`0600-embeddings.sql:1-15`).
`app_private`: `account_secrets` (`0300-accounts.sql:8-11`), `session_tokens`
(`0301-sessions.sql:1-7`), `login_attempts` (`0302-login-attempts.sql:1-7`),
`password_hashing_dummy` (one row, `0310-account-auth.sql:1-12`).
graphile-worker adds its own schema through `--schema-only`
(`package.json:31`).

### RLS tables and policies

None. No table enables row level security.

### Visitor grants

None. No visitor role exists.

### Roles and how they are created

- `knowledgebase_owner`: group role that `ops dev db` makes the owner of each database; the migration login is a member (`.gmrc:2-3`). Created outside the repo.
- Production: the cartridge names only the `migration` login, used by the API (`cartridge.json:26-32`).
- Compose: the `postgres` superuser for app, worker and migrate (`docker-compose.yml:46`, `:75`, `:91`).
- Extensions come from the cartridge through `ops`, and again from `0050-extensions.sql:1-6`; `afterReset.sql` creates nothing (`migrations/afterReset.sql:1-2`).

## Older claims in `effect-web-template/docs/standardize/`

Checked against `a6cb0c6`.

| Claim (source) | Status | Current evidence |
| --- | --- | --- |
| Effect 4.0.6 (`runtime-bun-node.md:5`, `base-db-env-errors-telemetry.md:11`, `base-sessions-testing.md:10`, `ratelimit-realtime-email.md:10`) | no longer holds | `effect` 4.1.0 (`package.json:56`) |
| Server uses `NodeHttpServer.layer(() => createServer(), …)` and `NodeRuntime.runMain` (`runtime-bun-node.md:14`, `:22`) | holds; lines moved | `server/src/main.ts:72`, `:81-83` |
| Static files use `node:fs` (`runtime-bun-node.md:38`, `:47`) | holds | `server/src/static-files.ts:1-2`, `:25-43` |
| Env parsed by `S.Struct` in `server/src/assertEnv.ts` (`base-db-env-errors-telemetry.md:25`, `:43`) | no longer holds | file removed in `d5dc796`; `server/src/config.ts:8-11`, `server/src/main.ts:66-68` |
| Single `PgDB` with `execute` / `transaction` and fiber `ActiveTransaction` (`base-db-env-errors-telemetry.md:86`, `:121`) | holds; lines moved, now also `listen` | `server/src/db.ts:68-171` |
| `DatabaseError` carries SQLSTATE at creation (`base-db-env-errors-telemetry.md:157`) | holds; lines moved | `server/src/db.ts:22-39` |
| `catchDatabase` maps to opaque `InternalError` (`base-db-env-errors-telemetry.md:157`, `:189`) | holds; lines moved | `server/src/pgErrors.ts:18-29` |
| `RateLimitError` lives in `pgErrors.ts:27-29` (`ratelimit-realtime-email.md:58`) | no longer holds | `shared/src/errors.ts:36-40` |
| Int8 typed as string (`base-db-env-errors-telemetry.md:121`) | holds (generated type) | `server/src/generated/db.ts:12`; runtime parser returns `Number` (`server/src/db.ts:20`) |
| No OTEL package (`base-db-env-errors-telemetry.md:11`, `:208`) | holds | `package.json:34-103` |
| Realtime is an in-process `EventEmitter` in `realtime-bus.ts`, publishers in services (`ratelimit-realtime-email.md:94`, `:120-126`) | no longer holds | replaced in `959b704`; `migrations/current/0700-realtime.sql:15-43`, `server/src/services/realtime.ts:14-56` |
| SSE route returns 401 without session; keepalive every 15 s (`ratelimit-realtime-email.md:122-123`) | holds; lines moved | `server/src/sse-route.ts:19-26`, `server/src/services/sse-stream.ts:8-13` |
| Rate limits in SQL: register 5/hour, login 10/15 min (`ratelimit-realtime-email.md:56`, `auth-login.md:81`) | holds | `account-auth.sql:13-22`, `:64-73` |
| Failed login recorded via `record_login_attempt` at `accounts.ts:241-245` (`ratelimit-realtime-email.md:57`) | holds; lines moved | `server/src/services/accounts.ts:191-196` |
| IP from `remoteAddress` at `routes.ts:39` / `:36-55` (`ratelimit-realtime-email.md:60`, `auth-login.md:86`) | holds; lines moved | `server/src/routes.ts:42`, `:57` |
| `rate-limit.test.ts` re-implements the IP helper locally (`ratelimit-realtime-email.md:61`) | holds | `server/test/rate-limit.test.ts:5-11` |
| No email worker (`ratelimit-realtime-email.md:158`) | holds | row 14 |
| Password hashing in SQL with pgsodium argon2id; login in SQL (`auth-login.md:26`, `:81`) | holds; app-side line refs moved | `account-auth.sql:24-27`, `:50-102`; `server/src/services/accounts.ts:141-206` |
| Dummy hash for unknown users (`auth-login.md:81`, `:86`) | holds | `account-auth.sql:82-86`, `migrations/current/0310-account-auth.sql:1-12` |
| No OAuth, no reset flow (`auth-login.md:39`, `:124`) | holds | rows 9 and 10 |
| Session token `cookieId.secret`, SHA-256, 30 days absolute (`base-sessions-testing.md:26`, `:55-56`; `auth-login.md:180`) | holds; lines moved | `server/src/services/accounts.ts:21-38`, `:230-239` |
| Cookie read by custom `getCookieValue` in `lib/cookies.ts` (`base-sessions-testing.md:92`, `:114`) | no longer holds | file removed in `997590e`; cookie read by `HttpApiSecurity.apiKey` (`shared/src/authentication.ts:28`) and `request.cookies` (`server/src/sse-route.ts:19`) |
| Auth through an `authenticated()` helper, not `HttpApiMiddleware` (`base-sessions-testing.md:148`, `:169-172`) | no longer holds | `Authentication` middleware since `997590e` (`shared/src/authentication.ts:24-30`, `server/src/services/auth-middleware.ts:7-21`) |
| `makeSessionCookie` unit-tested (`base-sessions-testing.md:114`) | holds | `server/test/accounts.test.ts:96` |
| DB tests gated by `RUN_DB_TESTS` (`base-sessions-testing.md:226-229`, `:261`) | holds | `server/test/http-api.test.ts:12` |
| Real TCP test server with cookie-aware `ApiClient` (`runtime-bun-node.md:173`, `base-sessions-testing.md:261`, `:283`) | holds; lines moved | `server/test/lib/http-api-test-server.ts:26-148` |
| Worker run by `nubx --cwd worker graphile-worker` (`runtime-bun-node.md:157`) | holds | `package.json:30` |
| Dockerfile on `ghcr.io/nubjs/nub`, `CMD ["nub", "dist/server/main.js"]` (`runtime-bun-node.md:210`) | holds | `Dockerfile:1`, `:27` |
