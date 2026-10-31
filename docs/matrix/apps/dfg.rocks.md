# dfg.rocks

Music-lesson portal (courses, lessons, assignments, families, billing).
Repo: `~/build/dfg.rocks`, branch head `5d9f334`. All paths are relative to the
app root. "committed" is `migrations/committed/`, "current" is
`migrations/current/1-current.sql`.

Facts marked **observed on the local dev cluster** come from read-only
`psql` queries against the database that `ops dev db up` provisions. They are
not repo citations.

## 1. Runtime and HTTP layer

**present.** Bun in production; the Effect HTTP layer runs inside TanStack Start.

- Production entry is `Bun.serve` in `serve.ts:13-31`. It serves files from
  `dist/client` and hands every other request to the TanStack Start handler
  (`serve.ts:29`, `app/server.ts:7-12`). The image is `oven/bun:1.4.4`
  (`Dockerfile:1`) and starts with `bun run start` (`Dockerfile:29`,
  `package.json:12`).
- The Start file route `app/routes/api.$.ts:3-19` forwards every method on
  `/api/*` to `handleApiRequest` (`server/app.ts:92-95`).
- The API is `effect/http-api` `HttpApi`. `server/app.ts:27-32` builds one
  `HttpApi` from five groups; `HttpApiBuilder.layer` plus
  `HttpRouter.toWebHandler` makes a `(Request) => Promise<Response>`
  (`server/app.ts:45-48`, `:53-57`, `:68-82`). The router logger is off
  (`server/app.ts:75`). The handler is built once, lazily (`server/app.ts:84-90`).
- The platform layer is `@effect/platform-node` (`NodeHttpPlatform`,
  `NodeFileSystem`, `NodePath`) plus `Etag` and `FetchHttpClient`, merged into a
  `ManagedRuntime` (`server/runtime.ts:29-37`, `:76`). The handler takes the
  runtime context once (`server/app.ts:71-73`).
- Outside production, the testing group is added by dynamic import
  (`server/app.ts:41-50`).
- A second entry path exists: 22 files under `app/` call
  `serverRuntime.runPromise(...)` from TanStack `createServerFn` handlers and
  read the `session` cookie with `getCookie` (example:
  `app/routes/_authed/dashboard.tsx:30-33`, `app/lib/auth.ts:51-66`). These
  calls use the Effect services directly, without the `HttpApi` router.
- Fix: `b11213b` made the production server serve built client assets
  (`serve.ts` added).

## 2. Versions and data stack

**present.**

- `effect` 4.1.0 (`package.json:52`), `@effect/platform-node` 4.1.0 (`:36`),
  `@effect/sql-pg` 4.1.0 (`:37`), `@effect/vitest` 4.1.0 (`:74`).
- `kysely` 0.28.16 (`package.json:57`) as a query builder only; queries run
  through the `@effect/sql` client (`server/db.ts:33-60`). `pg` ^8.22.0
  (`package.json:62`) is used directly for the realtime LISTEN connection and
  in tests.
- `graphile-migrate` 2.0.0-rc.2 (`package.json:53`), `graphile-worker` ^0.16.6
  (`package.json:54`), `kysely-codegen` ^0.20.0 (`package.json:84`).
- Fix: `db2e711` removed `@effect/sql-kysely` (no Effect 4 release; its
  prototype patch caused the intermittent "this.compile is not a function"
  fiber crash) and added the compile-only `Database` class.

## 3. Config and env

**present.** Effect `Schema` decode of `process.env`, plus `Config` in two places.

- `server/assertEnv.ts:5-24` defines `envSchema`; `server/assertEnv.ts:30`
  decodes `process.env` synchronously at import. Required: `DATABASE_URL`,
  `AUTH_DATABASE_URL`, `ADMIN_EMAIL`, `DATABASE_VISITOR`, `NODE_ENV`,
  `VITE_ROOT_URL`. Optional: `UPLOADS_DIR`, `MAIL_PROVIDER`, `EMAIL_FROM`, and
  OAuth / mail secrets as `S.RedactedFromValue(S.String)` (`:15-23`).
- `Config.Redacted(urlKey)` reads the database URLs (`server/db.ts:120`);
  `Config.String("DATABASE_VISITOR")` is read per `withAuthContext` call
  (`server/db.ts:151`); `Config.Redacted("DATABASE_URL")` for the LISTEN
  connection (`server/services/realtimeService.ts:63`).
- The worker reads the same schema (`worker/.gmworkerrc.js:1-5`,
  `worker/tasks/send_email.js:10`); the Dockerfile copies `server/assertEnv.ts`
  for that reason (`Dockerfile:22-23`).
- Env loading: `bun --env-file=.env` in scripts (`package.json:8`, `:11`,
  `:14`, `:23`); `loadEnvFile()` in test setup (`server/test/globalSetup.ts:4`,
  `server/test/setup.ts:4`).
- `.env` generation: `scripts/generateEnvFile.ts:22-41` fills defaults and
  generates `SECRET`; `ops dev db up` writes the four database URLs
  (`scripts/generateEnvFile.ts:25-27`). `SECRET` is generated but no server
  code reads it. `scripts/devEnv.ts:6-13` extends the schema with
  `ADMIN_USERNAME` / `ADMIN_NAME` / `ADMIN_PASSWORD` for seeding.
- Production values come from `cartridge.json` `environment` and `secrets`
  (`cartridge.json:43-73`, `:85-110`).

## 4. Pools and roles

**present.** Two `PgClient` pools, one dedicated LISTEN client, and the
graphile-worker pool.

- `PgRootDB` uses `DATABASE_URL` (the migration login; owns the schema).
  `PgAuthDB` uses `AUTH_DATABASE_URL` (the API login)
  (`server/db.ts:135-144`). Each is `PgClient.make` with a connect retry on
  `SqlError` (`server/db.ts:108-127`). `PgRootDB.Live` also exposes its
  `SqlClient` (`server/db.ts:142-143`).
- Roles: owner group role `dfg_rocks_owner` (`.gmrc:3`), visitor
  `dfg_rocks_visitor` (`scripts/generateEnvFile.ts:27`), logins `migration`
  and `api` declared per service (`cartridge.json:27-38`, `:52-63`), visitor
  role passed as `DATABASE_VISITOR` (`cartridge.json:48`, `:90`). No
  `CREATE ROLE` exists in the repo. **Observed on the local dev cluster:** the
  migration login is a member of `dfg_rocks_owner` with
  `rolconfig role=dfg_rocks_owner`; the API login is `NOINHERIT` and a member
  of `dfg_rocks_visitor`; neither role has `BYPASSRLS`.
- Per request: `withAuthContext(sessionId, cb)` opens a transaction on
  `PgAuthDB` and runs `select set_config('role', $visitor, true),
  set_config('my.session_id', $sessionId, true)` before `cb`
  (`server/db.ts:146-166`). Both settings are transaction-local. SQL derives
  the user from `my.session_id` by a join to `app_private.sessions`
  (committed `000001-initial-schema.sql:265-274`).
- Each `withAuthContext` call is its own transaction; one request can open
  several (example: `server/services/authRouteService.ts:66`, `:109`, `:159`).
- Outside `withAuthContext`, code uses `PgRootDB` as the table owner. RLS is
  enabled but not forced, so these queries skip RLS. Session lookup, login,
  password reset, magic link, OAuth link, contact form, invitation accept and
  realtime recipient resolution use `PgRootDB`
  (`server/services/sessionService.ts:113`, `server/services/authService.ts:29`,
  `server/services/authRouteService.ts:9`,
  `server/services/publicRouteService.ts` via `db`,
  `server/services/realtimeService.ts:64`).
