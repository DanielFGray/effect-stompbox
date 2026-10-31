# setlist (GigList)

App root: `~/build/setlist`. Paths below are relative to it. Citations are to
the clean working tree at commit `5775660`. The package and product name is
GigList (`package.json:2`, `package.json` `projectName`); the database,
roles, Valkey prefix and service name all use `giglist`.

**Git history: bug fixes in the backend files** (found with `git log -p
--follow` on `src/server/db.ts`, `session.ts`, `services/auth.ts`,
`httpapi/auth.ts`, the rate-limit files, `live-hub.ts`, `worker/` and
`migrations/`):

- `ce7f83c` fix(db): the app connected as the table owner, so no RLS policy
  applied; any user could read every band. Added the authenticator pool and
  `withAuthContext`. The same commit found that the visitor role lacked the
  `songs.created_by` insert grant and that a song update wrote columns the
  visitor may not write.
- `e2ca745` test(db): the view `setlist_entries_resolved` ran with its
  owner's rights and skipped the `songs` policies, so a song of another band
  reached any reader. Made it `security_invoker`.
- `af40975` fix(server): error matching read the message text of
  `SqlError`; now it reads SQLSTATE and constraint name (`pg-error.ts`).
- `cbea9f3` fix(auth): register passed unvalidated strings to Postgres; now
  the payload schema repeats the database checks; fallbacks log the cause.
- `dd69022` fix(db): `stored != input` let a NULL `password_hash` or NULL
  `reset_password_token` accept any input in `app_private.login`,
  `app_private.reset_password` and `app_public.change_password`. Fixed bodies
  are in `migrations/current/2-null-safe-auth.sql` (not yet committed).
- `0d13bbf`, `87dc26a` fix(worker): email links pointed at the wrong client
  routes (`/verify-email`, `/delete-account`).

## Rows

1. **Runtime and HTTP layer**: present. Bun. `@effect/platform-bun`:
   `BunHttpServer.layer({ port, hostname })` and `BunRuntime.runMain`
   (`src/server/main.ts:2-3,53-57,65-67`). Router is `HttpApi`: eleven
   `HttpApiGroup`s joined in `GigListApi` (`src/api/contracts.ts:1520-1531`),
   built with `HttpApiBuilder.layer` (`src/server/main.ts:27-31`) and served
   by `HttpRouter.serve` together with the test-only API and a plain
   `HttpRouter.add` health route (`src/server/main.ts:43`,
   `src/server/httpapi/health.ts:7-20`). The server starts with
   `Layer.launch(ServerLive)` (`src/server/main.ts:65-67`). `PORT` defaults
   to 3000 and `API_HOST` to `127.0.0.1` (`src/server/main.ts:54-55`).
   Production runs `NODE_ENV=production bun src/server/main.ts`
   (`package.json:30`). The client is a separate Vite build; Vite proxies
   `/api` to the API in development (`vite.config.ts:33,41`). One-shot
   scripts use `@effect/platform-node` (`NodeRuntime`) while the server uses
   Bun (`scripts/generateEnvFile.ts:12,114`, `scripts/dbEnsure.ts:8,86`).

2. **Versions and data stack**: present. `effect` 4.1.0, `@effect/sql-pg`
   4.1.0, `@effect/platform-bun` 4.1.0 (`package.json:46,48,56`;
   `bun.lock` resolves `effect@4.1.0`). Query layer is Kysely 0.29.7
   (`package.json:61`) on top of `@effect/sql-pg`, through a local port of
   the removed `@effect/sql-kysely` (`src/server/effect-kysely.ts:1-10`):
   Kysely runs with a `DummyDriver` and only compiles; each builder is an
   `Effect` that runs the compiled SQL through `SqlClient.unsafe`
   (`src/server/effect-kysely.ts:151-171,185-213`). A `Proxy` installs the
   execution effect; symbol keys pass through untouched
   (`src/server/effect-kysely.ts:121-124`). `withTransaction` is the
   `SqlClient`'s (`src/server/effect-kysely.ts:190`). graphile-migrate
   2.0.0-rc.2 and graphile-worker 0.18.0 (`package.json:57-58`).
   `kysely-codegen` 0.20.0 is a dependency (`package.json:62`) but no script
   runs it.

3. **Config and env**: present. Effect `Config` at each use site, no
   central schema: `Config.Redacted("DATABASE_URL")`,
   `Config.Redacted("AUTH_DATABASE_URL")`, `Config.String("DATABASE_VISITOR")`
   (`src/server/db.ts:20,39,55`); `PORT`, `API_HOST`
   (`src/server/main.ts:54-55`); `NODE_ENV` as `Config.Literals`
   (`src/server/main.ts:36`); `RATE_LIMIT` (`src/server/httpapi/rate-limit.ts:48`);
   `VALKEY_URL` (`src/server/services/valkey.ts:15`); worker `MAIL_PROVIDER`,
   `EMAIL_FROM`, `AWS_REGION`, `CLOUDFLARE_EMAIL_API_TOKEN`,
   `ETHEREAL_ACCOUNT_FILE` (`worker/main.ts:19`,
   `worker/email/mailer.ts:31,47,57-58,86-87`). Raw `process.env` remains in
   `src/server/httpapi/auth.ts:12`, `src/server/httpapi/testing.ts:16,20`
   and in worker tasks (`VITE_ROOT_URL`,
   `worker/tasks/user__forgot_password.mjs:41`). Env files: `bun run dev:server`
   and `start` pass no `--env-file` (`package.json:24,30`) and rely on Bun's
   automatic `.env` loading; other scripts pass `--env-file=.env`
   (`package.json:15,20,26,39`). `.env` and `.env.production` are
   gitignored. `scripts/generateEnvFile.ts` writes `.env`: it keeps existing
   values, generates secrets, and derives role names from `DATABASE_NAME`
   (`scripts/generateEnvFile.ts:26-52`). `ops dev db up` writes the
   database URLs (`scripts/generateEnvFile.ts:29-30`). Production values come
   from `cartridge.json` `environment` and `secrets` (`cartridge.json:33-73`).
   `SECRET` is generated (`scripts/generateEnvFile.ts:48`) and provisioned
   (`cartridge.json:60-65`) but no code reads it.

