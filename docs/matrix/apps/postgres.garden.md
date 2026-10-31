# postgres.garden

App root: `~/build/postgres.garden`. Paths below are relative to it. Citations
are to commit `13c598f` with a clean working tree.

**What the app is:** a browser SQL playground (PGlite in the browser, VS Code
workbench UI). The backend stores users, sessions and saved playgrounds
("playgrounds" with a commit chain). Anonymous visitors can save a playground
held by an edit key.

**SQL-only features:** organizations, memberships, invitations and
`playground_comments` exist in the schema, but no server or client code
calls them (`rg organization|playground_comments` in `server/` and `src/`
finds only a type import at `server/db.ts:21`).

## Rows

1. **Runtime and HTTP layer**: present. Bun. `bun --hot server/index.ts` in
   dev (`package.json:9`); production runs an esbuild bundle
   (`scripts/serverBuild.ts:17-21`, target `node22`, ESM) with
   `bun dist/server.js` (`package.json:18`). Bun owns the socket:
   `Bun.serve` with a 64MB `maxRequestBodySize` (`server/index.ts:346-354`).
   Effect builds only a web handler: `HttpRouter.toWebHandler` over
   `HttpApiLive` + `TelemetryLive`, with `HttpServer.layerServices`,
   `NodeFileSystem.layer`, `NodePath.layer` (`server/index.ts:322-328`).
   Router is `HttpApi`: `PgGardenApi` with groups `system`, `auth`,
   `apiUsers`, `apiPlaygrounds`, `webhooks` (`server/apiSchema.ts:586-591`);
   handlers composed with `HttpApiBuilder.layer` + `HttpApiBuilder.group`
   (`server/apiHandlers.ts:992-1017`). `fetch` dispatches by path:
   `/api/testing*` to test routes outside production, `isApiPath` to the API,
   all else to the page responder (`server/index.ts:355-367`). `isApiPath`
   derives from the contract's endpoints (`server/apiSchema.ts:581-584`).
   The page responder is Vite middleware bridged through fake Node
   `IncomingMessage`/`ServerResponse` in dev (`server/index.ts:78-173`) and a
   manifest-driven static server plus SSR data injection in prod
   (`server/index.ts:233-317`). A second `ManagedRuntime` (session service,
   pools, file system, no telemetry) serves SSR page data and the readiness
   wait (`server/index.ts:63-76`). The server waits for both pools and
   Valkey before `Bun.serve` (`server/index.ts:344`, `server/ready.ts:25-34`).
   Shutdown: `process.on("SIGINT"|"SIGTERM")` disposes handlers and the
   runtime (`server/index.ts:383-406`). COEP/COOP/CORP headers are added to
   every response (`server/index.ts:35-45`).
   Fix: `11bb6c8` replaced a hand-kept list of nine API paths with the
   contract-derived `isApiPath`; a new endpoint was served the SPA shell
   with 200.

2. **Versions and data stack**: present. `effect` 4.1.0,
   `@effect/platform-node` 4.1.0, `@effect/opentelemetry` 4.1.0,
   `@effect/vitest` 4.1.0 (`package.json:239,213,211,277`). `pg` ^8.18.0 +
   `kysely` ^0.28.15 (`package.json:256,245`); no `@effect/sql-*`.
   `kysely-codegen` ^0.20.0, `graphile-migrate` ^2.0.0-rc.2,
   `graphile-worker` ^0.16.6 (`package.json:246,240,241`). `iovalkey`
   ^0.3.3 for Valkey (`package.json:244`). `pg` parses int8 as `BigInt`
   (`server/db.ts:27`).

3. **Config and env**: present. Server env is an Effect Schema struct
   decoded once with `S.decodeUnknownSync(envSchema)(process.env)` at import
   (`server/assertEnv.ts:4`, `server/envSchema.ts:9-42`). Required:
   `NODE_ENV` (literal union), `PORT`, `VITE_ROOT_URL` (trailing slash
   stripped), `DATABASE_URL`, `AUTH_DATABASE_URL`, `DATABASE_VISITOR`
   (`server/envSchema.ts:10-32`). Optional: GitHub OAuth id/secret, `GITHUB_PAT`,
   `GITHUB_WEBHOOK_SECRET`, `VALKEY_URL`, OTLP and devtools URLs
   (`server/envSchema.ts:33-41`). The pools read their URL a second time
   through `Config.Redacted` (`server/db.ts:259-268`); `HOST` comes from
   `Config.String` with default `0.0.0.0` (`server/index.ts:33`). Env files:
   `bun --env-file=.env` in scripts (`package.json:34,39,44`);
   `scripts/dbEnsure.ts:3` loads `dotenv/config`. `.env` generator:
   `scripts/generateEnvFile.ts` (prompts or derives `DATABASE_NAME`,
   `DATABASE_OWNER`, `DATABASE_AUTHENTICATOR`, `DATABASE_VISITOR`, `PORT`,
   `VITE_ROOT_URL`, `SECRET`; `generateEnvFile.ts:43-74`); the database URLs
   are written by `ops dev db up`, not by this script
   (`generateEnvFile.ts:46`). The worker reads `MAIL_PROVIDER`,
   `CLOUDFLARE_EMAIL_API_TOKEN`, `EMAIL_FROM` from `process.env` directly
   (`worker/transport.js:33-52`, `worker/tasks/send_email.js:21`).