- The worker connects with `DATABASE_URL` (`worker/.gmworkerrc.js:4`), so jobs
  run as owner (comment at committed `000001-initial-schema.sql:5095-5104`).
- Fix: `2f31116` made `withAuthContext` set the visitor role per transaction,
  not per pooled session.

## 5. Typed handles

**present.** Services in `Context`; one generated `DB` type for every handle.

- `Database<T = DB>` extends `Kysely<T>` with a driver that throws on
  connect, so Kysely's own `.execute()` cannot run (`server/db.ts:33-60`).
  `db.execute(builder)` compiles and runs through `SqlClient.unsafe`
  (`server/db.ts:46-49`); `db.withTransaction` delegates to the client
  (`server/db.ts:51-53`).
- `PgRootDB` and `PgAuthDB` are `Context.Service<…, Database>` tags
  (`server/db.ts:136-144`). Services take them with `yield* PgRootDB`; visitor
  code receives the handle as the `cb` parameter of `withAuthContext`
  (`server/db.ts:146-149`).
- Types do not restrict reach: both handles are `Database<DB>`, and `DB`
  contains `app_private.*` tables (`generated/db.ts:994-1001`). The visitor
  handle can name `app_private.sessions` at compile time; Postgres denies it
  at run time.
- `addJob(db, task, payload)` queues a graphile-worker job inside the caller's
  transaction (`server/db.ts:173-180`).
- Result codecs: `int8` decodes to `number` and `time` to `HH:MM:SS`
  (`server/db.ts:68-106`). Fix: `5f76cb2` added these when the v4 driver began
  to decode results in binary.

## 6. Database error mapping

**present.** One `HttpError(status, message)` class and a lookup table of
SQLSTATE codes; mapping only at call sites that opt in.

- `pg_errcodes` maps `LOCKD`→423, `WEAKP`→400, `OWNER`→400, `NTFND`→404,
  `DNIED`→400, `23505`→409 (`server/pgErrors.ts:20-34`). `unwrapSqlError`
  takes `SqlError.cause` (`server/pgErrors.ts:36-38`).
- `catchPgErrors` maps known codes and leaves other errors unchanged
  (`server/pgErrors.ts:65-76`). It is used at 39 call sites in six service
  files (`rg -c 'catchPgErrors|mapPgError' server`).
- At each `HttpApi` handler, `adaptHttpApiErrors(effect, allowedStatuses)`
  turns `HttpError` into one of eleven tagged wire errors if the status is in
  the group's allow list; interrupts pass through; anything else is logged
  with its full cause and becomes a sanitized 500
  (`server/httpApiErrors.ts:109-179`). Wire errors are
  `S.TaggedError` classes (`shared/httpApiErrors.ts:24-117`). Allow lists are
  per group (`server/routes/auth.ts:14`, `server/routes/public.ts:28`,
  `server/routes/authenticated.ts:23`, `server/routes/admin.ts:58-59`).
- SQL raises codes the table does not map: `CDLEA`, `CREDS`, `ISMBR`,
  `LOGIN`, `MODAT`, `TAKEN`, `VRFY1`, `VRFY2` (`rg -o "errcode = '…'"` over
  the migrations). These reach the handler as unknown errors and become 500.
  The `WEAKP` raise is in `app_private.assert_valid_password`
  (committed `000001-initial-schema.sql:996-1003`), and every call to it is
  commented out (`:1048`, `:1201`, `:1254`).

## 7. Migrations and codegen

**present.** graphile-migrate; kysely-codegen after each `current` run.