4. **Pools and roles**: present. Two `PgClient` pools. `Db` uses
   `DATABASE_URL`, the owner (migration) login, and bypasses RLS
   (`src/server/db.ts:9-30`). `AuthDb` uses `AUTH_DATABASE_URL`, the
   authenticator login (`src/server/db.ts:32-49`). The comment says the
   authenticator has NO INHERIT and holds no grants until `SET ROLE`
   (`src/server/db.ts:32-36`); the repo does not create the role, so this is
   not verifiable here. Role names: `giglist_owner`, `alchemy_giglist_api`
   (authenticator), `giglist_visitor` (`scripts/generateEnvFile.ts:35-40`,
   `tests/db/run.sh:16-18`). Per request, `withAuthContext(sessionId)` opens
   a transaction on `AuthDb` and runs one `select` with
   `set_config('role', <visitor literal>, true)` and
   `set_config('my.session_id', <bound param>, true)`, then provides the
   `Kysely` service as that transaction's handle
   (`src/server/db.ts:85-106`). Signed-out public reads also go through it
   with an empty session id (`src/server/httpapi/public-users.ts:7-10,19`).
   The visitor name comes from the `AuthVisitor` service
   (`src/server/db.ts:52-57`). Outside a request: session lookup, login,
   register, reset, `getMe`, `verifyEmail` and the testing API use `Db`
   directly (`src/server/httpapi/session.ts:15`,
   `src/server/services/auth.ts:40,90,120,128,148,153,384`). The comment on
   `Kysely` says it "defaults to the owner pool"
   (`src/server/db.ts:59-67`), but `Kysely.Live` is never provided in
   `src/server/main.ts`, so `Kysely` exists only inside `withAuthContext`.
   The health check queries both pools (`src/server/httpapi/health.ts:6-13`).
   The worker connects with `DATABASE_URL` only (`worker/main.ts:32`;
   `cartridge.json:94-99`).

5. **Typed handles**: present. Query code gets a handle by yielding a
   service: `Db`, `AuthDb` or `Kysely` (`src/server/db.ts:18,37,65`). All
   three have the same type `EffectKysely<DB>` (`src/server/db.ts:7`), and
   `DB` lists both `app_private.*` and `app_public.*` tables
   (`generated/DB.ts:384-408`). The types do not stop visitor code from
   naming an `app_private` table; Postgres grants do. Helpers take the
   handle as a parameter (`generated/queries.ts:1,15-17`).
   `asSessionOr(unauthorized, query)` fails with a group error when there is
   no session, else runs `query` under `withAuthContext`
   (`src/server/httpapi/scope.ts:38-48`).

6. **Database error mapping**: present. `pgError(e)` reads `code` and
   `constraint` from `SqlError.reason.cause` (`src/server/services/pg-error.ts:4-22`).
   Each service function has its own `Effect.catch` that maps codes to a
   domain `TaggedError`: `23505` to `DuplicateAccount`, `WEAKP` to
   `WeakPassword` (`src/server/services/auth.ts:75-85`); `LOCKD` to
   `AccountLocked` (`:108-116`); `CREDS`, `LOGIN`, `WEAKP`
   (`:246-258`); `EMTKN` (`:284-292`); `CDLEA` (`:306-316`); `DNIED`,
   `VRFY1` (`:340-352`); `OWNER`, `DNIED` (`:472-490`); constraint names
   `users_username_key`, `username_check`, `url_check` (`:206-218`);
   band codes `LOGIN`, `DNIED`, `ISMBR`, `NTFND`, `23505`, `VRFY2`, `INCOD`
   and `bands_slug_key` (`src/server/services/band.ts:94-96,115-129,158-161`).
   Handlers then map domain errors to one group error per endpoint, whose
   HTTP status is fixed in the contract (`AuthError` 400 or 401,
   `src/api/contracts.ts:169,179,186`; `setlistErrors` 404 and 403,
   `src/api/contracts.ts:997-1000`). Unknown errors: services log and return
   a generic domain message (`src/server/services/auth.ts:82-84,113-115`);
   login turns any unknown failure into `InvalidCredentials`
   (`src/server/services/auth.ts:113-115`); `withAuthContext` turns
   `SqlError` into a defect (`src/server/db.ts:105`); handlers use
   `Effect.orDie` widely (for example `src/server/httpapi/charts.ts:47,64`).
   The SQL raises `WEAKP` only from `assert_valid_password`, and no function
   calls it (calls are commented out at
   `migrations/committed/000001-release-1.sql:1074,1226,1278-1280`), so the
   `WEAKP` branches cannot fire; the 8-character rule is enforced only by
   the payload schema (`src/api/contracts.ts:87-89`).

7. **Migrations and codegen**: present. graphile-migrate with
   `migrations/committed/000001-release-1.sql` (one release, split into
   `--! split:` sections) and `migrations/current/1-current.sql`,
   `migrations/current/2-null-safe-auth.sql`. `.gmrc` sets
   `databaseOwner: giglist_owner`, placeholders `:DATABASE_AUTHENTICATOR`
   and `:DATABASE_VISITOR` from env, and `afterReset` runs
   `ops dev db reset "$GM_DBNAME"` for the shadow database, then
   `afterReset.sql` (`.gmrc:2-3,9-12,14-18`). `afterReset.sql` only grants
   connect and sets the public schema owner (`migrations/afterReset.sql:1-7`).
   Schemas: `app_public`, `app_hidden`, `app_private`
   (`migrations/committed/000001-release-1.sql:48-50`); `app_hidden` stays
   empty. Release 1 starts by dropping the three schemas
   (`migrations/committed/000001-release-1.sql:13-15`). Dev applies with
   `graphile-migrate watch --once` (`package.json:15`); production applies
   only `committed/` and the cartridge has no migrate step yet
   (`docs/deploy.md:36-43`). Type codegen: absent. `generated/DB.ts` says it
   was first made by kysely-codegen and is now maintained by hand
   (`generated/DB.ts:1-4`).