4. **Pools and roles**: present. Two `pg.Pool`s, each wrapped in Kysely, with
   default pool size (`server/db.ts:62-63`): `RootPool` from `DATABASE_URL`
   and `AuthPool` from `AUTH_DATABASE_URL` (`server/db.ts:259-272`). Roles:
   owner `postgres_garden_owner` (`.gmrc:13`); visitor
   `${DATABASE_NAME}_visitor`; authenticator `alchemy_${DATABASE_NAME}_api`
   (`scripts/generateEnvFile.ts:60-65`). In production the logins are
   `migration` (root pool, `DATABASE_URL`) and `api` (`AUTH_DATABASE_URL`)
   (`cartridge.json:45-56`). Per request the visitor transaction runs
   `select set_config('role', $visitor, true), set_config('my.session_id',
   $session, true)`, both transaction-local (`server/db.ts:96-102`).
   `withRequestTransaction` holds one lazily opened authenticator transaction
   per request, guarded by a semaphore; all `asVisitor` calls in the request
   join it; it commits on success and rolls back on failure
   (`server/db.ts:117-143,224-237`). The session middleware wraps every
   endpoint in it (`server/services/sessionMiddleware.ts:37-45`). `asRoot`
   always opens its own owner transaction, so owner writes (lockout
   counters) do not roll back with the request (`server/db.ts:191-212`).
   Outside a request (SSR page data, readiness probes, tests) each
   `asVisitor` opens its own transaction (`server/db.ts:163-170`,
   `server/layers/getPageData.ts:57`).

5. **Typed handles**: present. The pool tags are private classes
   (`server/db.ts:239-240`); code gets a connection only through
   `asVisitor(use)` / `asRoot(use)` or the closures `visitorQuerier` /
   `rootQuerier` that services resolve once in their constructor
   (`server/db.ts:158-212`, `server/services/playgroundService.ts:157-159`).
   `use` receives `Kysely<DB>`; `DB` comes from `generated/db.ts` and covers
   every schema (`app_public`, `app_private`), so the type does not restrict
   which tables the visitor handle can name; only Postgres grants and RLS do.
   `asVisitor` requires `CurrentSession` in context (`server/db.ts:184-189,256`).
   `runQuery` wraps `execute()` in `Effect.tryPromise` with a `db.query` span
   (`server/db.ts:53-56`).
   Fix: `abb6e91` put the user read (`for key share`) and the session insert
   in one owner transaction; a concurrent account delete caused an FK
   violation that answered 500 (`server/services/sessionService.ts:70-96`).

6. **Database error mapping**: present. `DatabaseError` tagged error wraps
   the cause (`server/db.ts:34-42`). `unwrapPgError` decodes either a raw
   `pg.DatabaseError` or `DatabaseError{cause}` (`server/db.ts:291-308`).
   `handleDbError`: a SQLSTATE in `CUSTOM_ERROR_CODES` (LOCKD, WEAKP, LOGIN,
   DNIED, CREDS, MODAT, TAKEN, EMTKN, CDLEA, VRFY1, VRFY2, ISMBR, NTFND,
   OWNER) answers 400 with the database message; anything else is logged and
   answers 500 with a route-specific fallback string
   (`server/db.ts:274-289,315-323`). Handlers wrap services in `withDbError`
   (400 `ApiError` / 500 `ServerError`) or `withDbErrorOrMissing`, which maps
   `NoSuchElementError` to 404 `NotFound` (`server/apiHandlers.ts:143-204`).
   Every custom code is 400, including LOGIN and DNIED. Auth flows map codes
   to domain errors first: `MODAT`/`WEAKP`/`23505` on register
   (`server/services/authService.ts:61-79`), `LOCKD` on login
   (`server/services/authService.ts:183-192`), `TAKEN` on OAuth link
   (`server/services/oauthService.ts:273-283`); handlers turn those into 409
   `Conflict`, 401 `Unauthorized`, 423 `Locked`
   (`server/apiHandlers.ts:372-422`). HTTP errors are `S.TaggedError`s with
   `httpApiStatus` (`server/errors.ts:7-40`). The session middleware maps a
   `DatabaseError` escaping the request to 500
   (`server/services/sessionMiddleware.ts:40-45`). An unmapped pg error in
   the auth services becomes a defect (`Effect.die`)
   (`server/services/authService.ts:137-145`).
   Fixes: `6bf3719` logs the whole cause chain, since `tryPromise` hid the
   real message; `6e10b9e` removed a TypeScript copy of the
   private-playground rule so the database trigger's DNIED is the only
   answer.

7. **Migrations and codegen**: present. graphile-migrate, `.gmrc` with
   `databaseOwner` (`.gmrc:13`), `search_path` app_public, app_private,
   app_hidden, public (`.gmrc:26`), placeholder `:DATABASE_VISITOR` from env
   (`.gmrc:47`). Layout: `migrations/committed/000001-000005.sql` and
   `migrations/current/1-current.sql`. Schemas: `app_public`, `app_hidden`,
   `app_private` (`000001.sql:47-49`); `app_hidden` holds no objects.
   `afterReset` runs `ops dev db reset "$GM_DBNAME"` on the shadow DB, then
   `afterReset.sql` (`.gmrc:69-72`), which grants CONNECT to the owner and to
   every member of the visitor role, and sets the owner of `public`
   (`migrations/afterReset.sql:1-21`). Extensions come from `cartridge.json`
   (`cartridge.json:7`, `afterReset.sql:20`). Codegen: `kysely-codegen`
   writing `generated/db.ts`, int8 as bigint, graphile schemas excluded
   (`.kysely-codegenrc.json`); triggered by `afterCurrent` in watch mode,
   then `oxfmt` on the output (`.gmrc:90-96`). Production runs
   `graphile-migrate migrate` then `graphile-worker --schema-only` before
   start (`package.json:19-20`).
   Fixes: `033a88c` committed migrations that lived only in `current/`,
   because `migrate` does not run `current`; a deployed database lacked
   `create_playground_commit`, `fork_playground` and `head_commit_id`.
   `d214472` stopped passing the database URL in argv to codegen.

