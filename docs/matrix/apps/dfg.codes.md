# dfg.codes

Repo: `~/build/dfg.codes`, read at commit `9ce49aa` (branch head on 2026-10-31).
Every path below is relative to the repo root.

The backend is a comments-and-likes service ("discussion") inside a React
Router site. Every backend file first appears in commit `55748ea` ("serve
comments from a Postgres-backed Effect server"), and the deploy files in
`9ce49aa`. No later commit touches them, so no row has a bug-fix SHA.
`git log --follow` on `server/db.ts`, `server/discussion/auth.ts`,
`server/discussion/api.ts`, `server/services/discussion-live.ts` and
`migrations/committed/000001-discussion-schema.sql` returns only `55748ea`.

## Rows

### 1. Runtime and HTTP layer

present. Bun runs the server from source: `start` is `bun server/index.ts`
(`package.json:18`, `Dockerfile:16`). The platform package is
`@effect/platform-node`. The server is `NodeHttpServer.layerConfig(createServer, …)`
with `node:http` (`server/index.ts:1-8`, `:175-181`), and the program starts
with `NodeRuntime.runMain(Layer.launch(HttpRouter.serve(app)))`
(`server/index.ts:184-186`). Routing uses `HttpApi` for the discussion API
(`server/discussion/api.ts:167-323`) and plain `HttpRouter.add` for a `/api/*`
404 and a catch-all that serves `dist/client` files or hands the request to the
React Router handler through `HttpServerRequest.toWeb` / `HttpServerResponse.fromWeb`
(`server/index.ts:129-156`). A global `HttpRouter.middleware` sets COOP/COEP
headers (`server/index.ts:117-127`, `server/cross-origin.ts:1-6`). In
development, `server/dev.ts` runs the API alone on port 3001
(`server/dev.ts:39-53`, `package.json:15`) and Vite proxies `/api` to it with
`xfwd: true` (`vite.config.ts:81`, `:91-97`).

### 2. Versions and data stack

present. `effect` `^4.0.0-beta.74` with an override to the same range
(`package.json:59`, `:99`); lockfile resolves `effect@4.0.0-beta.74`
(`bun.lock:894`). Request-path data access is `pg` + Kysely: `pg` `^8.21.0`,
`kysely` `^0.29.2` (`package.json:65`, `:62`; `bun.lock:1318`, `:1120`).
`@effect/sql-pg` `^4.0.0-beta.74` (`package.json:45`) is used only by the
`scripts/dbEnsure.ts` and `scripts/dbSetup.ts` scripts
(`scripts/dbEnsure.ts:3`, `scripts/dbSetup.ts:4`). graphile-migrate `^1.4.1`
(`package.json:60`, `bun.lock:996`). No graphile-worker dependency.
kysely-codegen `^0.20.0` (`package.json:91`).

### 3. Config and env

present. Mixed. The server reads `HOST`, `PORT` and `NODE_ENV` with Effect
`Config` (`server/index.ts:48-50`, `:175-181`). The database and OAuth code
read `process.env` directly at import or call time: `DATABASE_URL` and
`AUTH_DATABASE_URL` throw at module load when missing (`server/db.ts:10-16`);
`DATABASE_VISITOR` defaults to `"visitor"` (`server/db.ts:69`);
`GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` (`server/discussion/auth.ts:62-74`)
and `VITE_ROOT_URL` (`server/discussion/auth.ts:60`). Env files load through
`bun --env-file=.env` in scripts (`package.json:15`, `:24`, `:34`) and
`node --env-file=.env` for Playwright (`package.json:20`). `scripts/generateEnvFile.ts`
writes `.env`: it keeps existing values, generates base64url passwords for the
owner, authenticator and shadow roles, and derives role names and URLs from
`DATABASE_NAME` (`scripts/generateEnvFile.ts:25-75`, `:135-163`). Variables in
`.env.example:1-20`.

### 4. Pools and roles

present. Two `pg.Pool`s, each wrapped in a module-level `Kysely<DB>`:
`rootPool` from `DATABASE_URL` and `authPool` from `AUTH_DATABASE_URL`
(`server/db.ts:18-32`). Locally `DATABASE_URL` is the owner login and
`AUTH_DATABASE_URL` the authenticator login (`.env.example:14-15`). In
production both URLs come from the same `api` login (`cartridge.json:31-42`).
Role names: owner `DATABASE_OWNER`, authenticator `DATABASE_AUTHENTICATOR`
(`noinherit`), visitor `DATABASE_VISITOR` (nologin), plus a superuser
`<db>_shadow` (`scripts/dbSetup.ts:67-83`). Per request, `withAuthContext`
opens a transaction on `authDb` and runs one statement:
`set_config('role', visitor, true)`, `set_config('dfgcodes.headers', …, true)`,
`set_config('dfgcodes.ip_address', …, true)`,
`set_config('dfgcodes.session_id', …, true)` (`server/db.ts:85-99`). The SQL
side reads `dfgcodes.session_id` in `auth.current_session_id()` and resolves
the user in `auth.uid()` (`migrations/committed/000001-discussion-schema.sql:41-69`).
The callback runs the inner Effect with a fresh `Effect.runPromiseExit`
(`server/db.ts:101`), so the inner Effect runs outside the caller's fiber
context. Outside the visitor transaction, on `rootDb`, the code does: session
lookup (`server/discussion/auth.ts:461-474`), OAuth user lookup and creation
(`server/discussion/auth.ts:162-242`), session insert
(`server/discussion/auth.ts:178-196`) and session delete
(`server/discussion/auth.ts:502-513`). Migration `000002` grants the
authenticator role DML on `auth.users`, `auth.oauth_accounts` and
`hidden.sessions` for this
(`migrations/committed/000002-authenticator-grants.sql:9-13`).

### 5. Typed handles

present. Query code gets a handle two ways: the module globals `rootDb` /
`authDb` (`server/db.ts:26-32`), imported directly
(`server/discussion/auth.ts:7`), and the `Transaction<DB>` parameter that
`withAuthContext` passes to its callback (`server/db.ts:85-88`,
`server/services/discussion-live.ts:221-237`). Both are `Kysely<DB>` over one
generated `DB` interface that lists `auth.*`, `hidden.*`, `public` and
`graphile_migrate.*` tables (`generated/DB.ts:71-80`). The types do not
restrict which schema a handle reaches. Query execution goes through
`executeQuery` / `executeTakeFirst`, which wrap the promise in
`Effect.tryPromise` and a span (`server/db.ts:52-67`).

### 6. Database error mapping

present. All driver errors become `SqlError { cause, message }`
(`server/db.ts:37-50`). The comments and likes services read `cause.code`
(`server/services/discussion-live.ts:35-44`) and map SQLSTATEs to service
errors: comments `23503` → parent-comment-not-found, `23514` / `22001` →
invalid-comment, `42501` → not-authorized, any other code → invalid-comment
with the raw driver message (`server/services/discussion-live.ts:46-81`);
likes `23514` → invalid-vote-count, any other → likes-unavailable with the raw
message (`server/services/discussion-live.ts:83-107`). The HTTP layer maps
reasons to tagged errors with `httpApiStatus` 400/401/403/404/503
(`src/services/discussion-api.ts:37-75`): on write paths invalid-comment
gives 400, so an unknown SQLSTATE on a comment write answers 400 with the
driver message (`server/discussion/api.ts:63-75`); on read paths it gives 400
for invalid-comment and 503 otherwise (`server/discussion/api.ts:54-61`).
Not-authorized splits into 401 or 403 by comparing the message string
(`server/discussion/api.ts:68-71`). The raw OAuth handlers use
`responseForCause`, which answers 500 with `error.message` for unmatched
causes (`server/discussion/api.ts:88-124`). No custom SQLSTATE codes are
raised in SQL.

### 7. Migrations and codegen

present. graphile-migrate with `migrations/committed/` (two files) and
`migrations/current/1-current.sql` (empty placeholder,
`migrations/current/1-current.sql:1`). Schemas are `public`, `auth` and
`hidden`, not `app_*` (`migrations/committed/000001-discussion-schema.sql:6-7`);
`.gmrc` sets `search_path` to `public,auth,hidden` (`.gmrc:2-4`).
Placeholders `:DATABASE_AUTHENTICATOR` and `:DATABASE_VISITOR` come from env
(`.gmrc:5-8`). `afterReset.sql` creates `plpgsql`, `citext`, `pgcrypto`,
grants the database to the owner and `connect` to the authenticator, and sets
the owner (`migrations/afterReset.sql:1-11`). Migration `000001` ends with a
literal `commit;` (`migrations/committed/000001-discussion-schema.sql:390`).
Codegen is kysely-codegen to `generated/DB.ts` (`package.json:34`), run by
`afterAllMigrations` and `afterCurrent` hooks (`.gmrc:12-25`); the output is
committed (`generated/DB.ts:1-4`). Production runs `graphile-migrate migrate`
(`package.json:32`) as the cartridge migrate task (`cartridge.json:56-66`).

### 8. Sessions and cookies

present. Cookie `discussion_session` holds `cookieId.secret`
(`server/discussion/auth.ts:26`, `:135-147`, `:194`). `cookieId` is 24 random
bytes hex, `secret` 32 random bytes hex (`server/discussion/auth.ts:178-181`).
Storage is `hidden.sessions (cookie_id unique, secret_hash, user_id, expires_at)`
(`migrations/committed/000001-discussion-schema.sql:54-60`); the secret is
stored as SHA-256 hex (`server/discussion/auth.ts:36`, `:187`). Expiry is 30
days absolute, set at creation (`server/discussion/auth.ts:28`, `:181`); no
sliding. Lookup runs once per request in the `DiscussionServicesMiddleware`
implementation (`server/discussion/api.ts:135-165`): select by `cookie_id`,
reject when expired, compare hashes with `timingSafeEqual`
(`server/discussion/auth.ts:452-500`). The SQL side looks up the session again
by `cookie_id` only, inside `auth.uid()`
(`migrations/committed/000001-discussion-schema.sql:62-69`). Cookie flags:
HttpOnly, SameSite Lax, Path `/`, `Expires` now + 30 days, Secure when the
request origin is https (`server/discussion/auth.ts:40-46`, `:327-333`); the
origin comes from `x-forwarded-host` / `x-forwarded-proto` headers
(`server/discussion/api.ts:126-130`). Logout (`POST /api/auth/signout`)
deletes the row and expires the cookie (`server/discussion/api.ts:299-317`,
`server/services/discussion-live.ts:187-191`).

### 9. Password auth

absent. GitHub OAuth is the only sign-in
(`src/services/discussion-api.ts:98-178`). No register, login, verify, reset
or change-password endpoint exists.

### 10. OAuth

present. GitHub only, hand-written with the Effect `HttpClient` and
`FetchHttpClient` (`server/discussion/auth.ts:82-90`). `GET /api/auth/github`
builds the authorize URL with scope `read:user` and a random state, and stores
`{redirect, state}` as base64url JSON in cookie `discussion_github_oauth`
(path `/api/auth/github`, 10 minutes) (`server/discussion/auth.ts:345-372`,
`:337-343`). The redirect must start with `/` and not `//`
(`server/discussion/auth.ts:48-58`). The callback checks the state, exchanges
the code, fetches `/user`, decodes both payloads with Schema
(`server/discussion/auth.ts:244-320`, `server/discussion/github-oauth-payload.ts:3-16`),
then finds or creates the user (`server/discussion/auth.ts:198-242`).
Identities live in `auth.oauth_accounts (provider, provider_user_id, user_id)`
with primary key `(provider, provider_user_id)` and unique `(user_id, provider)`
(`migrations/committed/000001-discussion-schema.sql:33-39`). No linking of a
second provider to an existing user. Username comes from the GitHub login,
normalized and suffixed until unique (`server/discussion/auth.ts:149-176`).

### 11. Authorization

present. RLS on `public.profiles` and `public.comments` with policies that
compare `auth.uid()` to `user_id`
(`migrations/committed/000001-discussion-schema.sql:333-388`); details in the
SQL surface. No organizations, memberships or in-app roles. TypeScript also
checks: create and delete require a session
(`server/services/discussion-live.ts:167-179`, `:274-276`, `:322-324`); delete
filters on `user_id` and then reads the row to choose not-found,
not-authorized or already-deleted (`server/services/discussion-live.ts:327-366`).

### 12. Rate limiting

absent. No rate limiter in `server/`. Likes are capped per post and per
client at 10 votes by a check constraint and an `(id, slug)` primary key,
where `id` is a SHA-256 of `request_ip_address()`
(`migrations/committed/000001-discussion-schema.sql:213-218`). The client IP
comes from request headers only: TypeScript takes `cf-connecting-ip`, then
`x-real-ip`, then the first `x-forwarded-for` entry, else `127.0.0.1`
(`server/db.ts:73-77`); SQL takes `cf-connecting-ip`, then `x-forwarded-for`,
then the `dfgcodes.ip_address` setting
(`migrations/committed/000001-discussion-schema.sql:137-144`). The socket
address is not used.

### 13. Realtime

absent. No SSE, WebSocket, LISTEN/NOTIFY or outbox. The client refetches
through React Query invalidation (`src/lib/comments.tsx:82`, `:97`).
`db/realtime.sql` only creates an empty `_realtime` schema and is not loaded
by any script (`db/realtime.sql:1-4`).

### 14. Worker and mail

absent. No job runner, no mail dependency in `package.json:38-97`, no worker
service in `cartridge.json:5-69`.

### 15. Test harness and test database

present. Playwright API tests over TCP (`tests/discussion-api.spec.ts`). The
config starts `bun run-s db:latest start` on port 4173 and waits for
`/api/session` (`playwright.config.ts:3-14`); `test:e2e` builds first
(`package.json:19-20`). The tests use `.env` `DATABASE_URL`, the dev database,
not the `<db>_test` database that `scripts/dbSetup.ts:92-94` creates. Auth is
done by inserting `auth.users` and `hidden.sessions` rows with a direct `pg`
client and sending the cookie (`tests/discussion-api.spec.ts:32-83`); fixtures
delete their rows after each test (`tests/discussion-api.spec.ts:70-74`). No
unit test runner. No `afterReset` reset per test run.

### 16. Telemetry and logging

present (spans and console logs only). Logger is `Logger.consolePretty()`
(`server/index.ts:168`, `server/dev.ts:40`). Each query runs in a
`kysely.execute` client span with `db.query.text`
(`server/db.ts:56-62`). The cartridge sets `OTEL_TRACES_EXPORTER=otlp` and
`OTEL_LOGS_EXPORTER=otlp` (`cartridge.json:26-27`), but no OTLP package
appears in `package.json:38-97` and no exporter layer is provided in
`server/index.ts:167-182`.

### 17. API contract with the frontend

present. One `HttpApi` (`DiscussionApi`) with group `discussion`, prefix
`/api`, defined in `src/services/discussion-api.ts:98-180` with Schema
classes from `src/services/discussion.ts:3-82`. The server implements it with
`HttpApiBuilder.group` (`server/discussion/api.ts:167-323`); the browser uses
`HttpApiClient.make(DiscussionApi)` with `FetchHttpClient` and React Query
(`src/lib/comments.tsx:35-39`). A `HttpApiMiddleware.Service`
(`DiscussionServicesMiddleware`) provides the per-request services
(`src/services/discussion-api.ts:77-84`).

### 18. Deployment

present. One Docker image on `oven/bun:1.4.4` that installs, builds and runs
`bun server/index.ts` (`Dockerfile:3-16`). `cartridge.json` (server-ansible
v2) declares database `dfg_codes` with `citext` and `pgcrypto`
(`cartridge.json:4`), one service `dfg-codes` on port 3000 with route
`dfg.codes` (`cartridge.json:6-17`), env and Vault secrets
(`cartridge.json:18-55`), and a prestart migrate task `bun run db:migrate`
with the `migration` login (`cartridge.json:56-66`). `DATABASE_OWNER` and
`DATABASE_VISITOR` come from the cartridge role mapping
(`cartridge.json:24-25`). Local Postgres is `postgres:17` in Docker Compose
on port 5433 (`docker-compose.yml:3-6`). `nixpacks.toml:1-8` also exists.

### 19. App-only backend features

present.
- Threaded comments as nested JSON built in SQL (`migrations/committed/000001-discussion-schema.sql:146-199`).
- Per-post comment counts (`migrations/committed/000001-discussion-schema.sql:201-211`).
- Anonymous per-IP likes, 0–10 per post (`migrations/committed/000001-discussion-schema.sql:213-250`).
- Top posts ranking with latest comment (`migrations/committed/000001-discussion-schema.sql:252-322`).
- Soft delete of comments through a `before delete` trigger (`migrations/committed/000001-discussion-schema.sql:119-135`).
- React Router SSR handler and static file serving in the same process (`server/index.ts:84-156`).

## SQL surface

### Applied by migrations

Schemas: `public`, `auth`, `hidden`
(`migrations/committed/000001-discussion-schema.sql:6-7`). No `app_public`,
`app_private` or `app_hidden`.

Functions:

| Function | SECURITY DEFINER | Purpose | Cite |
| --- | --- | --- | --- |
| `auth.current_session_id() returns text` | no | Reads `dfgcodes.session_id` setting | `000001:41-43` |
| `auth.uid() returns uuid` | yes, `search_path = pg_catalog, pg_temp` | Unexpired session's `user_id` for `current_session_id()` | `000001:62-69` |
| `public.create_profile() returns trigger` | yes, `search_path = public, auth, pg_catalog` | After insert on `auth.users`, inserts a `profiles` row | `000001:73-87` |
| `hidden.tg__timestamps() returns trigger` | no | Sets `updated_at`; compares `tg_op` to lowercase `'update'` | `000001:100-117` |
| `public.soft_delete_comment() returns trigger` | no | Before delete on `comments`: sets `deleted_at`, cancels the delete | `000001:119-135` |
| `public.request_ip_address() returns text` | no | Client IP from `dfgcodes.headers` / `dfgcodes.ip_address` | `000001:137-144` |
| `public.comment_tree(root_comment_id integer, depth integer default 0, depth_limit integer default 6) returns json` | no | One comment and its children as JSON, recursive to depth 6; deleted body becomes `''` | `000001:146-179` |
| `public.threaded_comments(input_slug text) returns json` | no | Root comments of a slug as `comment_tree` array | `000001:181-199` |
| `public.comments_stats() returns json` | no | `{slug: count}` of non-deleted comments | `000001:201-211` |
| `public.get_likes(input_slug text) returns json` | yes, `search_path = hidden, public, pg_catalog` | `{total, available, max}` for a slug and the caller's IP hash | `000001:220-233` |
| `public.like_post(input_post_id text, requested_votes integer default 1) returns json` | yes, `search_path = hidden, public, pg_catalog` | Upserts the caller's votes, returns `get_likes` | `000001:235-250` |
| `public.top_posts() returns json` | no | Posts ranked by comment count and votes, with latest comment | `000001:252-322` |

(`000001` = `migrations/committed/000001-discussion-schema.sql`.)

`top_posts()` runs with invoker rights and reads `hidden.likes`
(`000001:265-271`). The migrations grant the visitor no usage on schema
`hidden` and no privilege on `hidden.likes` (`000001:9-10`, `:324-331`).
Called as the visitor through `withAuthContext`
(`server/services/discussion-live.ts:259-272`), it may fail with a permission
error; no test calls `/api/top-posts`. Not run; a reader should confirm.

Tables and RLS:

| Table | RLS | Cite |
| --- | --- | --- |
| `auth.users (id, username citext unique, avatar_url)` | no | `000001:27-31` |
| `auth.oauth_accounts` | no | `000001:33-39` |
| `public.profiles (id, username, avatar_url, user_id unique)` | enabled and forced | `000001:47-52`, `:333-334` |
| `hidden.sessions` | no | `000001:54-60` |
| `public.comments` | enabled and forced | `000001:89-98`, `:360-361` |
| `hidden.likes (id default sha256(ip), slug, votes 0..10)` | no | `000001:213-218` |

Policies (all `:DATABASE_VISITOR` unless stated):

| Table | Policy | Command | Condition | Cite |
| --- | --- | --- | --- | --- |
| profiles | `profiles_select` | select | `true` | `000001:336-339` |
| profiles | `profiles_insert` | insert | check `auth.uid() = user_id` | `000001:341-345` |
| profiles | `profiles_update` | update | using and check `auth.uid() = user_id` | `000001:347-352` |
| profiles | `profiles_owner_manage` | all, to `:DATABASE_OWNER` | `true` | `000001:354-358` |
| comments | `comments_select` | select | `true` (deleted rows stay visible; `comment_tree` blanks the body) | `000001:363-366` |
| comments | `comments_insert` | insert | check `auth.uid() = user_id` | `000001:368-371` |
| comments | `comments_update` | update | using and check `auth.uid() = user_id` | `000001:373-377` |
| comments | `comments_delete` | delete | `auth.uid() = user_id` | `000001:379-382` |
| comments | `comments_owner_manage` | all, to `:DATABASE_OWNER` | `true` | `000001:384-388` |

Visitor grants, explicit:

- `usage` on schemas `public` and `auth` (`000001:9-10`).
- `execute` on `auth.current_session_id()` and `auth.uid()` (`000001:45`, `:71`).
- `select, insert, update` on `public.profiles` (`000001:324`).
- `select, insert, update, delete` on `public.comments` (`000001:325`).
- `usage, select` on sequence `public.comments_comment_id_seq` (`000001:326`).
- `execute` on `threaded_comments(text)`, `comments_stats()`, `get_likes(text)`, `like_post(text, integer)`, `top_posts()` (`000001:327-331`).

Visitor grants, default privileges (`000001:12-25`). These apply only to
objects that the `:DATABASE_OWNER` role creates:

- schema `public`: `select, insert, update, delete` on tables; `usage, select` on sequences; `execute` on functions.
- schema `auth`: `select` on tables; `execute` on functions.

When the owner role runs the migration, these add `delete` on `profiles` and
`select` on `auth.users` and `auth.oauth_accounts` to the explicit list.

Authenticator grants (`migrations/committed/000002-authenticator-grants.sql:11-13`):
`usage` on schemas `auth` and `hidden`; `select, insert, update, delete` on
`auth.users`, `auth.oauth_accounts`, `hidden.sessions`.

Roles and creation:

- `scripts/dbSetup.ts:60-94` drops and creates, from `ROOT_DATABASE_URL`: owner (login, password), authenticator (login, password, `noinherit`), visitor (no login), `<db>_shadow` (login, `superuser`); grants visitor to authenticator; creates `<db>`, `<db>_shadow` and `<db>_test`.
- `migrations/afterReset.sql:7-9` grants `connect` to the authenticator and the database to the owner.
- Production: roles come from server-ansible; the cartridge maps `owner` and `visitor` roles and the `api` and `migration` logins (`cartridge.json:22-25`, `:30-42`, `:59-65`). `DATABASE_AUTHENTICATOR` is set to `alchemy_dfg_codes_api` (`cartridge.json:23`).

### In `db/`, not loaded by any script

`rg --hidden` for `init/data`, `roles.sql`, `webhooks.sql` and `db/init`
outside `node_modules` and `.git` finds no reference.
`docker-compose.yml:18-19` mounts only a data volume. These files differ from
the migrations and are listed apart:

- `db/init/data.sql` (rewritten in `55748ea`): creates roles `anon`, `authenticated`, `visitor` (nologin) and grants them to `current_user` (`db/init/data.sql:1-27`); `auth.users` with `raw_user_meta_data` (`:34-38`); `auth.uid()` that reads the `my.user_id` setting, not SECURITY DEFINER (`:40-46`); `hidden.tg__timestamps()` (`:70-76`); `public.request_ip_address()` that reads `request.headers` (`:82-89`); `profiles` with RLS and policies `select_own`, `insert_own`, `update_own` (`:91-118`); `public.create_profile()` SECURITY DEFINER from `raw_user_meta_data` (`:120-136`); `comments` with RLS and policies `select_not_deleted`, `insert_own`, `update_own`, `delete_own` (`:138-171`); `soft_delete_comments()` (`:184-197`); `comment_tree(comment_id int, depth int, depth_limit int)` and `threaded_comments(slug text)`, both SECURITY DEFINER (`:201-250`); `comments_stats()` (`:252-266`); `hidden.likes` with RLS enabled and forced and no policies (`:269-282`); `get_likes(slug text)` and `like_post(post text, requested_votes int)` SECURITY DEFINER (`:291-342`); `top_posts()` SECURITY DEFINER (`:345-411`); trailing `explain analyze` and `vacuum analyze` (`:412-419`). Grants go to `anon`, `authenticated` and `visitor`.
- `db/roles.sql:1-8`: sets passwords for Supabase roles `authenticator`, `pgbouncer`, `supabase_auth_admin`, `supabase_functions_admin`, `supabase_storage_admin`. Last changed in `9dc65ee` (2024).
- `db/webhooks.sql:1-208`: Supabase `supabase_functions` schema, `http_request()` trigger function (SECURITY DEFINER), `pg_net` grants, role `supabase_functions_admin`.
- `db/logs.sql:1-4`, `db/realtime.sql:1-4`: create empty `_analytics` and `_realtime` schemas.