8. **Sessions and cookies**: present. Cookie `session`, declared as
   `HttpApiSecurity.apiKey({ in: "cookie" })` (`src/api/contracts.ts:13-16`).
   The value is the bare `app_private.sessions.uuid`, unsigned and unhashed
   (`src/server/httpapi/auth.ts:22-30`;
   `migrations/committed/000001-release-1.sql:275-281`). Flags: HttpOnly,
   SameSite Lax, Secure in production, path `/`, max age 30 days
   (`src/server/httpapi/auth.ts:23-29`). `SessionMiddleware` runs one owner-pool
   statement: a CTE selects the row if `last_active` is within 30 days, and a
   data-modifying CTE bumps `last_active` when it is over an hour old, so a
   live session writes at most once per hour
   (`src/server/httpapi/session.ts:26-64`). Any failure gives
   `{ sessionId: "", userId: null }` (`src/server/httpapi/session.ts:10,60`).
   In SQL, `current_user_id()` looks up the session by uuid and does not
   check `last_active` (`migrations/committed/000001-release-1.sql:325-327`);
   expiry is enforced by the middleware and by the nightly cleanup task
   that deletes sessions idle for 30 days (`worker/crontab:16`,
   `worker/tasks/maintenance__cleanup.mjs:5-10`). Logout deletes the row on
   the owner pool and clears the cookie (`src/server/httpapi/auth.ts:69-83`,
   `src/server/services/auth.ts:147-150`). Sessions are created by
   `app_private.login` and `app_private.reset_password` in SQL, and by a
   TypeScript insert after register (`src/server/services/auth.ts:62-71`).

9. **Password auth**: present. Hashing is in SQL: pgcrypto
   `crypt(password, gen_salt('bf'))` (bcrypt)
   (`migrations/committed/000001-release-1.sql:1299`). Register: TypeScript
   calls `app_private.really_create_user` on the owner pool, then inserts a
   session (`src/server/services/auth.ts:38-73`). Login: `app_private.login`
   on the owner pool (`src/server/services/auth.ts:88-107`); lockout after 3
   failures in 5 minutes raises `LOCKD`
   (`migrations/current/2-null-safe-auth.sql:40-49`). Verify email:
   `app_public.verify_email(id, token)` on the owner pool, no session needed
   (`src/server/services/auth.ts:381-407`). Forgot: `app_public.forgot_password`
   on the owner pool (`src/server/services/auth.ts:119-124`); the SQL queues
   `user__forgot_password` or `user__forgot_password_unregistered_email`
   (`migrations/committed/000001-release-1.sql:920-1006`). Reset:
   `app_private.reset_password` returns a new session and the handler sets
   the cookie, so reset signs the user in (`src/server/httpapi/auth.ts:62-68`);
   it deletes all of the user's sessions first
   (`migrations/current/2-null-safe-auth.sql:132-134`). The reset lockout is
   20 failures per 3 days (`migrations/current/2-null-safe-auth.sql:94-103`).
   `reset_password` does not check `reset_password_token_generated`; only
   `forgot_password` rotates a token older than 3 days
   (`migrations/committed/000001-release-1.sql:977-990`). Change password:
   `app_public.change_password` under `withAuthContext`; it deletes the
   user's other sessions (`src/server/httpapi/auth.ts:100-111`,
   `migrations/current/2-null-safe-auth.sql:151-196`). Tokens (email
   verification, reset, account deletion, band invite) are 7 random bytes in
   hex, stored in plain text
   (`migrations/committed/000001-release-1.sql:648,980,1137,1690`).
   `verify_email` does not clear the token
   (`migrations/committed/000001-release-1.sql:673-686`). Account deletion is
   request plus emailed token (`src/server/services/auth.ts:425-491`).
   Passwords travel as `Redacted` from payload to SQL call
   (`src/api/contracts.ts:55-64`).

10. **OAuth**: absent in TypeScript. The SQL from graphile-starter remains:
    `app_public.user_authentications` and
    `app_private.user_authentication_secrets` tables,
    `app_private.register_user` and `app_private.link_or_register_user`
    (`migrations/committed/000001-release-1.sql:724-787,1321-1505`). No code
    in `src/` or `worker/` calls them; `worker/tasks/user__audit.mjs:65-73`
    still has `linked_account` and `unlinked_account` messages.

11. **Authorization**: present. RLS on every `app_public` table, keyed on
    `app_public.current_user_member_band_ids()` (SECURITY DEFINER, reads
    `band_memberships`) (`migrations/committed/000001-release-1.sql:1623-1643`).
    Bands are the organizations; `band_memberships.is_owner` is the only
    in-band role (`migrations/committed/000001-release-1.sql:1590-1597`).
    Owner-only actions are SECURITY DEFINER functions that check `is_owner`
    (`invite_to_band`, `delete_band`, `transfer_band_ownership`,
    `band_pending_invitations`, `cancel_invitation`). Marks are per-user with
    a `band` visibility option (`migrations/committed/000001-release-1.sql:2403-2417`).
    `users.role` (`admin`, `moderator`, `user`) exists
    (`migrations/committed/000001-release-1.sql:342,352`) but no policy or
    TypeScript check reads it. TypeScript checks run inside the same
    transaction to turn empty results into 403: `isBandMember`
    (`src/server/httpapi/scope.ts:22-32`), `assertBandMember` and
    `assertBandSong` (`src/server/httpapi/setlists.ts:249-259`), and
    `requireNoOwnedBands` before account deletion
    (`src/server/services/auth.ts:409-423`).