8. **Sessions and cookies**: present. Cookie `session` =
   `${id}.${secret}`, both 32 random bytes as hex
   (`server/services/sessionService.ts:61-113`, `server/secrets.ts:22-24`).
   Storage is two places: a Valkey hash at
   `postgres-garden:session:<id>` holding `secret_hash` (SHA-256 hex),
   `session_uuid`, `user_id`, `username`, `role`, `is_verified`, TTL 30 days
   (`sessionService.ts:18-20,100-111`); and a row in `app_private.sessions`
   (id = `session_uuid`, `expires_at` = now + 30 days)
   (`sessionService.ts:86-92`). The table's `secret_hash` and `session_data`
   columns are not written (`000001.sql:152-159`). Lookup per request:
   `HttpApiSecurity.apiKey({in: "cookie", key: "session"})`
   (`server/apiSchema.ts:36`) feeds `SessionMiddleware`
   (`apiSchema.ts:64-72`); `validateSessionToken` reads the hash, returns
   anonymous on an empty hash, decodes it with a Schema, compares digests in
   constant time, then checks the PG row exists and is unexpired, deleting
   the Valkey key if not (`sessionService.ts:120-184`). Any lookup failure is
   anonymous (`sessionMiddleware.ts:33-35`). Expiry is absolute, no sliding.
   Cookie: `HttpOnly`, `SameSite=Lax`, `Secure` in production, `Path=/`,
   `Expires` (`sessionMiddleware.ts:51-60`). Logout deletes the Valkey key and
   the row (`sessionService.ts:186-195`) and expires the cookie
   (`sessionMiddleware.ts:64-71`). A second, hand-written cookie builder
   serves OAuth and the test routes (`server/services/cookies.ts:7-17`).
   `app_public.current_user_id()` reads `app_private.sessions` by
   `my.session_id` and does not check `expires_at` (`000001.sql:170-173`).
   Fixes: `875d78b` moved keys under the app prefix that the platform Valkey
   ACL requires; `3de6ece` decodes the cached hash instead of defaulting the
   role to "visitor"; `8dcbd15` treats an empty hash as absence so junk
   cookies stop logging warnings; `abb6e91` (row 5).

9. **Password auth**: present. Register: `app_private.really_create_user`
   via root pool (`authService.ts:103-126`), then `createSession`. Login:
   `app_private.login(username|email, password)` via root pool, returns
   null on a bad password so the failed-attempt write commits
   (`authService.ts:147-170`, `000001.sql:636-698`). Lockout: 3 failures in 5
   minutes raises LOCKD (`000001.sql:669-677`). Hashing: pgcrypto
   `crypt(..., gen_salt('bf'))` in SQL (`000001.sql:1111,966`). Password rule:
   length >= 8 (`000001.sql:842-849`). Verify email:
   `app_public.verify_email` via root (`server/services/userService.ts:142-152`);
   tokens from `gen_random_bytes(7)` hex (`000001.sql:450`). Forgot password:
   `app_public.forgot_password` via root (`userService.ts:105-112`); 3-minute
   resend floor, unregistered-email throttle of 15 minutes
   (`000001.sql:741-827`). Reset: `app_private.reset_password` via root,
   20-failure lock in 3 days, deletes all sessions (`userService.ts:114-128`,
   `000002.sql:54-126`). Change password: `app_public.change_password` via
   visitor, deletes other sessions (`userService.ts:130-140`,
   `000001.sql:947-991`). Account deletion: request/confirm functions via
   visitor (`userService.ts:16-40`). All flow logic is SQL; TypeScript only
   calls the functions. The server does not call `app_public.logout()`.
   Fix: `92f0135` made `reset_password` reject when no reset is pending; a
   NULL token comparison skipped the reject branch and allowed account
   takeover via `POST /resetPassword`.

10. **OAuth**: present. GitHub only, library `arctic` 3
    (`server/services/oauthService.ts:161-170`). Flow: `/auth/github` sets a
    `github_oauth_state` cookie (Max-Age 600) and redirects
    (`server/apiHandlers.ts:331,452-487`); callback compares state, exchanges
    the code, reads `/user` and `/user/emails`
    (`oauthService.ts:186-242`). Role is resolved with a GraphQL sponsor
    query using `GITHUB_PAT` (`oauthService.ts:116-159`). Storage and linking:
    `app_private.link_or_register_user` (root pool), which links to the
    logged-in user, else to a user with the same verified email, else
    registers (`oauthService.ts:256-283`, `000001.sql:1214-1312`).
    Identities live in `app_public.user_authentications`; tokens in
    `app_private.user_authentication_secrets.details`
    (`000001.sql:562-618`). A session is created only when no user is logged
    in (`oauthService.ts:295-299`). The callback answers an HTML page for the
    popup (`apiHandlers.ts:263-345,526-534`). A GitHub sponsorship webhook
    verifies with `@octokit/webhooks` and enqueues `sponsor_webhook`
    (`server/services/webhookService.ts:42-66`).
    Fix: `29fcecf` moved sign-in to one channel; COOP `same-origin` made the
    popup handle read `closed === true` and cancel sign-in.