- Layout: `migrations/committed/000001-initial-schema.sql` (6057 lines,
  `--! split:` sections named after the old files, e.g. `0150-user_auth.sql`
  at `:681`), `000002.sql` (one policy), `000003-realtime-outbox.sql`, and
  `migrations/current/1-current.sql` (978 lines, uncommitted "bill the paying
  user" change).
- Schemas: `app_public`, `app_hidden`, `app_private` (committed
  `000001-initial-schema.sql:48-50`). `app_hidden` has no objects; the visitor
  has `usage` on it (`:55`).
- `.gmrc`: `databaseOwner` (`.gmrc:3`), `search_path`
  `app_public,app_private,public` (`.gmrc:5`), placeholder
  `:DATABASE_VISITOR` from env (`.gmrc:8`). `afterReset` runs
  `ops dev db reset` on the shadow database, `afterReset.sql`, then
  `graphile-worker --schema-only` (`.gmrc:11-16`).
- `migrations/afterReset.sql:5-20` grants the database to the owner, grants
  `connect` to each member of the visitor role (needed because the API login
  is `NOINHERIT`), and makes the owner own `public`.
- Codegen: `afterCurrent` runs `bun db:types` (`.gmrc:18-20`);
  `.kysely-codegenrc.json:2-4` writes `generated/db.ts` and maps `int8` to
  `number`. `generated/` is gitignored (`.gitignore:19`).
- Production runs `bun run migrate` (worker schema, then
  `graphile-migrate migrate`) as a prestart (`package.json:30`,
  `cartridge.json:23-41`); that applies committed migrations only. Server code
  at head already reads `payer_id` and `app_public.student_payers`
  (`server/services/billingLedgerService.ts:1531`), which exist only in
  current (`current:162`, `:229`).
- Fixes: `9cffa34` (shadow database was recreated without extensions);
  `e7b97bf` (realtime outbox migration was in `current` only, while the 4.1
  server reads it at startup); `8dcebfe` (committed the families
  `select_admin` policy that production needed).

## 8. Sessions and cookies

**present.** Opaque two-part token, SHA-256 of the secret stored, absolute
30-day expiry.

- Table `app_private.sessions(id uuid, cookie_id text unique, secret_hash
  bytea, user_id, created_at, expires_at default now()+30 days)`
  (committed `000001-initial-schema.sql:246-253`); `active_student_id` is
  added later for parents acting as a child (used at
  `server/services/sessionService.ts:124`).
- Token `cookieId.secret`, each 32 random bytes hex
  (`server/services/sessionService.ts:12-14`, `:41-51`). Only
  `sha256(secret)` is stored (`:16-18`, `:158`). Validation looks up by
  `cookie_id`, compares hashes with `timingSafeEqual`, deletes the row if
  expired (`server/services/sessionService.ts:188-229`).
- TTL is absolute: `SESSION_TTL_MS` 30 days (`sessionService.ts:8`); no
  sliding refresh. SQL `current_user_id()` does not check `expires_at`
  (committed `000001-initial-schema.sql:272-274`).
- Cookie `session`: `httpOnly`, `sameSite: lax`, `secure` in production,
  `path /`, `expires` = row expiry (`server/routes/raw.ts:16-34`). Logout
  expires the cookie with the same options (`raw.ts:36-38`) and deletes the
  row by `cookie_id` (`server/services/sessionService.ts:243-245`,
  `server/routes/auth.ts:73-83`). The TS logout does not call
  `app_public.logout()`.
- Login: SQL `app_private.login` inserts a session row; TS then replaces its
  `cookie_id`, `secret_hash` and `expires_at` (`issueTokenForSession`,
  `server/services/sessionService.ts:165-187`,
  `server/services/authService.ts:57-59`). A session from before login is not
  deleted.
- Per-request lookup: each handler calls `requireAuth(request)` /
  `requireAdminSession` (`server/routes/authenticated.ts:46-53`,
  `server/routes/admin.ts:67-97`, `server/routes/familyBilling.ts:39-45`);
  server functions call `requireSession` (`app/lib/sessionGuards.server.ts:5-21`).
- CSRF: mutating handlers require any `X-Requested-With` header
  (`server/routes/raw.ts:40-46`); the client sets it on every request
  (`app/lib/api.ts:17-20`).
- `git log -p --follow server/services/sessionService.ts`: no bug-fix commits.

## 9. Password auth

**present.** SQL functions from graphile-starter, called from TS through
`PgRootDB`; bcrypt via pgcrypto `crypt(..., gen_salt('bf'))`.

- Register: no open password sign-up endpoint. Accounts come from invitation
  accept (`app_private.really_create_user` then `app_private.join_family`,
  `server/services/publicRouteService.ts:213-260`), OAuth (row 10),
  `app_public.create_child` (parents), and test helpers.
- Login: `POST /api/login` (`shared/httpApi.ts:568`) → CSRF check, rate limit,
  `app_private.login(username|email, password)`
  (`server/routes/auth.ts:29-48`, `server/services/authService.ts:31-62`).
  SQL accepts username or email, locks after 3 failures in 5 minutes with
  `LOCKD` (committed `000001-initial-schema.sql:774-843`).
- Verify email: `POST /api/verify-email` looks up the token in
  `app_private.user_email_secrets` and calls `app_public.verify_email`
  (`server/services/publicRouteService.ts:133-160`). Resend queues
  `user_emails__send_verification` (`server/services/authRouteService.ts:194-213`).
- Magic link: `app_private.generate_magic_link` (32-byte token, 15 minutes,
  verified emails only) and `app_private.verify_magic_link` (consumes token)
  (committed `000001-initial-schema.sql:2313-2360`); TS marks emails and user
  verified and creates a session (`server/services/authRouteService.ts:22-59`).
- Forgot: `app_public.forgot_password(email)` — 7-byte hex token, reused for 3
  days, one email per 3 minutes, separate job for unknown emails
  (committed `000001-initial-schema.sql:893-979`).
- Reset: TS finds `user_id` by token, then calls
  `app_private.reset_password(user_id, token, password)`
  (`server/services/authService.ts:80-126`). SQL clears the token, deletes all
  sessions, queues `user__audit`, returns a new session
  (committed `000001-initial-schema.sql:1005-1079`). It does not check
  `reset_password_token_generated`. With a wrong token the TS lookup gives
  `null`; the function is `strict`, so it returns null without counting the
  attempt, and the 20-attempt lockout (`:1025-1033`) is not reached.
- Change password: `app_public.change_password` exists with a visitor grant
  (committed `000001-initial-schema.sql:1180-1230`); no route or server
  function calls it.
- Password length: `assert_valid_password` (min 8) is commented out in
  `reset_password`, `change_password`, `really_create_user`
  (`:1048`, `:1201`, `:1254`); payload schemas use plain `S.String`
  (`shared/httpApi.ts:110`, `:119`, `:167`).
- Fix: `f45d55c` — a NULL `password_hash` (OAuth users) let login and
  `change_password` accept any password; a NULL reset token let
  `reset_password` and `set_child_password` accept any token. Checks now use
  `is null or is distinct from`.

## 10. OAuth

**present.** Google and Apple via `arctic`; Apple id_token checked with `jose`.

- Endpoints `/api/oauth/google`, `/callback`, `/api/oauth/apple`,
  `/api/oauth/apple/callback` (POST) (`shared/httpApi.ts:520-530`,
  `server/routes/public.ts:102-281`).
- Google uses state + PKCE (`server/services/oauthService.ts:147-158`),
  fetches OpenID userinfo (`server/routes/public.ts:33-56`). Apple uses state
  only, `response_mode=form_post` (`oauthService.ts:160-167`) and verifies the
  id_token against Apple JWKS (`oauthService.ts:49`, used at
  `server/routes/public.ts:242`).
- State and redirect live in cookies `oauth_<provider>` and
  `oauth_<provider>_redirect`, path `/api/oauth`, 10 minutes; Apple uses
  `SameSite=None` (`oauthService.ts:199-222`).
- Storage: `app_public.user_authentications(service, identifier, details)`
  and `app_private.user_authentication_secrets(details)` (committed
  `000001-initial-schema.sql:694-757`).
- Linking: TS always calls `app_private.link_or_register_user(null, ...)`
  (`server/services/publicRouteService.ts:107-133`). SQL matches by
  `(service, identifier)`, else by a verified local email, else calls
  `register_user(..., true)`, which stores the provider email as verified
  (committed `000001-initial-schema.sql:1382-1480`, `:1296-1361`). The
  logged-in link branch (`f_user_id` not null) is not reachable from TS.
- Success creates a session through `UserService.sessionFromUser`
  (`server/routes/public.ts:169-185`).

## 11. Authorization

**present.** RLS for the visitor role, families with owner / billing-contact
flags, user roles, and TypeScript role checks per handler.

- Roles: enum `admin | teacher | parent | student`
  (committed `000001-initial-schema.sql:291`). `current_user_role()` reads it
  by session join (`:317-319`).
- Families: `families`, `family_memberships(is_owner, is_billing_contact)`,
  `family_invitations` (committed `000001-initial-schema.sql:1565-1621`).
  Current adds one billing contact per family (`current:19-21`), one family
  per student (`current:23-56`), and the "payer" rule: a student's lessons
  are paid by the family billing contact, else by the user
  (`current:158-212`).
- Parent acting as child: `sessions.active_student_id`;
  `current_effective_user_id()` returns it only for a parent whose family
  contains the student (committed `000001-initial-schema.sql:3086-3097`);
  `is_acting_for_family_student()` admits staff or the effective user
  (`:3103-3106`). TS mirrors this with `resolveEffectiveStudent`
  (`server/services/sessionService.ts:74-81`).
- TypeScript checks: `requireAdminSession` checks `role === 'admin'`
  (`server/routes/admin.ts:67-86`); per-feature asserts in
  `server/routes/authenticated.ts:27-44`.
- Full policy list: SQL surface section.
- Fix: `01503b7` — billing read `app_public.families` through `PgRootDB`,
  which skipped RLS; reads moved into `withAuthContext` and a `select_admin`
  policy was added.

## 12. Rate limiting

**present.** In-memory fixed window from `effect/persistence/RateLimiter`.

- `RateLimitService.Live` uses `PersistenceRateLimiter.layerStoreMemory`,
  `algorithm: "fixed-window"`, `onExceeded: "fail"`, and maps
  `RateLimitExceeded` to `HttpError(429)` (`server/services/rateLimiter.ts:23-50`).
  Outside production `RateLimitService.Test` allows all
  (`rateLimiter.ts:52-54`, selected at `server/runtime.ts:40-41`).
- Key `dfg:rl:<scope>:<ip>` (`rateLimiter.ts:76`). Client IP is only
  `X-Real-Ip`, which Traefik sets, and only if `net.isIP` accepts it; without
  it every request shares the bucket `unknown` (`rateLimiter.ts:57-73`).
- Limits: login 10/min (`server/routes/auth.ts:33`), magic link 5/min
  (`auth.ts:54`), contact 5/min (`server/routes/public.ts:72`), accept invite
  10/min (`public.ts:307`). Forgot and reset password have no TS limit
  (`auth.ts:85-106`); forgot has the SQL 3-minute throttle (row 9).
- Fix: `2f31116` — the limiter trusted `Forwarded` and other client-set
  headers and skipped the limit when no IP was found; the non-production
  override in `app.ts` never reached request-time lookups.

## 13. Realtime

**present.** SSE; Postgres outbox table woken by one LISTEN; in-process
`EventEmitter` fan-out.

- Triggers call `app_public.tg__graphql_subscription(event, topic, column)`,
  which inserts into `app_private.realtime_events` under a transaction
  advisory lock so ids commit in order
  (committed `000003-realtime-outbox.sql:42-79`). A statement trigger sends an
  empty `pg_notify('realtime_events')` (`000003:29-40`). 16 tables attach the
  trigger (committed `000001-initial-schema.sql:2698-2774`, `:3015-3020`).
- `RealtimeService` opens one `pg.Client` outside the pool, runs
  `LISTEN realtime_events`, reads rows with `id > highWater`, and retries every
  5 s on loss (`server/services/realtimeService.ts:236-290`, `:319-336`). It
  starts from the current max id, so there is no replay of earlier rows
  (`:236-242`). Rows older than 24 h are deleted hourly (`:292-303`).
- Recipients: topic → TanStack Query keys (`realtimeService.ts:21-55`);
  subject → student, family members and staff (`:86-207`, staff cached 30 s at
  `:66-84`). Messages go to `realtimeBus` (`server/services/realtimeBus.ts:10-17`).
- `GET /api/events` streams `data: {event, subject, queryKeys}` filtered to the
  user and acting student, with a 15 s heartbeat
  (`server/routes/authenticated.ts:637-684`). The client invalidates queries
  (`app/lib/hooks/useRealtimeSync.ts`).
- Each API process listens and fans out to its own clients only.
- Fix: `5f76cb2` — 15 per-channel `PgClient.listen` connections exhausted the
  pool of 10 at startup; replaced by the outbox and one LISTEN.

## 14. Worker and mail

**present.** graphile-worker in a separate process; nodemailer with MJML
templates.

- Runner: `graphile-worker` CLI from `worker/` (`package.json:23`, `:31`),
  `worker/.gmworkerrc.js:3-6`, owner connection. Production runs it as the
  `dfg-rocks-worker` service (`cartridge.json:75-111`).
- Tasks (`worker/tasks/`): `send_email`, `user__audit`,
  `user__forgot_password`, `user__forgot_password_unregistered_email`,
  `user__magic_link`, `user__send_delete_account_email`,
  `user_emails__send_verification`, `family_invitations__send_invite`,
  `gcal__sync`, `gcal__ensure_lesson_event`, `lessons__generate_prepaid_period`,
  `bills__issue_monthly`, `testimonials__reminder_sweep`.
- Scheduling: crontab runs `testimonials__reminder_sweep` hourly
  (`worker/crontab:2`); `gcal__sync` is seeded by migration and reschedules
  itself (committed `000001-initial-schema.sql:2367-2371`,
  `worker/tasks/gcal__sync.js:157-165`). Nothing in the repo enqueues
  `bills__issue_monthly` (no crontab entry, no `add_job` call).
- Job sources: SQL `graphile_worker.add_job` in functions and the
  `tg__add_job` / `tg__add_audit_job` triggers (committed
  `000001-initial-schema.sql:74-139`); TS `addJob` inside a transaction
  (`server/db.ts:173-180`, `server/services/publicRouteService.ts:71-104`).
- Mail: `worker/transport.js` picks `MAIL_PROVIDER` or a default:
  `cloudflare` in production (SMTP `smtp.mx.cloudflare.net:465`, user
  `api_token`), `test` (nodemailer `jsonTransport`), else `development`
  (Ethereal account cached in `.ethereal`) (`worker/transport.js:17-97`).
- Templates: MJML files in `worker/templates/` rendered by `lodash.template`
  with `[[ ]]` escapes, `mjml2html`, then `html-to-text`
  (`worker/tasks/send_email.js:41-101`). Test mode pushes to
  `global.TEST_EMAILS` (`send_email.js:15`, `:67-69`).
- Fixes: `c380fe8` (mjml 5 returns a promise; every templated email failed);
  `6a856b6` (four queued job names had no task file, so those emails never
  sent); `5cec7fd` (contact submission and its email job now in one
  transaction).

## 15. Test harness and test database

**present.** vitest with `@effect/vitest`, in-process HTTP; Playwright E2E
against the production build; `bun test` for worker tasks.

- vitest: `globalSetup` resets the test database, `setupFiles` rewrites env
  (`vitest.config.ts:5-9`). `resetTestDatabase` runs
  `ops dev db reset <db>_test` then `bun run db:latest`
  (`scripts/testDatabase.ts:23-28`); `testDatabaseEnv` points both URLs at
  the test database (`scripts/testDatabase.ts:8-17`).
- In-process HTTP: the API test builds an `HttpClient` whose transport calls
  `handleApiRequest(new Request(...))`; no TCP port
  (`server/test/api.test.ts:140-160`). Some service tests provide layers
  directly (`server/test/familyBilling.test.ts:14-16`).
- Fixtures: raw `pg.Pool` calls to `app_private.really_create_user`, then
  `update ... set role` (`server/test/api.test.ts:133-136`). Auth in API tests
  is a real `POST /api/login` (`api.test.ts:170` onward).
- E2E: `scripts/e2eServer.ts:18-23` resets the test database, builds, and
  runs `serve.ts` with `NODE_ENV=test`; Playwright runs one worker
  (`playwright.config.ts:13`, `:28-32`). Auth is faked through the testing
  group `GET /api/testing/login`, which creates or updates a user, sets a
  bcrypt hash, creates a session and sets the cookie
  (`server/routes/testing.ts:46`, `server/services/testingService.ts:43-125`).
  The testing group refuses to load in production
  (`server/routes/testing.ts:35`).
- Worker: `bun test worker/test/*.test.js` (`package.json:27`).

## 16. Telemetry and logging

**absent** for OTLP and DevTools.

- No OpenTelemetry or DevTools package in `package.json`.
- Services wrap methods in `Effect.fn("name")` (for example
  `server/services/authRouteService.ts:12`), which creates spans, but no
  tracer layer exports them.
- Logging is the default Effect logger; the router logger is off
  (`server/app.ts:75`); unexpected HTTP failures are logged with
  `Effect.logError` (`server/httpApiErrors.ts:173`). The worker uses the
  graphile-worker logger and `console`.

## 17. API contract with the frontend

**present.** Shared `HttpApi` definition and `HttpApiClient`, plus TanStack
server functions.

- `shared/httpApi.ts` declares the groups and `clientApi`
  (`shared/httpApi.ts:511-1660`); `shared/schemas.ts` and
  `shared/responseMappers.ts` hold row and response schemas.
- Browser client: `HttpApiClient.make(clientApi)` with `FetchHttpClient`,
  `credentials: include`, and the CSRF header
  (`app/lib/api.ts:8-21`).
- The server mounts public, auth, authenticated (+ `events`), admin (+ two
  Google Calendar endpoints) and material download groups
  (`server/app.ts:27-40`). `clientApi` also contains `familyBillingGroup`
  (`shared/httpApi.ts:1602-1653`, `:1660`), and the frontend calls
  `api.familyBilling.*` (`app/routes/_authed/family/billing.index.tsx:27`).
  `makeFamilyBillingLayer` (`server/routes/familyBilling.ts:128`) has no
  caller, and `git log -S familyBilling -- server/app.ts` finds no commit that
  mounted it. Requests to `/api/family/*` fall through to no handler.
- Server functions (row 1) return JSON-round-tripped values
  (`app/lib/serverFunctionPayload.ts:1-6`).

## 18. Deployment

**present.** server-ansible cartridge on Nomad behind Traefik; one Docker
image for two services.

- `cartridge.json:1-113`: database `dfg_rocks` with `citext`, `pgcrypto`,
  `uuid-ossp` (`:4-9`); service `dfg-rocks-server` (`bun run start`, health
  check `/api/health`, uploads volume, `migrate` prestart) (`:11-74`);
  service `dfg-rocks-worker` (`bun run worker:prod`) (`:75-111`). Secrets come
  from a KV store and platform Postgres credentials.
- `Dockerfile:1-29`: multi-stage Bun build; runtime copies `dist`,
  `migrations`, `worker`, `.gmrc`, `serve.ts`, `server/assertEnv.ts`.
- Local: `ops dev db up` for Postgres (`package.json:15`); `mprocs` runs
  worker, app, typecheck and tests (`package.json:7`).
  `docker-compose.dev.yml` still defines a Postgres 18 container, not used by
  the scripts.

## 19. App-only backend features

- Lessons, recurring schedules, deposits, prepaid lesson generation
  (`server/services/recurringScheduleService.ts`, `lessonPolicyService.ts`).
- Billing ledger: bills, payments, allocations, credits, refunds,
  discounts, tax, monthly issuance, financial audit table
  (`server/services/billingLedgerService.ts`, committed `0330`–`0338`
  sections, current).
- PDF bills and receipts (`server/services/pdfService.ts`, `pdfkit`).
- Google Calendar sync of lessons (`server/services/googleCalendarService.ts`,
  `worker/tasks/gcal__*.js`).
- Course, module, material library with file uploads on local disk
  (`server/services/storageService.ts:23`, `fileService.ts`).
- Notation / AlphaTab track metadata (`server/services/notationService.ts`).
- Contact form gated by IP geolocation to Texas via ip-api.com
  (`server/routes/public.ts:66-99`, `server/services/geolocation.ts`).
- Testimonials with approval and reminder emails
  (`server/services/testimonialReminderService.ts`).
- Parent-created child accounts (`app_public.create_child` and
  `app_private.set_child_*`).

## SQL surface

Source: committed `000001`, `000002`, `000003` and current, in that order.
"Visitor EXECUTE" follows from these rules:

- `alter default privileges revoke all on functions from public`
  (committed `000001-initial-schema.sql:33`).
- `alter default privileges in schema public, app_public, app_hidden grant
  execute on functions to :DATABASE_VISITOR` (`:63-64`). Every new
  `app_public` function is executable by the visitor. A `drop` followed by
  `create` gets a new grant, even if an earlier statement revoked it.
- The visitor has no `usage` on `app_private` (`:55`), so no `app_private`
  function is callable by the visitor.
- **Observed on the local dev cluster** (`has_function_privilege`) for the
  billing functions listed below; results match these rules.

### Functions in app_public

| Function | SECURITY DEFINER | Visitor EXECUTE | Purpose | Defined |
|---|---|---|---|---|
| `current_session_id() → uuid` | no | yes | reads `my.session_id` | c000001:265 |
| `current_user_id() → uuid` | yes | yes | user id by session join | c000001:272 |
| `current_user_role() → user_role` | yes | yes | role by session join | c000001:317 |
| `current_user() → users` | no | yes | current user row | c000001:357 |
| `users_has_password(u users) → boolean` | yes | yes | has a password hash (self only) | c000001:412 |
| `verify_email(user_email_id uuid, token text) → boolean` | yes | yes | mark email verified if token matches | c000001:643 |
| `logout() → void` | yes | yes | delete current session (unused by TS) | c000001:852 |
| `forgot_password(email citext) → void` | yes | yes | issue reset token, queue email | c000001:893 |
| `request_account_deletion() → boolean` | yes | yes | issue deletion token, queue email | c000001:1088 |
| `confirm_account_deletion(token text) → boolean` | yes | yes | delete user if token matches | c000001:1137 |
| `change_password(old_password text, new_password text) → boolean` | yes | yes (also explicit grant c000001:1230) | change password, revoke other sessions | c000001:1180 |
| `make_email_primary(email_id uuid) → user_emails` | yes | yes | set primary email | c000001:1490 |
| `resend_email_verification_code(email_id uuid) → boolean` | yes | yes | queue verification email | c000001:1513 |
| `current_user_member_family_ids() → setof uuid` | yes | yes | families the user belongs to | c000001:1624 |
| `current_user_invited_family_ids() → setof uuid` | yes | yes | families the user is invited to | c000001:1629 |
| `create_family(slug citext, name text) → families` | yes | yes | create family | c000001:1657 |
| `invite_to_family(family_id uuid, username citext = null, email citext = null, invited_role text = 'parent') → void` | yes | yes | create invitation | c000001:1668 |
| `family_for_invitation(invitation_id uuid, code text = null) → families` | yes | yes | family for a valid invitation | c000001:1735 |
| `accept_invitation_to_family(invitation_id uuid, code text default null) → void` | yes | yes | join family via `join_family`, delete invitation | current:141 |
| `families_current_user_is_owner(org families) → boolean` | no | yes | computed column | c000001:1795 |
| `families_current_user_is_billing_contact(org families) → boolean` | no | yes | computed column | c000001:1807 |
| `remove_from_family(family_id uuid, user_id uuid) → void` | yes | yes | remove a member | c000001:1827 |
| `delete_family(family_id uuid) → void` | yes | yes | owner deletes family | c000001:1910 |
| `transfer_family_ownership(family_id uuid, user_id uuid) → families` | yes | yes | move owner flag | c000001:1924 |
| `transfer_family_billing_contact(family_id uuid, user_id uuid) → families` | yes | yes | move billing-contact flag (clear first) | current:59 |
| `current_user_family_member_ids() → setof uuid` | yes | yes | user ids in the caller's families | c000001:1993 |
| `current_effective_user_id() → uuid` | yes | yes | acting student for a parent, else user | c000001:3086 |
| `is_acting_for_family_student(student_id uuid) → boolean` | yes | yes | staff or effective user | c000001:3103 |
| `can_book_for_family_student(student_id uuid) → boolean` | yes | yes | staff, self, or family member | c000001:3111 |
| `create_child(p_family_id uuid, p_child_name text) → users` | yes | yes | parent creates student account | c000001:3197 |
| `enqueue_prepaid_lesson_generation(payment_id uuid) → void` | yes | yes (also explicit grant c000001:3527) | queue `lessons__generate_prepaid_period` | c000001:3507 |
| `next_bill_number() → integer` | yes | yes (observed) | `nextval('bill_number_seq')` | current:220 |
| `next_payment_number() → integer` | yes | yes | `nextval('payment_number_seq')` | current:224 |
| `payer_id_for_student(p_student_id uuid) → uuid` | yes | yes (observed) | payer via `student_payers`; `NTFND`/`DNIED` | current:182 |
| `current_user_visible_payer_ids() → setof uuid` | yes | yes | self + billing contacts of own families | current:200 |
| `monthly_billing_eligible(p_billing_month date) → table(...)` | yes | yes (observed; revoke at c000001:5498 undone by drop+create at current:409-410) | active recurring schedules for a month | current:410 |
| `monthly_occurrence_count(p_starts_on date, p_ends_on date, p_billing_month date, p_day_of_week smallint) → integer` | yes | no (revoked c000001:5501; observed) | weekday count in month | c000001:4662 |
| `get_effective_discount(p_payer_id uuid, p_on_date date) → jsonb` | yes | yes (observed; revoke c000001:5504 undone by current:367-368) | active discount | current:368 |
| `get_effective_tax_rate(p_payer_id uuid, p_on_date date) → jsonb` | yes | yes (observed; revoke c000001:5507 undone by current:384-385) | applicable tax rate | current:385 |
| `create_monthly_bill_line_items(p_bill_id uuid, p_student_id uuid, p_billing_month date, p_due_date date) → table(...)` | yes | yes (observed; revoke c000001:5115 undone by drop c000001:5233 + create c000001:5299; current uses `create or replace`) | line items for one student-month | current:437 |
| `enqueue_monthly_lesson_generation(p_student_id uuid, p_billing_month date) → void` | yes | no (revoked c000001:5112; observed) | queue lesson generation | c000001:4895 |
| `issue_monthly_bills(p_billing_month date) → jsonb` | yes | no (revoked c000001:5106; `create or replace` keeps it; observed) | idempotent monthly bill run | current:603 |
| `issue_monthly_bills_for_month(p_billing_month date, out result jsonb)` | yes | no (revoked c000001:5109; observed) | wrapper called by the worker | c000001:5083 |
| `create_single_booking_obligation(p_lesson_id uuid) → uuid` | yes | yes (observed; explicit grant c000001:5964 was on the dropped `(uuid, integer)`) | issue one bill per single-booking lesson | current:731 |
| `settle_single_booking_cancellation(p_lesson_id uuid, p_captured_deposit_cents integer default 0) → void` | yes | yes (observed; explicit grant c000001:6031 was on the dropped `(uuid, integer, boolean)`) | cancel open bill; captured deposit → credit | current:806 |
| `tg__graphql_subscription() → trigger` | yes | trigger | append to realtime outbox | c000003:42 |
| `tg_user_emails__forbid_if_verified() → trigger` | yes | trigger | refuse an email another user verified | c000001:494 |
| `tg_user_emails__prevent_delete_last_email() → trigger` | yes | trigger | keep at least one email | c000001:539 |
| `tg_user_emails__verify_account_on_verified() → trigger` | yes | trigger | set `users.is_verified` | c000001:667 |
| `tg_users__deletion_family_checks_and_actions() → trigger` | no | trigger | block owner deletion; hand billing contact to owner | current:92 |

Dropped and not recreated: `current_user_is_billing_contact_for(uuid)`
(current:214), `get_family_for_invitation`, `invite_user_to_family`
(c000001:1550, :1554).

### Functions in app_private

None is callable by the visitor (no schema `usage`).

| Function | SECURITY DEFINER | Purpose | Defined |
|---|---|---|---|
| `tg__add_job() → trigger` | yes | queue job named by `TG_ARGV[0]` with `{id}` | c000001:74 |
| `tg__add_audit_job() → trigger` | yes | queue `user__audit` | c000001:86 |
| `tg__timestamps() → trigger` | no | maintain `created_at` / `updated_at` | c000001:148 |
| `tg_user_secrets__insert_with_user() → trigger` | no | create `user_secrets` row | c000001:2894 (first c000001:393) |
| `tg_user_email_secrets__insert_with_user_email() → trigger` | yes | create `user_email_secrets` row | c000001:613 |
| `login(username citext, password text) → sessions` | no | password login with lockout; inserts session | c000001:774 |
| `assert_valid_password(new_password text) → void` | no | min length 8, `WEAKP` (all calls commented out) | c000001:996 |
| `reset_password(user_id uuid, reset_token text, new_password text) → sessions` | no | reset with token; revoke sessions | c000001:1005 |
| `really_create_user(username citext, name text, avatar_url text, email_is_verified bool, email text default null, password text default null) → users` | no | insert user, email, bcrypt hash | c000001:1241 |
| `register_user(f_service varchar, f_identifier varchar, f_profile json, f_auth_details json, f_email_is_verified boolean default false) → users` | yes | OAuth sign-up | c000001:1296 |
| `link_or_register_user(f_user_id uuid, f_service varchar, f_identifier varchar, f_profile json, f_auth_details json) → users` | yes | OAuth match / link / register | c000001:1382 |
| `set_password(user_id uuid, password text) → void` | yes | set bcrypt hash | c000001:1531 |
| `create_qr_invite(family_id uuid, invited_role text = 'parent') → family_invitations` | yes | invitation with code for QR | c000001:1718 |
| `generate_magic_link(v_email citext) → void` | yes | 15-minute token, queue email | c000001:2313 |
| `verify_magic_link(v_token text) → users` | yes | consume token | c000001:2341 |
| `tg__reset_testimonial_approval() → trigger` | yes | clear approval on edit | c000001:2794 |
| `testimonial_reminder_interval_days() → integer` | yes | read `admin_settings`, default 30 | c000001:2868 |
| `set_child_email(parent_id uuid, child_id uuid, new_email citext) → uuid` | yes | parent sets child email | c000001:3250 |
| `request_child_password_set(parent_id uuid, child_id uuid) → text` | yes | 24 h child password token | c000001:3284 |
| `set_child_password(child_id uuid, token text, new_password text) → void` | yes | set child password with token | c000001:3314 |
| `tg_bills__immutable_after_issue() → trigger` | no | block edits to issued bills | current:857 |
| `tg_payments__immutable() → trigger` | no | block payment edits | c000001:4262 |
| `tg_student_rates__record_history() → trigger` | yes | write `student_rate_history` | c000001:5192 |
| `tg__audit_record() → trigger` | yes | write `financial_audit_events` | c000001:5587 |
| `tg_financial_audit__immutable() → trigger` | no | block audit edits | c000001:5631 |
| `tg_payment_allocations__validate() → trigger` | yes | allocation ledger rules | current:930 |
| `tg_credit_applications__validate() → trigger` | yes | credit application rules | current:890 |
| `tg_credit_applications__consume() → trigger` | yes | mark credit consumed | current:876 |
| `tg_refunds__validate() → trigger` | yes | refund ≤ payment | c000001:5846 |
| `tg__realtime_events__notify() → trigger` | no | `pg_notify('realtime_events','')` | c000003:29 |
| `assert_student_in_one_family(p_user_id uuid) → void` | yes | `DNIED` if a student has >1 family | current:23 |
| `tg_family_memberships__one_family_per_student() → trigger` | yes | constraint trigger | current:34 |
| `tg_users__one_family_per_student() → trigger` | yes | constraint trigger on role change | current:45 |
| `join_family(p_family_id uuid, p_user_id uuid) → void` | yes | insert membership; first parent gets owner and billing contact | current:123 |

`scripts/seed-admin.ts:48` calls `app_private.create_user`, which no
migration defines. `app_hidden` has no functions.

### Tables with RLS and their policies

All policies are permissive. Conditions use `current_user_role()`,
`current_user_id()` and the helpers above. "staff" means
`current_user_role() in ('admin','teacher')`; "admin" means `= 'admin'`;
"own or family" means `student_id = current_user_id() or student_id in
current_user_family_member_ids()`.

RLS on, no policies (visitor sees and writes no rows; no visitor grants):
`app_private.sessions` (c000001:254), `app_private.user_secrets` (:385),
`app_private.user_email_secrets` (:606),
`app_private.user_authentication_secrets` (:757),
`app_private.realtime_events` (c000003:21).

RLS off: `app_private.unregistered_email_password_resets` (c000001:879),
`app_private.admin_settings` (c000001:2625). No visitor grants.

| Table (RLS line) | Policy | Cmd | Condition | Line |
|---|---|---|---|---|
| users (c000001:306) | select_all | select | `true` | c000001:324 |
| | update_self | update | `id = current_user_id()` | :326 |
| | update_admin | update | staff | :328 |
| user_emails (:452) | select_own / insert_own / delete_own | select / insert / delete | `user_id = current_user_id()` | :520-523 |
| | select_admin / insert_admin / delete_admin | select / insert / delete | staff | :526-530 |
| user_authentications (:705) | select_own / delete_own | select / delete | `user_id = current_user_id()` | :726-727 |
| families (:1572) | select_member | select | id in member families | :1634 |
| | select_invited | select | id in invited families | :1637 |
| | select_admin | select | staff | c000002:7 |
| | insert_admin / delete_admin | insert / delete | staff | c000001:1640-1642 |
| | update_owner | update | caller is owner member | :1819 |
| family_memberships (:1587) | select_member / select_invited | select | family in member / invited families | :1645-1648 |
| | select_admin | select | admin | current:156 |
| | insert_admin / delete_admin | insert / delete | staff | c000001:1651-1653 |
| family_invitations (:1607) | select/insert/update/delete _admin | all four | staff | :1612-1618 |
| contact_submissions (:2016) | admin_all | all | staff | :2017 |
| courses (:2038, :2129) | select_enrolled | select | staff or course of own/family enrollment | :2130 |
| | insert/update/delete _admin | | staff | :2139-2143 |
| modules (:2148) | select_via_course | select | staff or course of own/family enrollment | :2149 |
| | insert/update/delete _admin | | staff | :2158-2162 |
| materials (:2167) | select_accessible | select | staff, `is_global`, or via enrolled module / assigned material | :2168 |
| | insert/update/delete _admin | | staff | :2185-2189 |
| module_materials (:2194) | select_via_module | select | staff or module of own/family enrollment | :2195 |
| | insert/delete _admin | | staff | :2205-2207 |
| enrollments (:2212) | select_own | select | staff or own or family | :2213 |
| | insert/delete _admin | | staff | :2219-2221 |
| student_materials (:2226) | select_admin | select | `current_user_id() = student_id` or staff | :2103 |
| | select_own | select | staff or own or family | :2227 |
| | insert/update/delete _admin | | staff | :2105-2109 |
| practice_logs (:2380) | select_own | select | staff or own or family | :2382 |
| | insert_admin | insert | staff | :2392 |
| | insert_own / update_own | insert / update | `is_acting_for_family_student(student_id)` | :3125, :3130 |
| assignment_notes (:2403) | select_own | select | staff or own or family | :2405 |
| | insert_admin / update_admin | | staff | :2418-2420 |
| | insert_own / update_own | | acting for student | :3159, :3162 |
| messages (:2430) | select_own | select | staff, sender or recipient is self or family | :2432 |
| | update_recipient | update | `recipient_id = current_user_id()` | :2444 |
| | insert_admin / update_admin | | staff | :2447-2449 |
| | insert_sender | insert | acting for `sender_id` | :3170 |
| student_rates (:2563) | select_own | select | staff or own or family | :2565 |
| | insert/update/delete _admin | | staff | :2572-2576 |
| lessons (:2584) | select_own | select | staff or own or family | :2586 |
| | insert/update/delete _admin | | staff | :2593-2597 |
| | insert_family | insert | `can_book_for_family_student(student_id)` | :3178 |
| | update_own_scheduled | update | using: scheduled and acting; check: acting and status in (scheduled, cancelled) | :3367 |
| lesson_deposits (:2605) | select_own | select | staff or lesson is own/family | :2607 |
| | insert_admin / update_admin | | staff | :2617-2619 |
| | insert_family | insert | lesson bookable by caller | :3186 |
| | update_own | update | lesson where acting (using and check) | :3378 |
| lesson_notes (:2659) | select_own | select | staff, or non-draft note of own/family lesson | :2661 |
| | insert/update/delete _admin | | staff | :2674-2678 |
| testimonials (:2808) | select_approved_or_own | select | approved, own, or staff | :2810 |
| | insert_own_non_admin / update_own_non_admin / delete_own_non_admin | | own and role ≠ admin | :2817-2833 |
| | update_admin_approval | update | admin | :2839 |
| assignment_progress (:2941) | select_own | select | staff or own or family | :2943 |
| | insert/update/delete _admin | | staff | :2956-2960 |
| | insert_own / update_own | | acting for student | :3139, :3142 |
| assignment_reviews (:2989) | select_own | select | staff or own or family | :2991 |
| | insert_admin | insert | staff | :3001 |
| | insert_own | insert | acting for student | :3150 |
| recurring_schedules (:3465) | select_own | select | staff or rate of own/family student | :3467 |
| | insert/update/delete _admin | | staff | :3478-3483 |
| monthly_payments (:3488) | select_own | select | staff or own or family | :3490 |
| | insert/update/delete _admin | | staff | :3497-3502 |
| bills (:3669) | select_bills | select | admin or `payer_id in current_user_visible_payer_ids()` | current:284 |
| | insert/update/delete _bills | | admin | c000001:4319-4326 |
| bill_line_items (:3713) | select_bill_line_items | select | admin or bill visible | current:336 |
| | insert/delete _bill_line_items | | admin | c000001:4339-4342 |
| payments (:3749) | select_payments | select | admin or payer visible | current:290 |
| | insert/update/delete _payments | | admin | c000001:4352-4359 |
| payment_allocations (:3781) | select_payment_allocations | select | admin, bill visible, or payment visible | current:348 |
| | insert/delete _payment_allocations | | admin | c000001:4376-4379 |
| credits (ex family_credits, :3811; renamed current:242) | select_credits | select | admin or payer visible | current:299 |
| | insert/update/delete _credits (renamed current:296-298) | | admin | c000001:4389-4396 |
| refunds (:3843) | select_refunds | select | admin or payment visible | current:355 |
| | insert_refunds | insert | admin | c000001:4409 |
| bill_notifications (:3870) | select_bill_notifications | select | admin or bill visible | current:342 |
| | insert / update _bill_notifications | | admin | c000001:4422-4425 |
| financial_audit_events (:3895) | select / insert _financial_audit_events | | admin | :4430-4433 |
| discounts (ex family_discounts, :4088; renamed current:259) | select_discounts | select | admin or payer visible | current:308 |
| | insert/update/delete _discounts | | admin | c000001:4444-4451 |
| tax_rates (:4126) | select_tax_rates | select | staff | :4454 |
| | insert/update/delete _tax_rates | | admin | :4457-4464 |
| tax_exemptions (ex family_tax_exemptions, :4157; renamed current:267) | select_tax_exemptions | select | admin or payer visible | current:317 |
| | insert/update/delete _tax_exemptions | | admin | c000001:4473-4480 |
| credit_applications (ex family_credit_applications, :4180; renamed current:252) | select_credit_applications | select | admin or bill visible | current:324 |
| | insert_credit_applications | insert | admin | c000001:4492 |
| bill_adjustments (:4203) | select_bill_adjustments | select | admin or bill visible | current:330 |
| | insert_bill_adjustments | insert | admin | c000001:4504 |
| monthly_billing_runs (:4553) | select_monthly_billing_runs | select | admin or bill visible | current:360 |
| | insert/update/delete _monthly_billing_runs | | admin | c000001:4589-4598 |
| student_rate_history (:5164) | select_student_rate_history | select | admin | :5176 |

`bill_number_sequences` and `payment_number_sequences` (RLS on,
c000001:3591, :3598) are dropped in current (current:217-218).

### Grants to the visitor role

Schema and defaults:

- `usage` on schemas `public`, `app_public`, `app_hidden` (c000001:55).
- Default `usage, select` on new sequences in those schemas (c000001:59-60).
  This covers `bill_number_seq` and `payment_number_seq` (c000001:5539, :5542).
- Default `execute` on new functions in those schemas (c000001:63-64).
- Explicit function grants: `change_password(text,text)` (:1230),
  `enqueue_prepaid_lesson_generation(uuid)` (:3527),
  `create_single_booking_obligation(uuid,integer)` (:5964) and
  `settle_single_booking_cancellation(uuid,integer,boolean)` (:6031). The last
  two signatures are dropped in current (current:730, :803).
- Revokes: c000001:5106-5115 and :5498-5507 (see the function table for which
  still hold).

Tables (net after all statements; table names after the current renames,
which keep their grants):

| Table | Grants | Lines (c000001 unless noted) |
|---|---|---|
| users | select; update(username, name, bio, avatar_url) | 330, 332 |
| user_emails | select; insert(email); delete | 533-536 |
| user_authentications | select; delete | 745-746 |
| families | select, insert, delete; update(name, slug) | 1574 |
| family_memberships | select, insert, delete | 1591 |
| family_invitations | select, insert, delete; update(invited_role) | 1621 |
| contact_submissions | select, update | 2019 |
| courses | select, insert, update, delete | 2040, 2145 |
| modules | select, insert, update, delete | 2072, 2164 |
| materials | select, insert, update, delete | 2090, 2191 |
| student_materials | select, insert, update, delete | 2101, 2233 |
| module_materials | select, insert, delete | 2123, 2209 |
| enrollments | select, insert, delete | 2055, 2223 |
| practice_logs | select, insert, update (table level; column grants at 2250-2251 are covered) | 2249, 2398 |
| assignment_notes | select, insert, update (table level; column grants at 2269 covered) | 2269, 2423 |
| messages | select, insert, update (table level; column grants at 2296 covered) | 2296, 2452 |
| student_rates | select, insert, update, delete | 2492, 2579 |
| lessons | select, insert, update, delete | 2524, 2600, 3182 |
| lesson_deposits | select, insert, update | 2550, 2622 |
| lesson_notes | select, insert, update, delete | 2656 |
| testimonials | select; insert(body); update(body, is_approved); delete | 2842-2845 |
| assignment_progress | select, insert, update, delete (column grants covered) | 2963-2966 |
| assignment_reviews | select, insert (column grant covered) | 3004-3005 |
| recurring_schedules | select, insert, update, delete | 3486 |
| monthly_payments | select, insert, update, delete | 3505 |
| bills | select, insert; update(status, issued_at, paid_at, cancelled_at, voided_at, notes) | 3674, 4232 |
| bill_line_items | select, insert | 3719 |
| payments | select, insert; update(method, reference, received_at, notes) | 3754 |
| payment_allocations | select, insert | 3786 |
| credits | select, insert; update(consumed_at) | 3817 |
| refunds | select, insert | 3847 |
| bill_notifications | select, insert; update(status, error) | 3874 |
| financial_audit_events | select | 3904 |
| discounts | select, insert, update, delete | 4098-4099 |
| tax_rates | select, insert, update, delete | 4136-4137 |
| tax_exemptions | select, insert, update, delete | 4162-4163 |
| credit_applications | select, insert | 4185-4186 |
| bill_adjustments | select, insert | 4207-4208 |
| monthly_billing_runs | select, insert; update(status, error) | 4562 |
| student_rate_history | select | 5171 |
| student_payers (view, `security_invoker = true`) | select | current:162, :180 |

No grant on any `app_private` table.

### Roles and how they are created

- No `CREATE ROLE` in the repo. Roles come from the deploy platform
  (`cartridge.json` `postgres` and `PostgresCredentials` entries,
  `cartridge.json:4-9`, `:27-38`) and, locally, from `ops dev db up`, which
  reads the same cartridge (`scripts/devEnv.ts:4-5`,
  `scripts/generateEnvFile.ts:25-27`). Commit `6ffef2f` removed the old
  `scripts/dbSetup.ts` bootstrap.
- Names: owner group `dfg_rocks_owner` (`.gmrc:3`); visitor
  `dfg_rocks_visitor` (`scripts/generateEnvFile.ts:27`); logins `migration`
  (member of owner) and `api` (NOINHERIT, member of visitor) — membership and
  flags **observed on the local dev cluster**.
- `afterReset.sql` grants database privileges to the owner and `connect` to
  each visitor member, and gives the owner the `public` schema
  (`migrations/afterReset.sql:5-20`). Extensions come from the cartridge
  (`afterReset.sql:3`, `cartridge.json:7`).

## Older claims checked

Claims in `effect-web-template/docs/standardize/*.md` about this app, checked
against head:

No longer hold:

- Effect 3 / `@effect/sql-kysely` with a patch: now Effect 4.1.0 and a
  compile-only Kysely (`package.json:52`, `server/db.ts:33-60`; `db2e711`,
  `5f76cb2`).
- `HttpApp.toWebHandlerRuntime`: now `HttpApiBuilder.layer` +
  `HttpRouter.toWebHandler` (`server/app.ts:45-82`).
- Rate-limit header chain (`Forwarded`, CF headers) and "no IP skips the
  limit": now `X-Real-Ip` only, shared `unknown` bucket
  (`server/services/rateLimiter.ts:57-73`; `2f31116`).
- Realtime LISTEN on `rt:*` channels: now one outbox channel
  (`000003-realtime-outbox.sql`; `5f76cb2`).
- Two mail paths (Resend in the API, SES in the worker): contact now queues
  `send_email` (`server/services/publicRouteService.ts:88`);
  `emailService.ts` was removed in `c380fe8`; transport is Cloudflare SMTP.
- NULL-hash login bypass: fixed in `f45d55c`
  (committed `000001-initial-schema.sql:823-824`).
- "Reset does not clear the token" and "reset does not revoke sessions": both
  happen now (committed `000001-initial-schema.sql:1056-1063`).
- Test DB as `_test` suffix with `graphile-migrate reset --erase`: now
  `ops dev db reset` (`scripts/testDatabase.ts:23-28`; `6ffef2f`).
- File names `0150-user_auth.sql`, `0270-worker-jobs.sql`,
  `0312-realtime-triggers.sql`, `0327-parent-create-child.sql`: now
  `--! split:` sections in committed `000001` at `:681`, `:2302`, `:2691`,
  `:3194`; line numbers in the older docs do not map.

Still hold:

- Reset tokens have no expiry check in `reset_password`
  (committed `000001-initial-schema.sql:1005-1079`).
- The wrong-token reset lockout is not reachable from the app
  (`server/services/authService.ts:87-108`).
- Apple sign-in has no PKCE; its state cookie is `SameSite=None`
  (`server/services/oauthService.ts:160-167`, `:217`).
- Forgot and reset password have no TS rate limit
  (`server/routes/auth.ts:85-106`).
- Password length is not enforced (row 9).
- Sessions have an absolute 30-day expiry; login does not delete an earlier
  session.
- No server telemetry.