12. **Rate limiting**: present. `effect/persistence/RateLimiter` with
    `layerStoreRedis({ prefix: "giglist:rl:" })` on Valkey through
    `BunRedis` (`src/server/services/rate-limiter.ts:10-14`,
    `src/server/services/valkey.ts:13-16`). An `HttpApiMiddleware`
    `RateLimitMiddleware` with a 429 `TooManyRequests` error carrying
    `retryAfterSeconds` (`src/api/contracts.ts:36-51`); endpoints opt in on
    the contract (`src/api/contracts.ts:180,187`). Rules by endpoint name,
    keyed `{endpoint}:ip:{net}` or `{endpoint}:user:{id}`, with a per-rule
    store-down policy (`src/server/httpapi/rate-limit.ts:17-40,68,85-93`).
    Limits: login 10/5 min, register 5/h, forgotPassword 5/h,
    resetPassword 10/h, verifyEmail 20/h, changePassword 10/h, addEmail 5/day,
    resendEmailVerification 5/day, requestAccountDeletion 3/day,
    inviteToBand 20/day (`src/server/httpapi/rate-limit.ts:29-40`). Store
    calls time out after 1 second (`src/server/services/rate-limiter.ts:20`,
    `src/server/httpapi/rate-limit.ts:74-78`). Client IP: `X-Real-IP`, else
    the socket address, reduced by `networkOf` (IPv4 as is, IPv6 to its /64)
    (`src/server/httpapi/rate-limit.ts:95-109`,
    `src/server/httpapi/client-ip.ts:7-21`). `RATE_LIMIT=off` disables it
    for Playwright (`src/server/httpapi/rate-limit.ts:42-54`,
    `playwright.config.ts:38`). The worker caps mail to 5 per address per hour
    on the same limiter (row 14). The SQL also limits forgot-password mail:
    3 minutes per known address, 15 minutes per unknown address
    (`migrations/committed/000001-release-1.sql:924,946,963-972`).

13. **Realtime**: present. SSE through `HttpApiSchema.StreamSse` on
    `GET /api/setlists/:id/events` and the gig equivalent
    (`src/api/contracts.ts:1066-1072,1219`), with a `POST .../presence`
    endpoint (`src/api/contracts.ts:1074-1078`). `LiveHub` is in-process
    memory: one sliding `PubSub` of 64 per room, a viewer map, a 20-second
    ping, and a presence snapshot first on each connection
    (`src/server/services/live-hub.ts:8-9,20-36,54-62,70-94`). Events come
    from handlers after a write (`announce`,
    `src/server/httpapi/setlists.ts:213-218`). No LISTEN/NOTIFY, no outbox,
    no replay. The client `EventSource` reconnects on close
    (`src/components/live.ts:46,66`). The file states that two processes
    would not share events (`src/server/services/live-hub.ts:16-18`), and
    the deploy keeps one API instance (`docs/deploy.md:14-15`). The SQL
    trigger `_500_gql_update` on `users` still sends `pg_notify` on
    `graphql:user:<id>` (`migrations/committed/000001-release-1.sql:460-467`);
    nothing listens.

14. **Worker and mail**: present. graphile-worker run as an Effect program:
    `getTasks` loads `worker/tasks/*.mjs`, a TypeScript `send_email` task is
    added, crontab from `worker/crontab`, all inside `acquireRelease`
    (`worker/main.ts:31-53`). The TypeScript task runs `sendEmail` with the
    program's context, so a failure rejects the job and graphile retries
    (`worker/main.ts:38-39`). JS tasks: `user__audit`,
    `user__forgot_password`, `user__forgot_password_unregistered_email`,
    `user__send_delete_account_email`, `user_emails__send_verification`,
    `band_invitations__send_invite`, `maintenance__cleanup` (nightly at
    03:17, `worker/crontab:16`). Jobs are queued from SQL by
    `graphile_worker.add_job` in triggers and functions
    (`migrations/committed/000001-release-1.sql:74-139,548,1000,1152,1777`).
    `QueuedEmail` is a Schema union, one member per template
    (`worker/email/send-email.ts:16-31`); render is lodash template, then
    MJML strict, then html-to-text (`worker/email/send-email.ts:45-68`).
    Templates: `worker/templates/*.mjml` (six). `Mailer` service with
    providers `development` (Nodemailer to Ethereal, account cached in a
    file), `ses` (AWS SESv2), `cloudflare` (SMTP to `smtp.mx.cloudflare.net`
    with `api_token`), and `Mailer.smtp(settings)` for tests
    (`worker/email/mailer.ts:26-97`). Choice: `MAIL_PROVIDER`; default
    `ses` in production, `development` otherwise, required under
    `NODE_ENV=test` (`worker/main.ts:17-29`). Production sets `cloudflare`
    (`cartridge.json:38`). Per-address cap 5/hour except
    `account_activity.mjml`; over-cap recipients are dropped with a warning
    (`worker/email/send-email.ts:70-103`).