11. **Authorization**: present. RLS on 14 tables (see SQL surface).
    Identity comes from `app_public.current_user_id()`. App roles are the
    enum `user | sponsor | pro | admin` on `app_public.users`
    (`000001.sql:187`); admin reads and writes any playground through
    policies and definer functions. The private-playground entitlement is
    `app_public.may_have_private` called by a trigger (`000004.sql:21-57`).
    Organizations, memberships and invitations exist in SQL only. TypeScript
    checks: `requireSession` returns 401 on endpoints that need a login
    (`server/apiHandlers.ts:207-221`); listings add a TypeScript filter that
    hides `secret` playgrounds, which RLS still allows
    (`server/services/playgroundVisibility.ts:6-20`,
    `playgroundService.ts:180,208,253`).
    Fixes: `6e10b9e` (row 6); `b4b54c0` stated the entitlement once;
    `d0cbd4f` fixed three `fork_playground` defects, including a definer read
    that let any caller copy a playground whose hash they knew
    (`000002.sql:278-324`).

12. **Rate limiting**: absent. No request rate limiting exists
    (`rg` finds none). The current migration says so: "Nothing caps how many
    playgrounds a visitor may start, which is a rate limit, and there is
    none" (`migrations/current/1-current.sql:12-13`). Throttles exist only
    inside SQL flows: login lockout, reset lock, forgot-password intervals
    (row 9). No client IP handling.

13. **Realtime**: absent. No SSE, WebSocket, LISTEN/NOTIFY or outbox in
    `server/`, `worker/` or `migrations/` (`rg -i
    "listen|notify|EventSource|event-stream|WebSocket"` finds only comments).

14. **Worker and mail**: present. graphile-worker CLI run from `worker/`
    (`package.json:39-41`), reading `DATABASE_URL` from env; the production
    worker uses the `migration` login (`cartridge.json:95-101`). Tasks are
    plain JS files: `send_email`, `user__audit`, `user__forgot_password`,
    `user__forgot_password_unregistered_email`,
    `user__send_delete_account_email`, `user_emails__send_verification`,
    `sponsor_webhook`, `prune_expired_playgrounds` (`worker/tasks/`). Cron:
    `prune_expired_playgrounds` daily at 03:00 UTC (`worker/crontab:16`).
    Jobs are enqueued from SQL (`graphile_worker.add_job` in triggers and
    functions, e.g. `000001.sql:88,540,771`) and from the webhook service.
    Mail: nodemailer; `MAIL_PROVIDER` is `development` (ethereal, account
    cached in `worker/.ethereal`), `test` (JSON transport), or `cloudflare`
    (SMTP `smtp.mx.cloudflare.net:465`, user `api_token`)
    (`worker/transport.js:17-113`). Templates: MJML through `lodash.template`
    with `[[ ]]` escaping, then `html-to-text` for the text part
    (`worker/tasks/send_email.js:50-108`, `worker/templates/*.mjml`). A
    rejected recipient throws so the job retries (`send_email.js:69-71`).
    The `_500_send_email` trigger on `organization_invitations` enqueues
    `organization_invitations__send_invite`, which has no task file
    (`000001.sql:1517-1518`).
    Change: `36cc1c8` moved mail from SES to Cloudflare.

15. **Test harness and test database**: present. vitest with
    `@effect/vitest` `layer(...)` + `it.effect`; includes
    `server/**`, `worker/**`, `src/features/**` (`vitest.config.ts:6-8`).
    `src/shared/routes.test.ts:1` imports `bun:test` and is outside that
    include. HTTP is in-process: `HttpRouter.toWebHandler(HttpApiLive)` with
    no TCP listen (`server/auth.test.ts:26-66`). No separate test database:
    `test:unit` loads `.env` and tests run against the dev database
    (`package.json:34`); suites seed rows with `asRoot` and delete them
    (`server/testSupport.ts:20-36`). Auth in tests goes through real
    endpoints or the dev-only `/api/testing/*` routes (create user, login,
    read secrets, clear test users), guarded by a layer that dies in
    production (`server/testing.ts:262-284`). Valkey is the real instance
    (`server/auth.test.ts:17`). E2E: Playwright against `localhost:3000`
    with a `globalSetup` that clears test users
    (`playwright.config.ts:23,29`, `e2e/globalSetup.ts:12-16`). k6 load
    scripts in `k6/`.

16. **Telemetry and logging**: present. `Otlp.layerFromConfig` with
    service name `postgres-garden`, JSON serialization, fetch client; export
    turns on only when `OTEL_*_EXPORTER=otlp` (`server/telemetry.ts:10-15`,
    `cartridge.json:35-36`). `DevTools.layer(VITE_DEVTOOLS_URL)` in non-production
    when set (`server/telemetry.ts:22-23`). Spans: `db.query` per query
    (`server/db.ts:55`), readiness spans (`server/ready.ts:33,49`).
    Metrics: counters `auth.attempts`, `auth.active_sessions`,
    `webhook.received`, `http.errors` (`server/metrics.ts:7-21`). Request
    context from `x-request-id`, `x-ui-action`, `x-ui-feature`,
    `traceparent` is logged on errors (`server/apiHandlers.ts:63-103`). Log
    format is the default Effect logger; nothing configures it. Browser
    traces use the OpenTelemetry web SDK to `VITE_OTEL_COLLECTOR_URL`
    (`src/telemetry.ts:4,11`). The SSR runtime has no telemetry layer
    (`server/index.ts:63-68`).