15. **Test harness and test database**: present. Three suites. (a)
    Playwright end-to-end over TCP against `bun run dev:server` and the built
    client on `vite preview` (`playwright.config.ts:30-49`), on the
    development database, not a separate one. Each test gets a unique user
    prefix `test_<run>_w<worker>_<n>` so tests run in parallel and never clean
    up each other (`tests/helpers.ts:36-58`); `bun run test:clean` deletes
    leftovers through `/api/testing/clear` (`scripts/testClean.ts:1-21`; its
    default port is 3010 while the server default is 3000). Auth is real:
    the fixture posts to `/api/testing/login`, which registers and logs in
    and sets the cookie (`tests/helpers.ts:62-77`,
    `src/server/httpapi/testing.ts:90-115`). The testing API runs on the
    owner pool and can read `user_secrets` and `user_email_secrets`
    (`src/server/httpapi/testing.ts:198,211,228`); it is loaded only when
    `NODE_ENV` is not production (`src/server/main.ts:35-40`,
    `src/server/httpapi/testing.ts:16-18`). (b) SQL tests:
    `tests/db/run.sh` resets `giglist_test` with `ops dev db reset`, applies
    `afterReset.sql`, committed, current and seed files, then runs
    `*-owner.sql` as the owner and `*-rls.sql` as the authenticator
    (`tests/db/run.sh:11,21-40`); the RLS files switch to the visitor with
    `set_config('role', ...)` (`tests/db/setlists-rls.sql:8-11`). (c)
    `bun test` unit tests for pure code and the worker, with an in-memory
    rate limiter and a real `SMTPServer` (`package.json:35,37`,
    `worker/email/send-email.test.ts:4-5,15-16`).

16. **Telemetry and logging**: present. `Otlp.layerFromConfig` with
    `serviceName: "giglist"`, JSON serialization, `FetchHttpClient`
    (`src/server/telemetry.ts:17-22`); exports only when the standard
    `OTEL_*` variables name an exporter (`src/server/telemetry.ts:4-12`).
    Merged into the server (`src/server/main.ts:58-61`) and the worker
    (`worker/main.ts:9,57`). Production sets `OTEL_TRACES_EXPORTER` and
    `OTEL_LOGS_EXPORTER` to `otlp` (`cartridge.json:43-44`). Spans come from
    `Effect.fn("Name")` in services (for example
    `src/server/services/auth.ts:38,88`). No DevTools layer. Logs use the
    default Effect logger; worker JS tasks use `console`.

17. **API contract with the frontend**: present. One shared module of
    `effect/http-api` definitions and Schemas (`src/api/contracts.ts`). The
    browser uses `HttpApiClient.make(GigListApi)` on a `ManagedRuntime` with
    `FetchHttpClient` (`src/api/client.ts:90,104`); client types derive from
    the contract (`src/api/client.ts:26-60`). The test-only API is a
    separate `TestingApi` (`src/api/contracts.ts:1533`).

18. **Deployment**: present. `cartridge.json` (`apiVersion:
    server-ansible/v2`) declares the database with extensions `citext`,
    `pgcrypto`, `uuid-ossp`, Valkey, and two Nomad services from one image:
    `giglist-api` (`bun run start`, health `/api/health`, route `/api` with
    security headers) and `giglist-worker` (`bun run worker:prod`)
    (`cartridge.json:1-112`). Database URLs come from cartridge secrets: the
    `migration` login as `DATABASE_URL`, the `api` login as
    `AUTH_DATABASE_URL` (`cartridge.json:47-58`). `Dockerfile` builds on
    `oven/bun:1.4.4` and runs the API from source (`Dockerfile:2,13,31`).
    The client is built separately by `Containerfile` and served as static
    files by Caddy; Traefik splits by path (`Containerfile:1-13`,
    `docs/deploy.md:3-12`). Release with `ops release`
    (`docs/deploy.md:21-25`). Local Valkey via `docker-compose.yml:1-15`;
    local Postgres is the shared `ops dev db` cluster
    (`scripts/dbEnsure.ts:1-6`).

19. **App-only backend features**:
    - Chart reading from PDF or image with `pdftotext`, `pdftoppm` and
      `tesseract` subprocesses, two at a time (`src/server/services/chart-reader.ts:9-30`).
    - Guitar Pro score files stored as `bytea` with a SHA-256 match trigger
      (`migrations/committed/000001-release-1.sql:2458-2520`).
    - Immutable chart revisions with change sets, and per-user marks and
      stamps (`migrations/committed/000001-release-1.sql:2263-2447`).
    - Setlist and gig ordering by sortable `position_key` text
      (`migrations/committed/000001-release-1.sql:2043-2052,2224-2232`).
    - Live presence (who is viewing which setlist or gig, and where)
      (`src/server/services/live-hub.ts:20-34`).
    - Public band pages and public user profiles with user-written HTML
      themes (`migrations/committed/000001-release-1.sql:2522-2791`).
    - Band invitations by username or by emailed code
      (`migrations/committed/000001-release-1.sql:1606-1772`,
      `migrations/current/1-current.sql`).

## SQL surface

Final state after `committed/` then `current/` in file order. "DEFINER" =
`SECURITY DEFINER`; every DEFINER function sets
`search_path to pg_catalog, public, pg_temp`. Citations are
`migrations/committed/000001-release-1.sql:<line>` written as `C:<line>`,
`migrations/current/1-current.sql:<line>` as `K1:<line>`, and
`migrations/current/2-null-safe-auth.sql:<line>` as `K2:<line>`.

### Functions in `app_public`