17. **API contract with the frontend**: present. One `HttpApi` definition in
    `server/apiSchema.ts`, kept free of server imports so the browser imports
    it (`apiSchema.ts:1-12`). The browser builds `HttpApiClient.make(PgGardenApi)`
    with `credentials: "include"` (`src/httpapi-client.ts:102-104,136`).
    Webviews call through a relay in the extension host, limited to the
    contract's routes minus webhooks (`apiSchema.ts:551-564`). Row shapes
    are Schemas mirroring `generated/db.ts` (`server/models.ts:1-61`). SSR
    injects `window.__INITIAL_DATA__` encoded with `PageStateSchema`
    (`server/index.ts:47-61`). The `auth` group has no `/api` prefix
    (`/register`, `/login`, `/me`, `/logout`, `/auth/github*`)
    (`apiSchema.ts:478-524`); `system` and `webhooks` have no session
    middleware (`apiSchema.ts:468-476,526-528`).

18. **Deployment**: present. `cartridge.json` (`server-ansible/v2`): one
    Postgres database with six extensions, Valkey, two services from one
    image: `postgres-garden-server` (`bun run start:prod`, health check
    `/healthz`) and `postgres-garden-worker` (`bun run worker:prod`)
    (`cartridge.json:1-111`). Secrets: two Postgres logins, Valkey URL,
    GitHub OAuth id/secret and PAT from KV; `GITHUB_WEBHOOK_SECRET` is not
    provided (`cartridge.json:44-76`). Dockerfile: two-stage `oven/bun:1.4.4`,
    copies `dist`, `worker`, `migrations`, `.gmrc`, `scripts`, `lib`
    (`Dockerfile:1-39`). Also a `docker-compose.yml` (app, worker, Valkey;
    `docker-compose.yml:9,49,57`) and `nixpacks.toml`. `/healthz` probes both
    pools and Valkey once with a 2s timeout and answers 503 naming the
    dependency (`server/ready.ts:42-50`, `server/apiHandlers.ts:972-986`).
    Change: `d1853c9` made the image startable from cartridge variables;
    `e3f88b3` made `/healthz` real.

19. **App-only backend features**:
    - Playgrounds with a commit chain (`head_commit_id`, parent ids), fork,
      star, search, diff and history endpoints (`server/apiSchema.ts:327-466`).
    - Anonymous save held by an edit key: SHA-256 digest stored, key
      returned once, claim on login (`000005.sql:17-217`,
      `playgroundService.ts:286-347`).
    - Per-role storage quota and size-based retention for anonymous
      playgrounds (`current/1-current.sql:14-24`, `000001.sql:1977-1996`).
    - GitHub sponsor role sync via OAuth-time GraphQL and webhook
      (`oauthService.ts:116-159`, `worker/tasks/sponsor_webhook.js`).
    - SSR initial-data injection into the Vite page (`server/index.ts:47-61`).
    - AI model catalog generation (`scripts/generateModelCatalog.ts`).

## SQL surface

"SD" = `SECURITY DEFINER`. Every SD function sets
`search_path to pg_catalog, public, pg_temp`. Line numbers point to the
body that is live after all migrations.

### Functions in `app_public`