| Function | DEFINER | Purpose | Cite |
|---|---|---|---|
| `tg__graphql_subscription() returns trigger` | no | Generic `pg_notify` trigger (used on `users`) | C:187-230 |
| `current_session_id() returns uuid` | no | Reads `my.session_id` setting | C:298-300 |
| `current_user_id() returns uuid` | yes | Session uuid to user id via `app_private.sessions`; ignores `last_active` | C:325-327 |
| `current_user() returns app_public.users` | no | Current user row | C:397-399 |
| `users_has_password(u app_public.users) returns boolean` | yes | Whether the current user has a password hash | C:450-452 |
| `tg_user_emails__forbid_if_verified() returns trigger` | yes | Raise `EMTKN` if the email is verified by anyone | C:532-540 |
| `tg_user_emails__prevent_delete_last_email() returns trigger` | yes | Raise `CDLEA` if the last (verified) email would go | C:569-620 |
| `verify_email(user_email_id uuid, token text) returns boolean` | yes | Mark email verified if token matches; may set primary | C:673-687 |
| `tg_user_emails__verify_account_on_verified() returns trigger` | yes | Set `users.is_verified` when an email is verified | C:697-709 |
| `logout() returns void` | yes | Delete current session; clear setting (not called from TS) | C:879-886 |
| `forgot_password(email citext) returns void` | yes | Issue/reuse reset token and queue mail; throttle | C:920-1006 |
| `request_account_deletion() returns boolean` | yes | Issue delete token, queue mail; `LOGIN` if signed out | C:1114-1155 |
| `confirm_account_deletion(token text) returns boolean` | yes | Delete user if token valid for 3 days; `DNIED` else | C:1163-1196 |
| `change_password(old_password text, new_password text) returns boolean` | yes | NULL-safe check (`CREDS`), rehash, drop other sessions, audit job | K2:151-196 |
| `make_email_primary(email_id uuid) returns app_public.user_emails` | yes | Switch primary email; `DNIED`, `VRFY1` | C:1515-1531 |
| `resend_email_verification_code(email_id uuid) returns boolean` | yes | Queue verification mail for own unverified email | C:1538-1552 |
| `current_user_member_band_ids() returns setof uuid` | yes | Band ids of current user; basis of most policies | C:1623-1626 |
| `current_user_invited_band_ids() returns setof uuid` | yes | Band ids the current user is invited to | C:1628-1631 |
| `create_band(slug citext, name text) returns app_public.bands` | yes | Insert band and owner membership | C:1646-1655 |
| `invite_to_band(band_id uuid, username citext = null, email citext = null) returns void` | yes | Owner invites user or email; `LOGIN`, `DNIED`, `ISMBR`, `VRFY2`, `NTFND` | C:1657-1705 |
| `band_for_invitation(invitation_id uuid, code text = null) returns app_public.bands` | yes | Check invitation is for caller; wrong code raises `INCOD` | K1:3-33 |
| `accept_invitation_to_band(invitation_id uuid, code text = null) returns uuid` | yes | Join band, delete invitation, return band id | K1:118-136 |
| `my_band_invitations() returns table(id uuid, band_id uuid, band_name text)` | yes | Caller's invitations, without codes | C:1759-1766 |
| `decline_invitation_to_band(invitation_id uuid) returns void` | yes | Delete own invitation | C:1768-1772 |
| `band_pending_invitations(band_id uuid) returns table(id uuid, username app_public.username, email citext)` | yes | Owner lists pending invitations, no codes; `DNIED` | K1:38-58 |
| `cancel_invitation(band_id uuid, invitation_id uuid) returns void` | yes | Owner deletes an invitation; `DNIED`, `NTFND` | K1:64-85 |
| `bands_current_user_is_owner(band app_public.bands) returns boolean` | no | Computed column: caller owns band | C:1781-1791 |
| `remove_from_band(band_id uuid, user_id uuid) returns void` | yes | Owner removes member or member leaves; refusals raise `DNIED` | K1:90-114 |
| `tg_users__deletion_band_checks_and_actions() returns trigger` | no | Raise `OWNER` when deleting a user who owns a band | C:1839-1860 |
| `delete_band(band_id uuid) returns void` | yes | Owner deletes band (silent no-op otherwise) | C:1862-1874 |
| `transfer_band_ownership(band_id uuid, user_id uuid) returns app_public.bands` | yes | Owner hands ownership to a member | C:1876-1903 |
| `public_band(band_slug citext) returns table(slug, name, description, page_theme, page_options)` | yes | Public fields when `is_public` | C:2577-2599 |
| `public_band_members(band_slug citext) returns table(username, name, avatar_url, is_owner)` | yes | Members when public and enabled | C:2603-2627 |
| `public_band_gig_dates(band_slug citext) returns table(venue, gig_date)` | yes | Upcoming gigs when public and enabled | C:2631-2649 |
| `public_band_songs(band_slug citext) returns table(title, artist)` | yes | Songs when public and enabled | C:2653-2670 |
| `public_user(handle citext) returns table(username, name, bio, avatar_url, page_theme, page_options)` | yes | Public profile when `is_public`; first defined at C:2697, dropped and redefined | C:2765-2791 |
| `public_user_bands(handle citext) returns table(slug citext, name text)` | yes | Public bands of a public user | C:2721-2739 |

### Functions in `app_private`

| Function | DEFINER | Purpose | Cite |
|---|---|---|---|
| `tg__add_job() returns trigger` | yes | `graphile_worker.add_job(tg_argv[0], {id})` | C:74-81 |
| `tg__add_audit_job() returns trigger` | yes | Queue `user__audit` with user id and extras | C:86-141 |
| `tg__timestamps() returns trigger` | no | Keep `created_at`; make `updated_at` increase | C:148-156 |
| `tg_user_secrets__insert_with_user() returns trigger` | no | Insert `user_secrets` row per user | C:431-442 |
| `tg_user_email_secrets__insert_with_user_email() returns trigger` | yes | Insert secrets row with verification token | C:643-659 |
| `login(username citext, password text) returns app_private.sessions` | no | Username/email login, NULL-safe hash check, lockout `LOCKD`, new session | K2:6-73 |
| `assert_valid_password(new_password text) returns void` | no | `WEAKP` if under 8 chars; no caller | C:1023-1030 |
| `reset_password(user_id uuid, reset_token text, new_password text) returns app_private.sessions` | no | NULL-safe token check, lockout, rehash, revoke sessions, audit job, new session | K2:75-149 |
| `really_create_user(username citext, name text, avatar_url text, email_is_verified bool, email text = null, password text = null) returns app_public.users` | no | Insert user, email, bcrypt hash | C:1266-1311 |
| `register_user(f_service varchar, f_identifier varchar, f_profile json, f_auth_details json, f_email_is_verified boolean = false) returns app_public.users` | yes | OAuth registration (unused) | C:1321-1389 |
| `link_or_register_user(f_user_id uuid, f_service varchar, f_identifier varchar, f_profile json, f_auth_details json) returns app_public.users` | yes | OAuth link or register; `TAKEN` (unused) | C:1407-1508 |
| `tg__chart_revision_matches_chart() returns trigger` | no | Revision content matches chart kind; parent in same chart | C:2340-2362 |
| `tg__score_file_matches_revision() returns trigger` | no | `sha256(bytes)` equals revision hash | C:2482-2500 |
| `tg__file_revision_has_bytes() returns trigger` | no | Deferred: file revision has a `score_files` row | C:2506-2520 |