| Signature | SD | Live body | Purpose |
|---|---|---|---|
| `current_session_id() returns text` | no (stable) | `000001.sql:166-168` | `my.session_id` setting, empty string as null. |
| `current_user_id() returns uuid` | yes (stable) | `000001.sql:170-173` | User id of the session row; no expiry check. |
| `users_has_password(u users) returns boolean` | yes | `000001.sql:272-274` | Whether the current user has a password hash. |
| `tg__user_emails__forbid_if_verified() trigger` | yes | `000001.sql:340-347` | Refuse an email already verified elsewhere (EMTKN). |
| `tg__user_emails__prevent_delete_last_email() trigger` | yes | `000001.sql:376-417` | Refuse deleting the last (verified) email (CDLEA). |
| `verify_email(user_email_id uuid, token text) returns boolean` | yes (strict) | `000001.sql:473-487` | Mark email verified when token matches. |
| `tg__user_emails__verify_account_on_verified() trigger` | yes | `000001.sql:495-500` | Set `users.is_verified` on first verified email. |
| `make_email_primary(email_id uuid) returns user_emails` | yes | `000001.sql:509-525` | Swap primary email (DNIED, VRFY1). |
| `resend_email_verification_code(email_id uuid) returns boolean` | yes | `000001.sql:531-545` | Enqueue verification email. |
| `logout() returns void` | yes | `000001.sql:705-712` | Delete current session row. Not called by server. |
| `forgot_password(email citext) returns void` | yes (strict) | `000001.sql:741-827` | Issue reset token and enqueue mail, throttled. |
| `request_account_deletion() returns boolean` | yes (strict) | `000001.sql:859-900` | Issue delete token and enqueue mail (LOGIN). |
| `confirm_account_deletion(token text) returns boolean` | yes (strict) | `000001.sql:906-939` | Delete current user on token match (DNIED). |
| `change_password(old_password text, new_password text) returns boolean` | yes (strict) | `000001.sql:947-991` | Check old, set new, drop other sessions (CREDS, LOGIN). |
| `current_user_member_organization_ids() returns setof uuid` | yes (stable) | `000001.sql:1382-1385` | Orgs the user belongs to; used by policies. |
| `current_user_invited_organization_ids() returns setof uuid` | yes (stable) | `000001.sql:1387-1390` | Orgs the user is invited to; used by policies. |
| `create_organization(slug citext, name text) returns organizations` | yes | `000001.sql:1405-1414` | Create org with caller as owner and billing contact. |
| `invite_to_organization(organization_id uuid, username citext = null, email citext = null) returns void` | yes | `000001.sql:1416-1464` | Owner invites a user or email. |
| `organization_for_invitation(invitation_id uuid, code text = null) returns organizations` | yes (stable) | `000001.sql:1466-1496` | Resolve an invitation the caller may accept. |
| `accept_invitation_to_organization(invitation_id uuid, code text = null) returns void` | yes | `000001.sql:1498-1513` | Join org and delete invitation. |
| `organizations_current_user_is_owner(org organizations) returns boolean` | no (stable) | `000001.sql:1522-1532` | Computed column. |
| `organizations_current_user_is_billing_contact(org organizations) returns boolean` | no (stable) | `000001.sql:1534-1544` | Computed column. |
| `remove_from_organization(organization_id uuid, user_id uuid) returns void` | yes | `000001.sql:1554-1599` | Owner removes member, or member leaves. |
| `tg_users__deletion_organization_checks_and_actions() trigger` | no | `000001.sql:1603-1628` | Block deleting an org owner (OWNER). |
| `delete_organization(organization_id uuid) returns void` | yes | `000001.sql:1637-1651` | Owner deletes org. |
| `transfer_organization_ownership(organization_id uuid, user_id uuid) returns organizations` | yes | `000001.sql:1653-1683` | Move ownership. |
| `transfer_organization_billing_contact(organization_id uuid, user_id uuid) returns organizations` | yes | `000001.sql:1685-1716` | Move billing contact. |
| `max_storage_bytes(p_role user_role default null) returns bigint` | no (immutable) | `current/1-current.sql:14-24` | Quota per role; null role = 1MB. Was without default in `000001.sql:1893-1901`. |
| `calculate_retention(p_size_bytes bigint) returns interval` | no (immutable) | `000001.sql:1977-1996` | 30-365 days by size, for anonymous playgrounds. |
| `create_playground_commit(p_playground_name text, p_commit_message text, p_commit_data jsonb, p_playground_hash text = null, p_playground_description text = null, p_privacy privacy = 'secret', p_edit_key_hash bytea = null) returns playground_commit_result` | yes | `current/1-current.sql:29-165` | Create playground or commit to one; quota, edit key, head update. Earlier: 5 args `000001.sql:2021`, `000002.sql:160`; 6 args `000003.sql:29` (5-arg dropped at `:27`); 7 args `000005.sql:41` (6-arg dropped at `:39`). |
| `fork_playground(p_source_hash text, p_new_name text = null) returns playground_commit_result` | yes | `000004.sql:74-168` | Copy latest commit to a new playground owned by caller; re-checks read rule. Earlier `000001.sql:2149`, `000002.sql:286`. |
| `may_have_private(v_user_id uuid) returns boolean` | yes (stable) | `000004.sql:21-27` | The private-playground entitlement. |
| `claim_playground(p_hash text, p_edit_key_hash bytea) returns playgrounds` | yes | `000005.sql:183-212` | Take ownership of an anonymous playground by key. |

Types: `user_role` enum, `username` and `url` domains (`000001.sql:187-189`),
`privacy` enum (`000001.sql:1719-1723`), `playground_commit_result`
composite (`000001.sql:1963-1969`).

### Functions in `app_private`

| Signature | SD | Live body | Purpose |
|---|---|---|---|
| `tg__timestamps() trigger` | no | `000001.sql:75-81` | Keep `created_at` fixed and `updated_at` monotonic. |
| `tg__add_job() trigger` | yes | `000001.sql:86-91` | Enqueue job `tg_argv[0]` with `{id}`. |
| `tg__add_audit_job() trigger` | yes | `000001.sql:96-149` | Enqueue `user__audit` with event details. |
| `tg__user_secrets__insert_with_user() trigger` | no | `000001.sql:253-258` | Create `user_secrets` row per user. |
| `tg__user_email_secrets__insert_with_user_email() trigger` | yes | `000001.sql:445-455` | Create email secret row with verification token. |
| `login(username citext, password text) returns users` | no (strict) | `000001.sql:636-698` | Password check with lockout counter. Called by owner pool. |
| `assert_valid_password(new_password text) returns void` | no | `000001.sql:842-849` | Length >= 8 (WEAKP). |
| `reset_password(user_id uuid, reset_token text, new_password text) returns boolean` | no (strict) | `000002.sql:54-126` | Token check with lock, set password, drop sessions. Original `000001.sql:995-1064`. |
| `really_create_user(username citext, email text, email_is_verified bool = false, name text = null, avatar_url text = null, role user_role = 'user', password text = null) returns users` | no | `000001.sql:1076-1120` | Insert user, email, password hash (MODAT, WEAKP). |
| `register_user(f_service varchar, f_identifier varchar, f_profile json, f_auth_details json, f_email_is_verified boolean = false) returns users` | yes | `000001.sql:1130-1196` | OAuth registration with unique username. |
| `link_or_register_user(f_user_id uuid, f_service varchar, f_identifier varchar, f_profile json, f_auth_details json) returns users` | yes | `000001.sql:1214-1312` | Link identity or register (TAKEN). |
| `prune_expired_playgrounds() returns table(deleted_count int)` | yes | `000001.sql:2229-2246` | Delete expired anonymous playgrounds. Run by cron. |
| `tg__playgrounds__privacy_entitlement() trigger` | yes | `000004.sql:38-57` | Refuse `private` for anonymous or unentitled owner (DNIED). Original `000002.sql:13-35`. |

### Functions in `app_hidden`

None. The schema is created (`000001.sql:48`) and stays empty.

### Triggers

- `users`: `_100_timestamps` (`000001.sql:224-227`), `_500_insert_secrets`
  (`:259-262`), `_500_deletion_organization_checks_and_actions` before
  delete when a session is set (`:1630-1635`).
- `user_emails`: `_100_timestamps` (`:312-315`), `_200_forbid_existing_email`
  (`:348-351`), `_500_audit_added` (`:318-326`), `_500_audit_removed`
  (`:329-337`), `_500_prevent_delete_last` statement-level (`:423-427`),
  `_500_insert_secrets` (`:456-459`), `_500_verify_account_on_verified`
  (`:502-507`), `_900_send_verification_email` (`:355-359`).
- `user_authentications`: `_100_timestamps` (`:579-582`),
  `_500_audit_removed` (`:594-602`).
- `organization_invitations`: `_500_send_email` enqueues
  `organization_invitations__send_invite` (`:1517-1518`).
- `playgrounds`: `_100_timestamps` (`:1820-1824`),
  `_200_privacy_entitlement` before insert or update of privacy, user_id
  (`000002.sql:37-41`).
- `playground_comments`: `_100_timestamps` (`000001.sql:1882-1886`).

### Tables with RLS enabled, and their policies

No table uses `FORCE ROW LEVEL SECURITY`, so the owner and definer
functions bypass RLS (`000002.sql:7-12`).

| Table | RLS line | Policies (name, command, condition) |
|---|---|---|
| `app_private.sessions` | `000001.sql:164` | none |
| `app_public.users` | `000001.sql:203` | `select_all` select `true`; `update_self` update `id = current_user_id()` (`:211-215`) |
| `app_private.user_secrets` | `000001.sql:247` | none |
| `app_public.user_emails` | `000001.sql:298` | `select_own` select, `insert_own` insert check, `delete_own` delete; all `user_id = current_user_id()` (`:362-368`) |
| `app_private.user_email_secrets` | `000001.sql:443` | none |
| `app_public.user_authentications` | `000001.sql:573` | `select_own` select, `delete_own` delete; `user_id = current_user_id()` (`:585-588`) |
| `app_private.user_authentication_secrets` | `000001.sql:618` | none |
| `app_public.organizations` | `000001.sql:1341` | `select_member` select, id in member orgs; `select_invited` select, id in invited orgs (`:1392-1396`); `update_owner` update, caller is owner member (`:1546-1552`) |
| `app_public.organization_memberships` | `000001.sql:1357` | `select_member`, `select_invited` select, same org sets (`:1398-1402`) |
| `app_public.organization_invitations` | `000001.sql:1376` | none |
| `app_public.playgrounds` | `000001.sql:1749` | `select_public_secret_or_own` select: privacy public/secret, or own, or admin (`:1759-1767`); `insert_authenticated` insert check: own, not null, and not private unless `may_have_private` (`000004.sql:62-68`); `insert_anonymous` insert check: `user_id is null` and privacy public/secret (`000005.sql:29-34`); `update_own_or_admin` update: owner not null and (own or admin) (`000001.sql:1790-1799`); `delete_own_or_admin` delete: same (`:1802-1811`) |
| `app_public.playground_stars` | `000001.sql:1837` | `select_all` select `true`; `insert_own` insert check own; `delete_own` delete own (`:1839-1844`) |
| `app_public.playground_comments` | `000001.sql:1864` | `select_all` select `true`; `insert_own`, `update_own`, `delete_own` on `user_id = current_user_id()` (`:1866-1873`) |
| `app_public.playground_commits` | `000001.sql:1924` | `select_own_and_playground_owner` select: own commit, or playground public/secret/own (`:1926-1934`); `insert_own` insert check: own, or both null (`:1936-1940`); `delete_own` delete own (`:1942-1943`); `manage_all_as_admin` all: caller is admin (`:1945-1949`) |

`app_private.unregistered_email_password_resets` has no RLS
(`000001.sql:733-737`). The playgrounds insert policies are commented as
unreachable while all inserts go through definer functions
(`000004.sql:59-61`, `000005.sql:23-28`).

### Grants to the visitor role (`:DATABASE_VISITOR`)

- Schema: `revoke all on schema public from public`; default privileges
  revoke all on sequences and functions from public (`000001.sql:29-32`).
- Schema usage on `public`, `app_public`, `app_hidden`; not on `app_private`
  (`000001.sql:54`).
- Default privileges in `public`, `app_public`, `app_hidden`: usage and
  select on sequences, execute on functions (`000001.sql:58-63`). So the
  visitor can execute every `app_public` function the owner creates; the
  explicit execute grants below repeat that.
- `app_public.users`: select; update (username, name, avatar_url, bio)
  (`000001.sql:217-222`).
- `app_public.user_emails`: select; insert (email); delete
  (`000001.sql:370-373`).
- `app_public.user_authentications`: select; delete (`000001.sql:606-607`).
- `app_public.organizations`: select; update (name, slug)
  (`000001.sql:1343-1344`).
- `app_public.organization_memberships`: select (`000001.sql:1361`).
- `app_public.organization_invitations`: no grant.
- `app_public.playgrounds`: select (table-level, so it covers
  `head_commit_id` and `edit_key_hash` added later); insert (name,
  description, privacy, fork_hash); update (name, description, privacy);
  delete (`000001.sql:1813-1818`).