### Functions in `app_hidden`

None. The schema is created (C:49) and granted (C:55) but holds nothing.

### Tables with RLS enabled, and their policies

| Table | Policies (name, command, condition) | Cite |
|---|---|---|
| `app_private.connect_pg_simple_sessions` | none (unused table) | C:244-250 |
| `app_private.sessions` | none | C:275-282 |
| `app_private.user_secrets` | none | C:410-423 |
| `app_private.user_email_secrets` | none | C:630-636 |
| `app_private.user_authentication_secrets` | none | C:783-787 |
| `app_public.users` | `select_all` SELECT `true` (any visitor reads every user row); `update_self` UPDATE `id = current_user_id()` | C:357,367-369 |
| `app_public.user_emails` | `select_own` SELECT, `insert_own` INSERT check, `delete_own` DELETE: all `user_id = current_user_id()` | C:490,558-561 |
| `app_public.user_authentications` | `select_own` SELECT, `delete_own` DELETE: `user_id = current_user_id()` | C:735,756-757 |
| `app_public.bands` | `select_member` SELECT `id in member_band_ids()`; `select_invited` SELECT `id in invited_band_ids()`; `update_owner` UPDATE caller has `is_owner` membership | C:1583,1633-1637,1793-1799 |
| `app_public.band_memberships` | `select_member` SELECT `band_id in member_band_ids()`; `select_invited` SELECT `band_id in invited_band_ids()` | C:1598,1639-1643 |
| `app_public.band_invitations` | none (and no visitor grant; read only through DEFINER functions) | C:1617,1620 |
| `app_public.songs` | `select_member`, `insert_member`, `update_member`, `delete_member`: `band_id in member_band_ids()` | C:1939,1963-1976 |
| `app_public.setlists` | same four `*_member` policies on `band_id` | C:2009,2023-2030 |
| `app_public.setlist_entries` | four `*_member` policies: parent setlist's `band_id in member_band_ids()` | C:2060,2082-2105 |
| `app_public.gigs` | four `*_member` policies on `band_id` | C:2178,2200-2207 |
| `app_public.gig_setlists` | four `*_member` policies on `band_id` | C:2233,2241-2248 |
| `app_public.charts` | `select_song_visible`, `insert_song_visible`, `update_song_visible`, `delete_song_visible`: the song is visible (songs policies) | C:2272,2281-2288 |
| `app_public.chart_revisions` | `select_chart_visible` SELECT, `insert_chart_visible` INSERT: chart is visible | C:2314,2326-2329 |
| `app_public.marks` | `select_own_or_shared` SELECT (own or `visibility = 'band'`, and revision visible); `insert_own` INSERT (own, revision visible); `update_own` UPDATE (own; check revision visible); `delete_own` DELETE (own) | C:2388,2403-2417 |
| `app_public.stamps` | `all_own` ALL `user_id = current_user_id()` | C:2435,2441-2443 |
| `app_public.score_files` | `select_revision_visible` SELECT, `insert_revision_visible` INSERT: revision visible | C:2462,2470-2473 |

`app_private.unregistered_email_password_resets` has no RLS (C:906-910).
The view `app_public.setlist_entries_resolved` is `security_invoker = true`,
so the callers' policies on `setlist_entries` and `songs` apply
(C:2120-2143).

### Grants to the visitor role

Schema and default privileges:

- `revoke all on schema public from public`; default privileges revoke all
  on sequences and functions from `public` (C:30-33).
- `usage` on schemas `public`, `app_public`, `app_hidden` (C:55). No usage on
  `app_private`.
- Default privileges in `public`, `app_public`, `app_hidden`: `usage, select`
  on sequences and `execute` on functions (C:59-64). So every
  `app_public` function, including those added in `current/`, is executable
  by the visitor without an explicit grant. These `alter default
  privileges` have no `for role`, so they apply to objects created by the
  role that runs the migration (see Roles).

Explicit grants:

| Object | Grant | Cite |
|---|---|---|
| `app_public.users` | SELECT; UPDATE (`username`, `name`, `bio`, `avatar_url`), (`is_public`), (`page_theme`, `page_options`) | C:370,372,2693,2761 |
| `app_public.user_emails` | SELECT; INSERT (`email`); DELETE | C:563-566 |
| `app_public.user_authentications` | SELECT; DELETE | C:775-776 |
| `app_public.change_password(text, text)` | EXECUTE | C:1255 |
| `app_public.bands` | SELECT; UPDATE (`name`, `slug`), (`description`, `is_public`, `show_members_publicly`, `show_gig_dates_publicly`, `show_songs_publicly`, `page_theme`, `page_options`). No INSERT or DELETE (`create_band`, `delete_band` do it) | C:1585-1586,2565-2573 |
| `app_public.band_memberships` | SELECT | C:1602 |
| `app_public.band_invitations` | none (grant commented out) | C:1620 |
| `app_public.songs` | SELECT; INSERT (`band_id`, `title`, `artist`, `key`, `tempo_bpm`, `duration_seconds`, `capo`, `notes`, `created_by`); UPDATE (`title`, `artist`, `key`, `tempo_bpm`, `duration_seconds`, `capo`, `notes`); DELETE | C:1978-1981 |
| `app_public.setlists` | SELECT; INSERT (`band_id`, `name`, `status`); UPDATE (`name`, `status`); DELETE | C:2032-2035 |
| `app_public.setlist_entries` | SELECT; INSERT (`setlist_id`, `song_id`, `position_key`, `key_override`, `tempo_override`, `notes_override`); UPDATE (`position_key`, `key_override`, `tempo_override`, `notes_override`); DELETE | C:2107-2110 |
| `app_public.setlist_entries_resolved` (view) | SELECT | C:2148 |
| `app_public.gigs` | SELECT; INSERT (`band_id`, `venue`, `gig_date`, `address`, `load_in_time`, `performance_time`, `notes`); UPDATE (same minus `band_id`); DELETE | C:2209-2212 |
| `app_public.gig_setlists` | SELECT; INSERT (`band_id`, `gig_id`, `setlist_id`, `position_key`); UPDATE (`setlist_id`, `position_key`); DELETE | C:2250-2253 |
| `app_public.charts` | SELECT, DELETE; INSERT (`song_id`, `kind`, `name`, `written_key`); UPDATE (`name`, `written_key`) | C:2290-2292 |
| `app_public.chart_revisions` | SELECT; INSERT (`chart_id`, `parent_id`, `source`, `file_key`, `file_sha256`, `changes`) | C:2331-2333 |
| `app_public.marks` | SELECT, DELETE; INSERT and UPDATE (`revision_id`, `scope`, `range_start`, `range_end`, `side`, `dx`, `dy`, `scale`, `body`, `visibility`) | C:2419-2424 |
| `app_public.stamps` | SELECT, DELETE; INSERT (`name`, `body`); UPDATE (`name`, `body`) | C:2445-2447 |
| `app_public.score_files` | SELECT; INSERT (`revision_id`, `bytes`) | C:2475-2476 |
| `public_band`, `public_band_members`, `public_band_gig_dates`, `public_band_songs`, `public_user`, `public_user_bands` | EXECUTE | C:2599,2627,2649,2670,2739,2791 |

### Roles and how they are created

Nothing in the repo creates a role or the role memberships.

- `afterReset.sql` only grants `connect` to `:DATABASE_OWNER` and
  `:DATABASE_AUTHENTICATOR`, `all` on the database to the owner, and makes
  the owner own schema `public` (`migrations/afterReset.sql:1-7`).
- `.gmrc` says `ops dev db` makes each database owned by the group role
  `giglist_owner` and the migration login is a member (`.gmrc:2-3`).
- `scripts/dbSetup.ts` says database create, drop, roles and extensions are
  owned by `ops dev db` (`scripts/dbSetup.ts:3-4`).
- Names: owner `giglist_owner`, authenticator `alchemy_giglist_api`,
  visitor `giglist_visitor` (`scripts/generateEnvFile.ts:35-40`,
  `tests/db/run.sh:15-18`).
- Production: `cartridge.json` maps `DATABASE_OWNER` and `DATABASE_VISITOR`
  to cluster roles `owner` and `visitor`, and provides two logins:
  `migration` (`DATABASE_URL`) and `api` (`AUTH_DATABASE_URL`)
  (`cartridge.json:41-42,47-58`). Extensions come from the cartridge
  (`cartridge.json:4`, `migrations/afterReset.sql:6`).
- The authenticator is described as NO INHERIT and a member of the visitor
  role (`src/server/db.ts:32-36`; commit `ce7f83c` body). Not verifiable
  from the repo.

## Older claims in effect-web-template/docs/standardize

Checked against the current code:

- Effect 4.0.5 (`runtime-bun-node.md:5`, `base-sessions-testing.md:9`): no
  longer holds; 4.1.0 since `8cee7c2`.
- NULL-hash login bypass at `000001-release-1.sql:851` and NULL-token reset
  bypass at `:1063` (`auth-login.md:93,147`): fixed in
  `migrations/current/2-null-safe-auth.sql` (`dd69022`). The fix is not in
  `committed/`, and production applies only `committed/`
  (`docs/deploy.md:36`). `change_password` had the same bypass (C:1223),
  also fixed there.
- `dbSetup.ts:2-3, :122` uses `NodeRuntime`/`NodeServices`
  (`runtime-bun-node.md:132`): no longer holds; the file is a 13-line
  `spawnSync("ops", ["dev", "db", "reset", "giglist"])`.
- `generateEnvFile.ts:86-89` comment and `:146` (`runtime-bun-node.md:132,141`):
  moved to `:54-55` and `:114`.
- `dbEnsure.ts:6, :84`: now `:8` and `:86`.
- Rate-limit doc says Caddy sets `X-Real-IP` and the API listens on loopback
  (`ratelimit-realtime-email.md:47`): no longer holds; the comment names
  Traefik (`src/server/httpapi/rate-limit.ts:95-101`) and production binds
  `0.0.0.0` (`cartridge.json:36`).
- OAuth "none found" (`auth-login.md:38`): holds for TypeScript; the
  graphile-starter OAuth SQL is present and unused (row 10).
- Session create "lives in `login` / `really_create_user`"
  (`base-sessions-testing.md:51`): partly; `really_create_user` creates no
  session; register inserts it in TypeScript.
- Still hold: bare uuid cookie (`httpapi/auth.ts:22-30`); reset signs the user
  in (`httpapi/auth.ts:62-68`); unknown login errors become
  `InvalidCredentials` (`services/auth.ts:108-116`, now with a log line);
  reset revokes sessions; `db.ts` layout and `withAuthContext` at `:85-106`;
  `SqlError` to defect at `db.ts:105`; `pg-error.ts:15-22`;
  `telemetry.ts:17-22`; hand-maintained `generated/DB.ts`; symbol
  passthrough at `effect-kysely.ts:122-124`; `chart-reader.ts:86` provides
  `BunServices` inside the service; `import.meta.dir` in
  `send-email.ts:50` and `worker/main.ts:35,45`; live-hub and mailer
  citations in `ratelimit-realtime-email.md`.