- `app_public.playground_stars`: select; insert (playground_hash); delete
  (`000001.sql:1846-1850`).
- `app_public.playground_comments`: select; insert (body, range,
  playground_hash); update (body); delete (`000001.sql:1875-1880`).
- `app_public.playground_commits`: select; insert (playground_hash,
  parent_id, message, data); delete (`000001.sql:1951-1955`).
- Explicit execute: `change_password(text, text)` (`000001.sql:993`);
  `create_playground_commit` (`000001.sql:2132`, `000003.sql:147`,
  `000005.sql:175`; each re-grant follows a drop); `fork_playground`
  (`000001.sql:2217`); `may_have_private(uuid)` (`000004.sql:32`);
  `claim_playground(text, bytea)` (`000005.sql:217`).

### Roles and how they are created

No migration or script in the repo creates a role. `ops dev db` and the
platform create them: `scripts/dbSetup.ts:2-4` says "Database
create/drop/roles/extensions are owned by `ops dev db`"; names follow ops
conventions (`scripts/generateEnvFile.ts:60-65`): owner
`${DATABASE_NAME}_owner` (`postgres_garden_owner`, `.gmrc:13`), visitor
`${DATABASE_NAME}_visitor`, authenticator `alchemy_${DATABASE_NAME}_api`.
Production declares `DATABASE_OWNER` (role owner) and `DATABASE_VISITOR`
(role visitor) and the logins `migration` and `api`
(`cartridge.json:40-56`). Login roles are NOINHERIT members of the visitor
role; `afterReset.sql` grants CONNECT to each member because a reset
revokes it from PUBLIC (`migrations/afterReset.sql:4-16`). The server
switches to the visitor with transaction-local `set_config('role', ...)`
(`server/db.ts:96-102`).

## Older claims in `effect-web-template/docs/standardize/`

Checked against `13c598f`.

- Effect 4.0.6 (`runtime-bun-node.md:5`, `base-sessions-testing.md:8`,
  `base-db-env-errors-telemetry.md:10`, `ratelimit-realtime-email.md:8`): no
  longer holds. Effect is 4.1.0 (`d99fa6a`).
- Raw `Bun.serve`, Effect builds only a web handler, signals via
  `process.on`: holds (`server/index.ts:346,322,405-406`). Cited lines
  `:177-178`, `:287`, `:320-324`, `:341-357` moved.
- Vite bridge at `server/index.ts:73-168`: holds, now `:78-173`.
- `NodeFileSystem`/`NodePath` at `:18`, `:63`, `:323-324`: holds, now
  `:3`, `:65`, `:325-326`.
- DevTools at `server/telemetry.ts:17-18`: holds, now `:22-23`.
- `generateEnvFile.ts:201` and `dbSetup.ts:230`: no longer hold. Files are
  180 and 32 lines; `dbSetup.ts` became a thin `ops dev db reset` wrapper in
  `2ede399`.
- `Bun.write` at `scripts/generateModelCatalog.ts:63`: holds, now `:85`.
- `bun:test` in `src/shared/routes.test.ts:1`: holds.
- PG cross-check at `sessionService.ts:108-129`: holds, now `:148-169`.
  "Effect 4 `Crypto`" at `:95-96`: no longer holds; secrets come from the
  `Secrets` service (`server/secrets.ts:15-35`).
- `token.split` at `sessionService.ts:98-99`: holds, now `:123`.
- `cookies.ts` string builders used only by testing: no longer holds; OAuth
  uses them too (`server/services/oauthService.ts:298`,
  `server/apiHandlers.ts:461`).
- `securitySetCookie` at `sessionMiddleware.ts:48-55`: holds, now `:53-60`.
  Middleware wraps the transaction at `:20-43`: now `:25-49`. Lookup failure
  becomes anonymous at `:28-30`: holds, now `:33-35`.
- `SessionMiddleware` at `apiSchema.ts:30-62`: holds, now `:33-72`.
- `ProductionGuard` at `testing.ts:273-277`: holds, now `:274-278`;
  dynamic import at `index.ts:329-334`: now `:331-336`. Error mapping at
  `testing.ts:238-258`: now `:239-260`.
- `auth.test.ts:30-44` and `:47-66` in-process handlers: hold.
- "No globalSetup": holds for vitest; no longer holds for Playwright
  (`e2e/globalSetup.ts`).
- `envSchema.ts:8-24`: moved to `:9-42` (devtools and OTLP keys added).
  `assertEnv.ts:3`: now `:4`. `Config.Redacted` at `db.ts:261`: now `:263`.
- Pools at `db.ts:237-270`: now `:239-272`. `withRequestTransaction` at
  `:222-235`: now `:224-237`. `runQuery` at `:50-53`: now `:53-56`.
  `unwrapPgError` at `:302-306`: now `:304-308`; custom-code 400 at
  `:313-317`: now `:315-320`; 500 fallback at `:319-320`: now `:321-322`.
- `errors.ts:7-41`: holds (`:7-40`).
- `telemetry.ts:13-20`: holds (`:13-25`).
- No rate limiting; Valkey for sessions only: holds. Valkey is also pinged by
  the readiness probe (`server/ready.ts:96-102`).
- `hset` at `sessionService.ts:67-76`: now `:102-111`.
- `transport.js:17-27` and `:34-46`: hold. `send_email.test.ts:22-66`:
  holds (`:22-69`). Rejection at `send_email.js:67-69`: now `:69-71`.
