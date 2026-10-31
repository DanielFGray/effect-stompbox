# effect-web-template

Repo: `~/build/effect-web-template`, branch `develop`, HEAD `db51b82`.
All paths are relative to the repo root. `migrations/committed/` is empty;
the whole schema lives in `migrations/current/`.

Origins stated in code or commits:

- Graphile starter kit (Benjie Gillam): `migrations/current/0130-user_emails.sql:1`,
  `migrations/current/0140-user_authentications.sql:1`,
  `migrations/current/0500-organizations.sql:1-6` ("Starter").
- knowledgebase: argon2id through pgsodium, `migrations/current/0140-user_authentications.sql:87`.
- postgres.garden and setlist: Cloudflare SMTP with the `api_token` user, commit `6a33970`.
- node-pg-template: the removed frontend UI, commit `ee79f88` (frontend deleted in `8b795b4`).

## Rows

### 1. Runtime and HTTP layer

present. Bun is the default runtime and Node is an alternative.

- There are two entry points over one shared layer: `server/main.bun.ts:7-21`
  (`BunHttpServer.layer`, `BunRuntime.runMain`) and `server/main.node.ts:9-23`
  (`NodeHttpServer.layer(() => createServer())`, `NodeRuntime.runMain`). Node
  runs TypeScript through tsx (`package.json:28`).
- Both serve `HttpRouter.serve(HttpApiLive)` and launch it with `Layer.launch`
  (`server/main.bun.ts:7,21`). `PORT` comes from `Config.Port`, and `HOST`
  defaults to `0.0.0.0` (`server/main.bun.ts:12-13`).
- The API is an `HttpApi` contract built with `HttpApiBuilder.layer(Contract)`
  (`server/runtime.ts:50-56`). The SSE route `GET /api/events` is a plain
  `HttpRouter.add` route merged next to it (`server/sseRoute.ts:16-47`,
  `server/runtime.ts:55`).
- A testing `HttpApi` mounts only outside production, through a dynamic import
  (`server/runtime.ts:63-72`).
- `makeHttpApiLive(oauthLayer, rateLimitLayer)` lets tests swap the OAuth and
  rate-limit layers (`server/runtime.ts:84-95`).
- Commit `8cc0e09` split the entry into Bun and Node over `runtime.ts`. Commit
  `8b795b4` removed the TanStack Start frontend and made the server API-only.

### 2. Versions and data stack

present.

- Effect packages: `effect` 4.1.0, `@effect/platform-bun` 4.1.0,
  `@effect/platform-node` 4.1.0 and `@effect/vitest` 4.1.0
  (`package.json:40-44`).
- Data access: `pg` ^8.23.1 with Kysely 0.28.17, pinned and overridden
  (`package.json:48,53,81`). `@effect/sql-pg` is not used; commit `8cc0e09`
  says `@effect/sql-kysely` does not exist in v4.
- SQLSTATE names come from `pg-error-enum` ^2.0.1 (`package.json:54`).
- Migrations and jobs: graphile-migrate ^1.4.1 and graphile-worker ^0.18.0
  (`package.json:45-46`).
- Codegen: kysely-codegen ^0.20.0 (`package.json:68`).
- Toolchain: TypeScript 7.0.2 and `@effect/tsgo` 0.63.0 (`package.json:59,75`).
- `postgres` (porsager) ^3.4.9 is used only by `scripts/dbEnsure.mjs:3`.
- `int8` parses to `BigInt` in the pool type parser (`server/db.ts:272-277`).
- Commit `2060ddf` moved the stack to Effect 4.1.

### 3. Config and env

present. Effect `Config` is used in the server and the worker. The worker task
files read `process.env` directly.

- Env files load through `--env-file=.env` on every script: `bun`
  (`package.json:8,25-26`) and `node` for vitest (`package.json:29`).
- `scripts/generateEnvFile.mjs:28-119` (`bun run env:init`) prompts for host,
  port, database name, `PORT` and `VITE_ROOT_URL`. It also writes these role
  names:
  - `DATABASE_OWNER=<db>_owner`
  - `DATABASE_AUTHENTICATOR=alchemy_<db>_api`
  - `DATABASE_VISITOR=<db>_visitor`

  (`scripts/generateEnvFile.mjs:93-95`). It writes no URLs. The comment says
  `ops dev db up` writes them (`scripts/generateEnvFile.mjs:24-27`).
- Server variables:
  - `DATABASE_URL`: root pool, `server/db.ts:131`.
  - `AUTH_DATABASE_URL`: auth pool, `server/db.ts:127`.
  - `DATABASE_VISITOR`: `server/requestDatabase.ts:26`.
  - `PORT` and `HOST`.
  - `NODE_ENV`: read with no default in `server/services/sessionCookie.ts:16`,
    so it is required. Other reads default to `development`
    (`server/devTools.ts:6-8`).
  - Optional: `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` and `VITE_ROOT_URL`
    (`server/services/oauthProviders.ts:48-59`), and `TRUSTED_PROXY_HEADER`
    (`server/rateLimit.ts:59`).
  - OTLP settings through `Otlp.layerFromConfig` (`server/tracing.ts:11`).
- Worker variables:
  - `DATABASE_URL` (`worker/main.ts:19`).
  - `MAIL_PROVIDER` and `NODE_ENV` (`worker/email/mailer.ts:58-76`).
  - `EMAIL_FROM`, `CLOUDFLARE_EMAIL_API_TOKEN` and `ETHEREAL_ACCOUNT_FILE`
    (`worker/email/mailer.ts:117,143,165-166`).
  - `process.env.VITE_ROOT_URL`, read in each task
    (`worker/tasks/user_emails__send_verification.mjs:75`).
- graphile-migrate variables: `DATABASE_URL`, `SHADOW_DATABASE_URL` and
  `ROOT_DATABASE_URL` (`.gmrc:16-17`), plus the placeholders
  `:DATABASE_AUTHENTICATOR` and `:DATABASE_VISITOR` from env (`.gmrc:46-49`).
- `scripts/dbEnsure.mjs:4` and `scripts/generateEnvFile.mjs:4` import `dotenv`,
  which is not declared in `package.json`.

### 4. Pools and roles

present. There are two Kysely pools, plus one dedicated LISTEN client and the
worker's own pool.

- **Pools:**
  - `PgRootDB` uses `DATABASE_URL` (`server/db.ts:130-132`). The cartridge
    supplies the `migration` login for it (`cartridge.json:46-50`), and
    `.gmrc:12-13` says that login is a member of the `effect_test_owner` group
    role.
  - `PgAuthDB` uses `AUTH_DATABASE_URL`, with the cartridge `api` login
    (`server/db.ts:124-128`, `cartridge.json:52-56`).
  - Each pool connects with `select 1` and retries with jittered exponential
    backoff while the error is a `DatabaseError` (`server/db.ts:285-308`).
  - Realtime opens its own `pg.Client` on `DATABASE_URL`
    (`server/services/realtime.ts:60-85,106`).
  - The worker gives `DATABASE_URL` to graphile-worker `run()`
    (`worker/main.ts:19,40`).
- **Role names:** owner `<db>_owner`, authenticator `alchemy_<db>_api` and
  visitor `<db>_visitor` (`scripts/generateEnvFile.mjs:93-95`,
  `.gmrc:13`). No `CREATE ROLE` exists in the repo. Roles come from the
  external `ops dev db` tool (`scripts/dbSetup.mjs:1-4`, commit `1c0dd25`).
- **Per request:** `withAuthContext`
  (`server/requestDatabase.ts:23-63`) runs these steps:
  1. It resolves the session id on the root pool through
     `app_private.validate_session` (`server/requestDatabase.ts:34`,
     `server/services/session.ts:68-74`).
  2. It opens a transaction on `PgAuthDB`.
  3. In that transaction it runs one `select` with
     `set_config('role', <visitor>, true)` and
     `set_config('my.session_id', <uuid or null>, true)`. Both are
     transaction-local (`server/requestDatabase.ts:36-55`).
  4. It provides the transaction handle as `RequestDatabase`
     (`server/requestDatabase.ts:56`).

  A `DatabaseError` that escapes is logged and becomes a defect
  (`server/requestDatabase.ts:59-62`).
- **Outside a request:** login, register, forgot and reset password, email
  verify, sessions, OAuth linking and realtime run on `PgRootDB` as the owner
  (`server/services/users.ts:24,115,136,229,236`,
  `server/services/email.ts:53-67`, `server/services/oauthIdentity.ts:31`).
- **Bug fix:** `c1bc713`. `set_config('role', ..., false)` was session-level,
  so the pooled authenticator connection kept the visitor role after the
  request. The fix makes it transaction-local, and
  `server/requestDatabase.test.ts:28-39` tests it.
- **Bug fix:** `bea3a85`. `withAuthContext` piped Effect combinators onto a
  Proxy-wrapped Kysely builder, which corrupted its commit trap and made each
  authenticated request spin forever.
- **Uncertain:** no file grants membership in the visitor role to the
  authenticator, but `set_config('role', ...)` needs it. The grant is assumed
  to happen outside the repo, in `ops dev db`.

### 5. Typed handles

present. Query code reaches a connection through a `Context.Service`.

- `DbHandle<Schema>` has these members (`server/db.ts:85-122`):
  - `connection`: a `Kysely<Schema>`.
  - `raw`: wraps a `sql` template.
  - `all`, `one` and `maybe`: run a query with an optional error map.
  - `tryAll`: keeps `DatabaseError` typed.
  - `transaction`: `acquireUseRelease` over a Kysely `ControlledTransaction`,
    which commits on success and rolls back on failure
    (`server/db.ts:210-222,251-259`).
- `PublicDB` is `Pick<DB, app_public.*>` (`server/db.ts:82`).
- `PgAuthDB` and `RequestDatabase` are `DbHandle<PublicDB>`
  (`server/db.ts:124`, `server/requestDatabase.ts:13-16`). A query that names
  an `app_private` table fails to compile:
  `server/requestDatabase.test.ts:22-26` holds a `@ts-expect-error` for it.
- `PgRootDB` is `DbHandle<DB>`, the full generated type (`server/db.ts:130`).
- Only `withAuthContext` provides `RequestDatabase`
  (`server/requestDatabase.ts:56`). Visitor services get it with
  `yield* RequestDatabase` (`server/services/posts.ts:16`).
- The type limit does not cover `raw`/`sql`, because SQL text is not checked
  (`server/db.ts:92,232-234`). The service key string is still `'CurrentDb'`
  (`server/requestDatabase.ts:16`).
- Every query runs in a `db.query` span (`server/db.ts:224-229`).
- Commit `db51b82` added the schema-typed handle and deleted
  `RequestDatabase.layer`. That commit says the layer would have run visitor
  queries on the root pool with no RLS (row-level security).

### 6. Database error mapping

present.

- `toDatabaseError` decodes `{ code }` from the driver error into
  `DatabaseError.code` (`server/db.ts:29-35,134-143`).
- Each call passes an optional map from code to factory to `all`, `one` or
  `maybe` (`server/db.ts:97-113`). `finish` (`server/db.ts:175-200`) handles
  the result:
  - `23505` unique-violation calls its factory with an empty message
    (`server/db.ts:183-189`).
  - Custom 5-character codes are allowed only when they are in
    `SafeErrCodeMap`: CREDS, LOCKD, WEAKP, LOGIN, DNIED, MDEML, TAKEN, EMTKN,
    CDLEA, VRFY1, VRFY2, ISMBR, NTFND and OWNER (`server/db.ts:40-55`). These
    pass the driver message to the factory (`server/db.ts:145-157,190-196`).
  - Any other code, or an allowed code that the call does not map, is logged
    with `Effect.logError` and becomes a defect (`server/db.ts:167-168`).
    `HttpApi` answers 500 with no driver detail (commit `1e4153e`).
  - `one` with zero rows is a defect (`server/db.ts:202-208`).
- Domain errors are 8 `S.TaggedError` classes, each with one `httpApiStatus`
  (`shared/errors.ts`):
  - `InternalError` 500 (`shared/errors.ts:8-17`)
  - `Unauthorized` 401 (`shared/errors.ts:19-30`)
  - `Forbidden` 403 (`shared/errors.ts:32-42`)
  - `NotFound` 404 (`shared/errors.ts:44-53`)
  - `Conflict` 409 (`shared/errors.ts:55-72`)
  - `Locked` 423 (`shared/errors.ts:74-80`)
  - `TooManyRequests` 429 (`shared/errors.ts:82-92`)
  - `InvalidOperation` 400 (`shared/errors.ts:94-112`)

  Each class with several meanings has a typed `reason` literal. Commit
  `e9c7691` merged 19 classes into these 8.
- Mapping examples:
  - `CREDS` and `LOCKD` map to `Unauthorized` and `Locked`
    (`server/services/users.ts:115-119`).
  - `23505` maps to `Conflict username_taken`
    (`server/services/users.ts:150-154`).
  - `OWNER` maps to `Conflict owns_organization`
    (`server/services/users.ts:288-290`).
- Some SQL codes are not mapped at their call site, so they become 500.
  Examples:
  - `DNIED` and `LOGIN` from `confirm_account_deletion`
    (`server/services/users.ts:276-292`).
  - `LOGIN` from `request_account_deletion`
    (`server/services/users.ts:261-274`).
  - `LOGIN`, `NTFND` and `DNIED` from `organization_for_invitation`, through
    `acceptInvitation`, which has no error map
    (`server/services/organizations.ts:219-237`,
    `migrations/current/0500-organizations.sql:232-249`).
- **Bug fix:** `3d4ba5c`. A login with no row was mapped to 500. It now
  returns 401 with the same body as `CREDS`.
- **Bug fix:** `bea3a85`. `23505` on register fell through as 500. It now
  maps to a domain error.
- `server/db.test.ts:24-135` covers the mapping.

### 7. Migrations and codegen

present.

- graphile-migrate keeps 13 files in `migrations/current/`, numbered
  `0001`-`1020`. `migrations/committed/` is empty.
  `migrations/current/0001-reset.sql:8-10` drops the three app schemas.
- Schemas: `app_public`, `app_hidden` and `app_private`
  (`migrations/current/0020-schemas.sql:9-11`). `app_hidden` holds no objects.
  `graphile_worker` is installed by `graphile-worker --schema-only`
  (`package.json:9,13`).
- `.gmrc` settings:
  - `databaseOwner` is `effect_test_owner` (`.gmrc:13`).
  - `pgSettings.search_path` is `app_public,app_private,app_hidden,public`
    (`.gmrc:25-27`).
- `afterReset` (`.gmrc:70-73`) runs two actions:
  - For the shadow database only, `ops dev db reset "$GM_DBNAME"`, because
    graphile-migrate recreates the shadow empty, with no extensions (commit
    `8c6a417`).
  - `migrations/afterReset.sql`, which grants `CONNECT` to the owner and the
    authenticator and makes the owner own the `public` schema
    (`migrations/afterReset.sql:1-7`).
- Extensions come from the cartridge (`cartridge.json:4-18`,
  `migrations/afterReset.sql:6`): `uuid-ossp`, `citext`, `btree_gin`,
  `pgcrypto`, `pg_trgm`, `fuzzystrmatch` and `pgsodium`.
- Codegen: kysely-codegen runs from the `afterCurrent` hook
  `bun run db:types --url 'env(GM_DBURL)'` (`.gmrc:91-98`). The options are
  in `.kysely-codegenrc.json:1-9`:
  - Output goes to `./generated/db.d.ts`, which is gitignored
    (`.gitignore:183`).
  - Migration tables are excluded.
  - `int8` maps to `bigint`.
- **Bug fix:** `d84261d`. The hook had no output file, so it wrote into
  `node_modules/kysely-codegen/dist/db.d.ts`. `generated/db.d.ts` changed only
  when someone ran `bun db:types` by hand.

### 8. Sessions and cookies

present.

- The cookie is named `session` (`server/services/sessionCookie.ts:6`). Its
  value is the opaque `<cookie_id>.<secret>`
  (`server/services/session.ts:88`), with no HMAC
  (`server/services/sessionCookie.ts:23-27`). `parseSessionToken` splits it at
  the first dot (`shared/sessionToken.ts:7-15`).
- `app_private.create_session` makes `cookie_id` and `secret` from 32 random
  bytes each, hex-encoded. It stores only `digest(decode(secret,'hex'),'sha256')`
  in `app_private.sessions.secret_hash`
  (`migrations/current/0110-sessions.sql:77-105`). The table is at
  `migrations/current/0110-sessions.sql:44-52`.
- Lifetimes: idle 7 days, absolute 30 days, refresh 1 hour, from SQL
  functions (`migrations/current/0110-sessions.sql:25-35`).
- `validate_session` refuses an empty input, bad hex, a null or different
  hash, an idle session past expiry, or a session past the absolute cap. It
  moves `expires_at` forward at most once per refresh interval, never past
  the cap (`migrations/current/0110-sessions.sql:113-157`).
- Cookie attributes are set in one policy: `httpOnly`, `secure` when
  `NODE_ENV` is production, `sameSite: lax`, `path /`, `maxAge 30 days`
  (`server/services/sessionCookie.ts:13-21`).
- `SessionCookieHttp` is `HttpApiMiddleware` with
  `provides: SessionCookie`, applied to the whole contract
  (`shared/sessionCookie.ts:10-26`, `shared/httpApi.ts:14`). For each request
  it builds `read`, `write` and `clear`. `write` and `clear` attach cookies
  through `HttpEffect.appendPreResponseHandler`
  (`server/services/sessionCookie.ts:28-61`).
- **Lookup per request:**
  - `currentUser` → `userFromSessionToken` → `Sessions.validateSession`
    (`server/auth.ts:12-22`). That runs `validate_session`, then a join of
    `sessions` and `users` that checks expiry again
    (`server/services/session.ts:34-51,94-98`).
  - `withAuthContext` calls only `resolveSessionId`.
  - The SSE route reads the cookie directly (`server/sseRoute.ts:21`).
  - A missing or invalid cookie is anonymous, not an error
    (`server/requestDatabase.ts:33`).
- **Login** deletes the caller's previous session after a successful
  password check (`server/auth.ts:33-42`). OAuth does the same
  (`server/oauth.ts:150-159`).
- **Logout** runs `app_public.logout()` under `withAuthContext`. That function
  deletes the row and clears `my.session_id`. Logout then expires the cookie
  (`server/auth.ts:85-89`,
  `migrations/current/0140-user_authentications.sql:223-230`).
- `app_private.cookie_sessions` (`migrations/current/0110-sessions.sql:9-15`)
  exists, but no TypeScript refers to it.
- **Bug fixes:**
  - `dc4e72d`: logout ran outside `withAuthContext`, so
    `current_session_id()` was null and the row was never deleted.
  - `999fde0`: logout left the browser cookie in place.
  - `efc5b2a`: in the earlier TanStack Start adapter, `Set-Cookie` was
    appended to the wrong response through AsyncLocalStorage lookup, so login
    set a cookie about 1 time in 10.
  - `03bff35`: replaced HMAC-signed cookies and the `SECRET` env var with
    hashed opaque tokens.

### 9. Password auth

present. Most steps are SQL functions, and TypeScript calls them.

- **Register:** `registerAndCreateSession` (`server/auth.ts:49-60`) calls
  `app_private.really_create_user` on the root pool
  (`server/services/users.ts:40-80,131-156`,
  `migrations/current/0140-user_authentications.sql:595-635`). Email is
  required (`MDEML`). The password check is `length >= 8` in SQL
  (`migrations/current/0140-user_authentications.sql:347-354`). TypeScript
  also checks the `Password` schema: at least 8 characters, already trimmed
  (`shared/fields.ts:25`, `shared/validation.ts:1-8`). Register creates a
  session.
- **Login:** `app_private.login(username citext, password text)` on the root
  pool (`server/services/users.ts:26-38,111-129`). It accepts a username or an
  email; with an email it prefers a verified one
  (`migrations/current/0140-user_authentications.sql:148-164`).
  - It returns null for bad credentials and does not raise, so the failure
    count is kept (`migrations/current/0140-user_authentications.sql:208-214`).
  - Lockout: 3 failures inside 5 minutes raise `LOCKD`
    (`migrations/current/0140-user_authentications.sql:144,180-189`).
  - An unknown user, or an account with no password, runs argon2 verify
    against a dummy hash so that timing is equal
    (`migrations/current/0140-user_authentications.sql:115-123,166-174,191-197`).
    `server/authTokens.test.ts:371` tests this.
- **Verify email:**
  - A trigger makes a 32-byte token, stores its sha256 hex, and queues
    `user_emails__send_verification` with the plaintext token
    (`migrations/current/0130-user_emails.sql:172-200`).
  - `app_public.verify_email(token)` runs on the root pool. The token is good
    for 24 hours and works once
    (`server/services/email.ts:53-67`,
    `migrations/current/0130-user_emails.sql:168-170,211-252`).
  - The first verified email sets `users.is_verified`
    (`migrations/current/0130-user_emails.sql:260-272`).
  - A resend makes a new token
    (`migrations/current/0130-user_emails.sql:296-325`).
- **Forgot password:** `app_public.forgot_password(email)` runs on the root
  pool (`server/services/users.ts:82-85,226-230`).
  - It sends at most one email per address every 3 minutes.
  - An unknown address gets an "unregistered" email at most every 15 minutes,
    tracked in `app_private.unregistered_email_password_resets`
    (`migrations/current/0140-user_authentications.sql:251-332`).
- **Reset password:** `app_private.reset_password(reset_token, new_password)`
  runs on the root pool (`server/services/users.ts:87-98,232-248`).
  - The token alone finds the account, and it lasts 1 hour.
  - 20 failures inside the window raise `LOCKD`.
  - It deletes every session of the user and queues an audit job
    (`migrations/current/0140-user_authentications.sql:356-431`).
- **Change password:** `app_public.change_password` runs under
  `withAuthContext`. It needs the old password, deletes all sessions of the
  user, and queues an audit job
  (`server/services/users.ts:195-224`,
  `migrations/current/0140-user_authentications.sql:535-583`). TypeScript then
  creates a new session for the caller (`server/auth.ts:66-82`).
- **Account deletion:** `request_account_deletion` emails a 1-hour token.
  `confirm_account_deletion` needs that token and the same logged-in user
  (`migrations/current/0140-user_authentications.sql:441-527`).
- **Hashing:** argon2id through `pgsodium.crypto_pwhash_str`, stored base64,
  in SQL (`migrations/current/0140-user_authentications.sql:87-105`). The
  source says "same pattern as knowledgebase" at line 87. Commits `c4b10e4`
  and `f8cfdf0` added it.
- **Tokens:** all emailed tokens are stored as sha256 hex
  (`migrations/current/0140-user_authentications.sql:107-113`). Links put the
  token in the URL fragment
  (`worker/tasks/user__forgot_password.mjs:45-46`).
- **Origin:** Graphile starter kit
  (`migrations/current/0140-user_authentications.sql:1`).

### 10. OAuth

present. The only provider is GitHub, through `arctic` ^3.7.0
(`package.json:43`).

- **Flow:**
  - `GET /api/auth/github` makes state and a PKCE S256 verifier
    (`server/services/oauthGithub.ts:66-82`). It stores both as base64url JSON
    in the HttpOnly cookie `oauth_github`, which lasts 10 minutes
    (`server/oauth.ts:11-45,51-66`).
  - `GET /api/auth/github/callback` expires that cookie on every path. It
    compares state in constant time
    (`server/oauth.ts:89-94,124-130`,
    `server/services/oauthProviders.ts:36-40`). Then it exchanges the code,
    fetches `/user` and `/user/emails`, and picks a primary verified email
    (`server/services/oauthGithub.ts:83-145`).
  - The routes are `handleRaw` endpoints in the contract
    (`shared/api/users.ts:101-110`, `server/api/users.ts:41-42`).
- **Providers:** a map built from `Config`. When `GITHUB_CLIENT_ID` is unset,
  the map is empty and the routes answer 404
  (`server/services/oauthProviders.ts:46-81,91-101`). The redirect URI comes
  from `VITE_ROOT_URL` (`server/services/oauthProviders.ts:56-64`). Tests use
  `OAuthProvidersTest` (`server/services/oauthProviders.ts:84-89`).
- **Linking:**
  - The user id comes from the current session, never from the body
    (`server/oauth.ts:137-142`).
  - `app_private.link_or_register_user` runs on the root pool
    (`server/services/oauthIdentity.ts:24-58`,
    `migrations/current/0140-user_authentications.sql:728-833`).
  - An identity linked to another user raises `TAKEN`.
  - A merge by email happens only when the provider marks the email verified
    and a local verified email matches
    (`migrations/current/0140-user_authentications.sql:776-797`). On that
    branch the audit job sends `'user_id', f_user_id`, which is null there
    (`migrations/current/0140-user_authentications.sql:787-795`), so
    `user__audit` finds no user and returns
    (`worker/tasks/user__audit.mjs:103-108`).
  - With no match, `app_private.register_user` cleans up the username and
    makes it unique
    (`migrations/current/0140-user_authentications.sql:645-710`).
- **Storage:** the identity goes in `app_public.user_authentications`
  (`service`, `identifier` = GitHub numeric id, `details`)
  (`migrations/current/0140-user_authentications.sql:15-24`). Token details go
  in `app_private.user_authentication_secrets`
  (`migrations/current/0140-user_authentications.sql:67-70`). The callback
  passes no `authDetails`, so `{}` is stored
  (`server/services/oauthIdentity.ts:33`).
- **Unlink:** `DELETE /api/oauth/:id` under the RLS `delete_own` policy
  (`server/services/users.ts:250-259`).
- **Bug fix:** `510c0d0` removed `POST /auth/:provider`. It passed a
  client-supplied user id and identity to `link_or_register_user` with no
  authentication. Commit `86e4baa` added the server-side callback.

### 11. Authorization

present. Authorization is mostly RLS and SECURITY DEFINER SQL functions
(functions that run with the privileges of their owner).

- Policies are listed in the SQL surface section below.
- **App roles:** `app_public.user_role` is `user` or `admin`
  (`migrations/current/0120-users.sql:12,22`). The posts and comments
  policies use it for admin select and delete
  (`migrations/current/1000-posts.sql:21-31,39-48`,
  `migrations/current/1010-comments.sql:25-28`).
- **Organizations:** `organizations`, `organization_memberships` (with
  `is_owner` and `is_billing_contact`) and `organization_invitations`
  (`migrations/current/0500-organizations.sql:34-92`).
  - Visibility uses SECURITY DEFINER set functions, to avoid RLS recursion
    (`migrations/current/0500-organizations.sql:184-218`).
  - All writes to memberships and invitations go through SECURITY DEFINER
    functions that check ownership (`migrations/current/0500-organizations.sql:103-490`).
- **Checks in TypeScript:**
  - Update calls return no row when RLS blocks them. TypeScript reads that as
    `Unauthorized` or `Forbidden`
    (`server/services/users.ts:183-192`,
    `server/services/organizations.ts:85-93`).
  - `listInvitations` selects explicit columns so that the invite `code` is
    not returned (`server/services/organizations.ts:128-136`).
  - The SSE route returns 401 with no user (`server/sseRoute.ts:22-24`).
- **Bug fix:** `ee79f88`. `organization_invitations` had RLS on but no grant
  and no select policy. The commit added both.

### 12. Rate limiting

present.

- The store is Effect `RateLimiter` with `layerStoreMemory`, in-process
  (`server/rateLimit.ts:1-8,102`).
- `RateLimitMiddleware` is `HttpApiMiddleware` with `requires: SessionCookie`
  and `error: TooManyRequests` (`shared/api/rateLimit.ts:12-17`). Endpoints opt
  in with `.middleware(RateLimitMiddleware)` (`shared/api/users.ts:38,45`).
- Rules are keyed `group:endpoint` (`server/rateLimit.ts:31-43`):

  | Rule | Key | Limit |
  |---|---|---|
  | login | IP | 10 / 5 min |
  | register | IP | 5 / h |
  | forgotPassword | IP | 5 / h |
  | resetPassword | IP | 10 / h |
  | verifyEmail | IP | 20 / h |
  | changePassword | user | 10 / h |
  | addEmail | user | 5 / day |
  | resendVerification | user | 5 / day |
  | requestDeletion | user | 3 / day |
  | confirmDeletion | user | 10 / h |
  | organizations:invite | user | 20 / day |

- A `user` rule keys on the cookie id, with no database lookup. With no
  cookie it falls back to the network key (`server/rateLimit.ts:73-80`).
- **Client IP:** the socket `remoteAddress`. When `TRUSTED_PROXY_HEADER` is
  set, only that header is used (`server/rateLimit.ts:56-71`). With no address
  the key is `unknown`.
- `networkOf` keeps IPv4 as one address, unwraps `::ffff:` IPv4, and groups
  IPv6 by /64 (`server/clientIp.ts:7-23`).
- An exceeded limit returns 429 with `retryAfterSeconds`. A store error
  becomes a defect (`server/rateLimit.ts:104-120`).
- Production sets `TRUSTED_PROXY_HEADER=x-real-ip` (`cartridge.json:39-40`;
  commit `e388a5c` says Traefik overwrites X-Real-IP).
- Tests use a pass-through layer by default (`server/rateLimit.ts:46-49`).

### 13. Realtime

present. It uses SSE, LISTEN/NOTIFY and an outbox table with replay.

- **Outbox:** `app_private.realtime_events` (`id` bigint identity, `user_id`,
  `type`, `payload` jsonb) (`migrations/current/0150-realtime_events.sql:7-18`).
  - Writes go through `app_private.publish_event`. It takes
    `pg_advisory_xact_lock` so that ids commit in order
    (`migrations/current/0150-realtime_events.sql:35-53`).
  - A statement trigger sends an empty `pg_notify('realtime_events','')`
    (`migrations/current/0150-realtime_events.sql:23-33`).
- **Listener:** each API process holds one LISTEN `pg.Client`. The client
  attaches its `error` handler before connect
  (`server/services/realtime.ts:55-85`).
  - On each notify it reads rows past a high-water mark and publishes them to
    an in-process `PubSub` (`server/services/realtime.ts:165-197`).
  - After a lost connection it reconnects every 5 seconds, with jitter
    (`server/services/realtime.ts:199-206`).
- **Replay:** `subscribe(userId, afterId)` subscribes first, then reads the
  backlog after `afterId`, then streams live events filtered by user and by
  id greater than the watermark (`server/services/realtime.ts:215-231`).
- **Route:** `GET /api/events` reads `Last-Event-ID`
  (`server/services/realtime.ts:242-245`). It sends a keepalive comment every
  15 seconds and the headers `text/event-stream` and `x-accel-buffering: no`
  (`server/sseRoute.ts:16-47`).
- **Cleanup:** an hourly delete of rows older than 24 hours
  (`server/services/realtime.ts:154-163,208-213`).
- `publish_event` is called only from the test helper
  `server/test/clients.ts:63-77`. No app code publishes events.
- Commit `6cce606` added realtime.

### 14. Worker and mail

present.

- **Runner:** graphile-worker `run()` inside an Effect program
  (`worker/main.ts:18-59`). It runs `getTasks` from `worker/tasks/`, plus an
  Effect task `send_email` that `runPromiseWith` the context and the abort
  signal (`worker/main.ts:23-41`).
- The crontab has no entries (`worker/crontab:1-15`).
- **Tasks:** these are plain `.mjs` files that use `withPgClient` and
  `addJob('send_email', ...)`:
  - `user_emails__send_verification` (`worker/tasks/user_emails__send_verification.mjs:17-87`)
  - `user__forgot_password` (`worker/tasks/user__forgot_password.mjs:15-50`)
  - `user__forgot_password_unregistered_email` (`worker/tasks/user__forgot_password_unregistered_email.mjs:31`)
  - `user__send_delete_account_email` (`worker/tasks/user__send_delete_account_email.mjs:34`)
  - `user__audit` (`worker/tasks/user__audit.mjs:51-149`). It skips audits
    within 2 seconds of account creation (`worker/tasks/user__audit.mjs:109`).
- **Who queues jobs:**
  - SQL queues jobs with `graphile_worker.add_job` in triggers and functions
    (`migrations/current/0030-common_triggers.sql:21-84`,
    `migrations/current/0130-user_emails.sql:187-190`).
  - The trigger on `organization_invitations` queues
    `organization_invitations__send_invite`
    (`migrations/current/0500-organizations.sql:95-96`), but no task file
    handles that name.
- **Mail:**
  - `send_email` decodes the job against the `QueuedEmail` union of five
    templates (`worker/email/sendEmail.ts:16-53`).
  - It renders `worker/templates/*.mjml` through `lodash.template` with
    `[[ ]]` delimiters, MJML strict mode and `html-to-text`
    (`worker/email/sendEmail.ts:68-106`).
  - It sends through the `Mailer` service.
- **Providers:** `MAIL_PROVIDER` is `ethereal` (the development default; the
  account is cached in `.ethereal`), `capture` (the test default; an in-memory
  `Ref`) or `cloudflare` (the production default; SMTP to
  `smtp.mx.cloudflare.net:465` with user `api_token`)
  (`worker/email/mailer.ts:51-76,91-193`). Transport is nodemailer
  (`worker/email/mailer.ts:201-254`).
- An SMTP rejection is a `MailDeliveryError`, which fails the job, and
  graphile-worker retries it (`worker/email/mailer.ts:241-246`).
- **Origin:** Cloudflare SMTP "as postgres.garden and setlist do"
  (commit `6a33970`).
- **Bug fix:** `6a33970` deleted the SES branch. It imported an undeclared
  `aws-sdk` and would throw on every production send.

### 15. Test harness and test database

present.

- The runner is vitest ^5 with `@effect/vitest` `it.live`
  (`vitest.config.ts:1-15`, `package.json:78`). It runs through
  `node --env-file=.env` (`package.json:29`).
- **Test database:**
  - `globalSetup` runs `db:ensure`, then `ops dev db reset effect_test_test`,
    then `graphile-migrate watch --once` and `graphile-worker --schema-only`
    against `_test`, once per run (`server/test/globalSetup.ts:6-18`).
  - `setup.ts` points `DATABASE_URL` and `AUTH_DATABASE_URL` at
    `<db>_test` on 127.0.0.1 (`server/test/setup.ts:1-3`,
    `server/test/testDatabase.ts:7-36`).
- **HTTP:** in-process. `HttpRouter.toWebHandler(makeHttpApiLive(...))` sits
  behind a `FetchHttpClient.Fetch` stub, with no TCP listener
  (`server/test/apiHarness.ts:15-38`). Tests hold cookies in a jar
  (`server/test/apiHarness.ts:45-66`).
- **Auth in tests** is real: tests register and log in over HTTP
  (`server/test/clients.ts:20-47`).
- **Testing API:** routes under `/api/testing`, mounted outside production
  only (`server/testingApi.ts:41-96,282-297`):
  - create and clear users and organizations;
  - read user and email secrets;
  - read plaintext tokens from the latest `graphile_worker._private_jobs`
    payload (`server/testingApi.ts:98-108`).
- **Doubles:** `OAuthProvidersTest` and `RateLimitMiddlewarePassThrough`
  (`server/test/apiHarness.ts:15-21`). The mail test uses `smtp-server` and
  the capture Mailer (`worker/email/sendEmail.test.ts:4`).
- `@testcontainers/postgresql` is declared (`package.json:60`) but no code
  imports it. Commit `8c33f8c` removed the helper.
- **Bug fix:** `2060ddf`. The tsconfig excluded test files, which hid an
  Effect 4.1 `withCookiesRef` change. Tests threw at runtime with no type
  error.

### 16. Telemetry and logging

present.

- **OTLP:** `Otlp.layerFromConfig`, with the service name and version from
  `package.json`, JSON serialization and `FetchHttpClient`. It stays silent
  until it is configured (`server/tracing.ts:11-16`, commit `8cc0e09`).
- **DevTools:** `DevTools.layer()` outside production
  (`server/devTools.ts:4-12`).
- **Log level:** `References.MinimumLogLevel` is `All`
  (`server/runtime.ts:74-78`). Logs use the default Effect logger; there is
  no custom format.
- **Spans:**
  - `db.query` on every query (`server/db.ts:228`).
  - `Effect.fn` names such as `db:session:insert` and `db:user:login`
    (`server/services/session.ts:83`, `server/services/users.ts:111`).
  - `Mailer.send` and `sendEmail` (`worker/email/mailer.ts:225`,
    `worker/email/sendEmail.ts:68`).
- The worker program provides no OTLP layer (`worker/main.ts:55-59`). Its
  `.mjs` tasks log with `console`.

### 17. API contract with the frontend

present. The contract is a shared `HttpApi`. No frontend is in the repo.

- `Contract = HttpApi.make('Contract')` with the groups posts, users, email
  and organizations, the `SessionCookieHttp` middleware and the prefix `/api`
  (`shared/httpApi.ts:9-15`). There is one group module per file in
  `shared/api/`.
- Schemas: `Model.Class` (`shared/schemas.ts:6-110`), payloads
  (`shared/payloads.ts`) and field schemas whose messages never repeat the
  input value (`shared/fields.ts:1-30`).
- Errors carry their HTTP status (`shared/errors.ts`).
- On the wire, `bigint` ids are strings (`shared/schemas.ts:37-38`).
- The typed `HttpApiClient.make(Contract)` is used in tests
  (`server/post.test.ts:23`).
- SSE is outside the contract (`server/sseRoute.ts:10-16`).
- History: commit `8b795b4` removed the TanStack Start frontend. Commit
  `ee79f88` had ported that UI from node-pg-template.

### 18. Deployment

present.

- `cartridge.json` uses `apiVersion: server-ansible/v2` (`cartridge.json:2`).
- It declares one Postgres database with seven extensions
  (`cartridge.json:4-18`).
- It declares two services, each running `bun`:
  - `effect-test-api`: `server/main.bun.ts`, port 3000, 384 MB, with
    `NODE_ENV`, `PORT` and `TRUSTED_PROXY_HEADER`
    (`cartridge.json:19-58`).
  - `effect-test-worker`: `worker/main.ts`, 256 MB, with `MAIL_PROVIDER` set
    to `cloudflare` and `EMAIL_FROM` (`cartridge.json:59-97`).
- Secrets:
  - `PostgresCredentials`: login `migration` → `DATABASE_URL` and login
    `api` → `AUTH_DATABASE_URL` (`cartridge.json:44-56,83-89`).
  - `KvSecret` for the Cloudflare token (`cartridge.json:90-95`).
- The repo has no Dockerfile.
- Local development uses `ops dev db` (`package.json:13-15`) and `mprocs` to
  run server, migrate watch, worker, typecheck and vitest
  (`package.json:32`).

### 19. App-only backend features

present.

- Posts with `privacy` (public, secret, private) and a feed sorted by
  `created_at`, `updated_at` or stars
  (`migrations/current/1000-posts.sql:3-16`,
  `server/services/posts.ts:27-40`).
- Comments with `parent_id` threading. These exist in SQL only; no API
  (`migrations/current/1010-comments.sql:1-10`).
- Stars on posts and comments, with counts and toggles. The functions exist
  in SQL; the API exposes only a star count on posts
  (`migrations/current/1020-stars.sql`, `server/services/posts.ts:50-56`).
- Organizations with an owner, a billing contact, invitations by username or
  email code, and transfers (`server/api/organizations.ts:8-68`).
- Several email addresses per user, with primary and verified flags and a
  rule against deleting the last one
  (`migrations/current/0130-user_emails.sql:9-145`).
- Audit emails on account changes (`worker/tasks/user__audit.mjs`).
- The domain `app_public.tag` exists but nothing uses it
  (`migrations/current/1000-posts.sql:1`).

## SQL surface

Sources: `migrations/current/*.sql` and `migrations/afterReset.sql`.
`migrations/committed/` is empty. File names below drop the `migrations/current/`
prefix. "SD" means `SECURITY DEFINER`. "sp" means the function sets
`search_path to pg_catalog, public, pg_temp`.

### Functions in app_public (35)

| Function | SD | sp | Purpose | Cite |
|---|---|---|---|---|
| `current_session_id() returns uuid` | no | no | Reads `my.session_id` setting, empty → null | `0110-sessions.sql:65-67` |
| `current_user_id() returns uuid` | yes | yes | `user_id` of the current session row | `0110-sessions.sql:69-71` |
| `users_has_password(u users) returns boolean` | yes | yes | Whether the current user has a password hash | `0120-users.sql:105-107` |
| `tg__user_emails__forbid_if_verified() returns trigger` | yes | yes | Raises `EMTKN` when the email is verified by anyone | `0130-user_emails.sql:64-75` |
| `tg__user_emails__prevent_delete_last_email() returns trigger` | yes | yes | Statement trigger; raises `CDLEA` when the delete leaves no (verified) email; `FOR UPDATE` lock | `0130-user_emails.sql:94-145` |
| `verify_email(token text) returns boolean` | yes (strict) | yes | Hashes token, 24 h lifetime, marks verified, makes primary when none, clears token | `0130-user_emails.sql:211-252` |
| `tg__user_emails__verify_account_on_verified() returns trigger` | yes (strict) | yes | Sets `users.is_verified` on the first verified email | `0130-user_emails.sql:260-272` |
| `make_email_primary(email_id uuid) returns user_emails` | yes (strict) | yes | `DNIED` when not owned, `VRFY1` when unverified; swaps primary | `0130-user_emails.sql:274-290` |
| `resend_email_verification_code(email_id uuid) returns boolean` | yes (strict) | yes | Makes a new token, queues `user_emails__send_verification` | `0130-user_emails.sql:296-325` |
| `logout() returns void` | yes | yes | Deletes the current session row, clears `my.session_id` | `0140-user_authentications.sql:223-230` |
| `forgot_password(email citext) returns void` | yes (strict) | yes | Spacing of 3 min (known) and 15 min (unknown); stores the reset token hash; queues a job | `0140-user_authentications.sql:259-332` |
| `request_account_deletion() returns boolean` | yes (strict) | yes | `LOGIN` when anonymous; stores the deletion token hash; queues `user__send_delete_account_email` | `0140-user_authentications.sql:441-472` |
| `confirm_account_deletion(token text) returns boolean` | yes (strict) | yes | Token plus the same user plus 1 h, else `DNIED`; deletes the user | `0140-user_authentications.sql:479-527` |
| `change_password(old_password text, new_password text) returns boolean` | yes (strict) | yes | `CREDS`, `WEAKP`, `LOGIN`; sets the hash, deletes all user sessions, audit job | `0140-user_authentications.sql:535-581` |
| `create_organization(slug citext, name text) returns organizations` | yes | yes | `LOGIN`; inserts the org plus an owner and billing membership | `0500-organizations.sql:103-115` |
| `invite_to_organization(organization_id uuid, username citext = null, email citext = null) returns void` | yes | yes | Owner only (`DNIED`), `ISMBR`, `VRFY2`, `NTFND`; 7-byte hex code for email invites | `0500-organizations.sql:124-172` |
| `current_user_member_organization_ids() returns setof uuid` | yes | yes | Org ids the current user belongs to (used in policies) | `0500-organizations.sql:184-187` |
| `current_user_invited_organization_ids() returns setof uuid` | yes | yes | Org ids the current user is invited to by user id | `0500-organizations.sql:189-192` |
| `organization_for_invitation(invitation_id uuid, code text = null) returns organizations` | yes (stable) | yes | `LOGIN`, `NTFND`, `DNIED`; checks the invitee or the code | `0500-organizations.sql:226-256` |
| `accept_invitation_to_organization(invitation_id uuid, code text = null) returns void` | yes | yes | Adds the membership, deletes the invitation | `0500-organizations.sql:267-282` |
| `remove_from_organization(organization_id uuid, user_id uuid) returns void` | yes | yes | Removes self or (owner) another member; moves billing contact to the owner | `0500-organizations.sql:290-335` |
| `organizations_current_user_is_owner(org organizations) returns boolean` | no | no | Computed column | `0500-organizations.sql:341-351` |
| `organizations_current_user_is_billing_contact(org organizations) returns boolean` | no | no | Computed column | `0500-organizations.sql:357-367` |
| `tg_users__deletion_organization_checks_and_actions() returns trigger` | no | no | Before user delete: `OWNER` when the user owns an org; gives billing contact back to the owners | `0500-organizations.sql:374-406` |
| `delete_organization(organization_id uuid) returns void` | yes | yes | Deletes when the caller is the owner; otherwise nothing | `0500-organizations.sql:411-423` |
| `transfer_organization_ownership(organization_id uuid, user_id uuid) returns organizations` | yes | yes | Owner moves `is_owner` to a member; null when not allowed | `0500-organizations.sql:429-456` |
| `transfer_organization_billing_contact(organization_id uuid, user_id uuid) returns organizations` | yes | yes | Owner moves `is_billing_contact` | `0500-organizations.sql:462-490` |
| `stars_on_posts(p posts) returns bigint` | no | no | Star count for a post | `1020-stars.sql:25-30` |
| `posts_user_starred(p posts) returns boolean` | yes | no | Whether the current user starred the post | `1020-stars.sql:32-37` |
| `star_post(id bigint) returns bigint` | yes | no | Inserts a star for the current user, returns the count | `1020-stars.sql:39-45` |
| `unstar_post(id bigint) returns bigint` | yes | no | Deletes the current user's star, returns the count | `1020-stars.sql:47-53` |
| `stars_on_comments(c_id bigint) returns bigint` | no | no | Star count for a comment | `1020-stars.sql:81-86` |
| `comments_user_starred(c comments) returns boolean` | yes | no | Whether the current user starred the comment | `1020-stars.sql:88-98` |
| `star_comment(id bigint) returns bigint` | yes | no | Inserts with `on conflict do nothing`, returns the count | `1020-stars.sql:100-105` |
| `unstar_comment(id bigint) returns bigint` | yes | no | Deletes the star. The final `select count(*) ... where comment_id = t.comment_id` compares the column with itself, so it counts all rows | `1020-stars.sql:107-113` |

### Functions in app_private (24)

| Function | SD | sp | Purpose | Cite |
|---|---|---|---|---|
| `tg__timestamps() returns trigger` | no | yes | Sets `created_at` on insert; `updated_at` always increases | `0030-common_triggers.sql:10-16` |
| `tg__add_job() returns trigger` | yes | yes | `graphile_worker.add_job(tg_argv[0], {id})` | `0030-common_triggers.sql:21-26` |
| `tg__add_audit_job() returns trigger` | yes | yes | Queues `user__audit` with the type, user id, up to 3 extra columns and `current_user_id` | `0030-common_triggers.sql:31-84` |
| `session_idle_lifetime() returns interval` | no | no | 7 days | `0110-sessions.sql:25-27` |
| `session_absolute_lifetime() returns interval` | no | no | 30 days | `0110-sessions.sql:29-31` |
| `session_refresh_interval() returns interval` | no | no | 1 hour | `0110-sessions.sql:33-35` |
| `create_session(p_user_id uuid) returns table(session_id uuid, cookie_id text, secret text, expires_at timestamptz)` | yes | yes | Inserts a session; returns the plaintext secret once | `0110-sessions.sql:77-105` |
| `validate_session(p_cookie_id text, p_secret text) returns uuid` | yes | yes | Checks the hash and the idle and absolute expiry; slides the expiry hourly; returns the session uuid or null | `0110-sessions.sql:113-157` |
| `tg__user_secrets__insert_with_user() returns trigger` | no | yes | Inserts the `user_secrets` row after a user insert | `0120-users.sql:86-97` |
| `email_verification_token_lifetime() returns interval` | no | no | 24 hours | `0130-user_emails.sql:168-170` |
| `tg__user_email_secrets__insert_with_user_email() returns trigger` | yes | yes | Makes the verification token for unverified emails; queues the send job | `0130-user_emails.sql:172-200` |
| `reset_password_token_lifetime() returns interval` | no | no | 1 hour | `0140-user_authentications.sql:79-81` |
| `delete_account_token_lifetime() returns interval` | no | no | 1 hour | `0140-user_authentications.sql:83-85` |
| `hash_password(p_password text) returns text` | no | no | argon2id through `pgsodium.crypto_pwhash_str`, base64 | `0140-user_authentications.sql:88-93` |
| `verify_password(p_hash text, p_password text) returns boolean` | no | no | `crypto_pwhash_str_verify`; null hash → false | `0140-user_authentications.sql:95-105` |
| `hash_token(p_token text) returns text` | no | no | sha256 hex of the hex-decoded token; null on bad input | `0140-user_authentications.sql:107-113` |
| `login(username citext, password text) returns users` | no (strict) | no | Username or email login, lockout, dummy-hash timing; called on the root pool | `0140-user_authentications.sql:137-216` |
| `assert_valid_password(new_password text) returns void` | no | no | `WEAKP` when shorter than 8 | `0140-user_authentications.sql:347-354` |
| `reset_password(reset_token text, new_password text) returns boolean` | no (strict) | no | Token lookup, 1 h, lockout after 20 failures, sets the hash, deletes all sessions, audit job | `0140-user_authentications.sql:356-431` |
| `really_create_user(username citext, email text, email_is_verified bool default false, name text default null, avatar_url text default null, password text default null) returns users` | no | yes | `WEAKP`, `MDEML`; inserts the user and email; sets the hash | `0140-user_authentications.sql:595-635` |
| `register_user(f_service varchar, f_identifier varchar, f_profile json, f_auth_details json, f_email_is_verified boolean default false) returns users` | yes | yes | OAuth registration with a cleaned, unique username | `0140-user_authentications.sql:645-710` |
| `link_or_register_user(f_user_id uuid, f_service varchar, f_identifier varchar, f_profile json, f_auth_details json) returns users` | yes | yes | Link, merge by verified email, or register; `TAKEN`; syncs profile details | `0140-user_authentications.sql:728-833` |
| `tg__realtime_events__notify() returns trigger` | no | yes | `pg_notify('realtime_events','')` | `0150-realtime_events.sql:23-33` |
| `publish_event(p_user_id uuid, p_type text, p_payload jsonb default '{}') returns bigint` | yes | yes | Takes the advisory transaction lock, then inserts an outbox row | `0150-realtime_events.sql:35-56` |

### Functions in app_hidden

None. The schema is created and the visitor gets `usage` on it
(`0020-schemas.sql:10,16`), but nothing is put in it.

### Triggers

- `_100_timestamps` (`tg__timestamps`) on:
  - `users` (`0120-users.sql:49-52`)
  - `user_emails` (`0130-user_emails.sql:36-39`)
  - `user_authentications` (`0140-user_authentications.sql:32-35`)
  - `posts` (`1000-posts.sql:57-61`)
  - `comments`, before update only (`1010-comments.sql:37-40`)
- `users`:
  - `_500_insert_secrets` (`0120-users.sql:92-95`)
  - `_500_deletion_organization_checks_and_actions`, before delete, when
    `current_user_id()` is not null (`0500-organizations.sql:401-406`)
- `user_emails`:
  - `_200_forbid_existing_email` (`0130-user_emails.sql:72-75`)
  - `_500_audit_added` and `_500_audit_removed` (`0130-user_emails.sql:42-61`)
  - `_500_prevent_delete_last`, statement level (`0130-user_emails.sql:141-145`)
  - `_500_insert_secrets` (`0130-user_emails.sql:197-200`)
  - `_500_verify_account_on_verified` (`0130-user_emails.sql:267-272`)
- `user_authentications`: `_500_audit_removed`
  (`0140-user_authentications.sql:47-55`)
- `organization_invitations`: `_500_send_email` →
  `tg__add_job('organization_invitations__send_invite')`
  (`0500-organizations.sql:95-96`)
- `realtime_events`: `_900_notify`, statement level
  (`0150-realtime_events.sql:30-33`)

### RLS tables and policies

RLS is enabled on 16 tables.

| Table | Policy | Command | Condition | Cite |
|---|---|---|---|---|
| `app_public.users` | `select_all` | select | `true` | `0120-users.sql:28,37-38` |
|  | `update_self` | update | `id = current_user_id()` | `0120-users.sql:40` |
| `app_public.user_emails` | `select_own` | select | `user_id = current_user_id()` | `0130-user_emails.sql:22,80-81` |
|  | `insert_own` | insert | check `user_id = current_user_id()` | `0130-user_emails.sql:82-83` |
|  | `delete_own` | delete | `user_id = current_user_id()` | `0130-user_emails.sql:85-86` |
| `app_public.user_authentications` | `select_own` | select | `user_id = current_user_id()` | `0140-user_authentications.sql:26,38-39` |
|  | `delete_own` | delete | `user_id = current_user_id()` | `0140-user_authentications.sql:40-41` |
| `app_public.organizations` | `select_member` | select | `id in current_user_member_organization_ids()` | `0500-organizations.sql:40,194-195` |
|  | `select_invited` | select | `id in current_user_invited_organization_ids()` | `0500-organizations.sql:197-198` |
|  | `update_owner` | update | a membership row exists for the current user with `is_owner` | `0500-organizations.sql:206-212` |
| `app_public.organization_memberships` | `select_member` | select | `organization_id in member ids` | `0500-organizations.sql:63,200-201` |
|  | `select_invited` | select | `organization_id in invited ids` | `0500-organizations.sql:203-204` |
| `app_public.organization_invitations` | `select_own` | select | org in member ids, or `user_id = current_user_id()` | `0500-organizations.sql:88,214-218` |
| `app_public.posts` | `select public or own or if admin` | select | `privacy = 'public'`, or own, or the current user is admin | `1000-posts.sql:18-31` |
|  | `insert own` | insert | check `user_id = current_user_id()` | `1000-posts.sql:33-34` |
|  | `update own` | update | `user_id = current_user_id()` | `1000-posts.sql:36-37` |
|  | `delete own or if admin` | delete | own, or the current user is admin | `1000-posts.sql:39-48` |
| `app_public.comments` | `select_all` | select | `true` | `1010-comments.sql:15-17` |
|  | `insert_own` | insert | check `user_id = current_user_id()` | `1010-comments.sql:18-19` |
|  | `update_own` | update | `user_id = current_user_id()` | `1010-comments.sql:20-21` |
|  | `delete_own` | delete | `user_id = current_user_id()` | `1010-comments.sql:22-23` |
|  | `delete_comments_as_admin` | delete | the current user is admin | `1010-comments.sql:25-28` |
| `app_public.stars_on_posts` | `select_all` | select | `true` | `1020-stars.sql:8,13-14` |
|  | `insert_own` | insert | check `user_id = current_user_id()` | `1020-stars.sql:15-16` |
|  | `delete_own` | delete | `user_id = current_user_id()` | `1020-stars.sql:17-18` |
| `app_public.stars_on_comments` | `select_comment_stars` | select | `true` | `1020-stars.sql:63,68-69` |
|  | `insert_own_comment_star` | insert | check `user_id = current_user_id()` | `1020-stars.sql:70-71` |
|  | `delete_own_comment_star` | delete | `user_id = current_user_id()` | `1020-stars.sql:72-73` |

These `app_private` tables have RLS on and no policies:

- `cookie_sessions` (`0110-sessions.sql:14-15`)
- `sessions` (`0110-sessions.sql:53`)
- `user_secrets` (`0120-users.sql:74`)
- `user_email_secrets` (`0130-user_emails.sql:163`)
- `user_authentication_secrets` (`0140-user_authentications.sql:71`)
- `realtime_events` (`0150-realtime_events.sql:15`)

These tables have no RLS:

- `app_private.password_hashing_dummy` (`0140-user_authentications.sql:117-123`)
- `app_private.unregistered_email_password_resets` (`0140-user_authentications.sql:251-255`)

### Grants to the visitor role (`:DATABASE_VISITOR`)

- Schema `usage` on `public`, `app_public` and `app_hidden`; no grant on
  `app_private` (`0020-schemas.sql:16`).
- Default privileges in `public`, `app_public` and `app_hidden`:
  - `usage, select` on sequences (`0020-schemas.sql:20-21`)
  - `execute` on functions (`0020-schemas.sql:24-25`)

  This makes every `app_public` function executable by the visitor, not only
  the ones with explicit grants.
- Default privileges revoke all on sequences and functions from `public`
  (`0010-public_permissions.sql:15-16`). `revoke all on schema public from
  public` is at `0010-public_permissions.sql:13`.

| Table | Grant | Cite |
|---|---|---|
| `app_public.users` | `select`, `update(username, name, avatar_url, bio)` | `0120-users.sql:42-47` |
| `app_public.user_emails` | `select`, `insert(email)`, `delete` | `0130-user_emails.sql:88-91` |
| `app_public.user_authentications` | `select`, `delete` | `0140-user_authentications.sql:59-60` |
| `app_public.organizations` | `select`, `update(name, slug)` | `0500-organizations.sql:42-43` |
| `app_public.organization_memberships` | `select` | `0500-organizations.sql:67` |
| `app_public.organization_invitations` | `select` (all columns, `code` included) | `0500-organizations.sql:92` |
| `app_public.posts` | `select`, `insert(body, privacy)`, `update(body, privacy)`, `delete` | `1000-posts.sql:50-55` |
| `app_public.comments` | `select`, `insert(body, post_id, parent_id)`, `update(body)`, `delete` | `1010-comments.sql:30-35` |
| `app_public.stars_on_posts` | `select`, `insert(post_id)`, `delete` | `1020-stars.sql:19-23` |
| `app_public.stars_on_comments` | `select`, `insert(comment_id)`, `delete` | `1020-stars.sql:75-79` |

Explicit `execute` grants:

- `change_password(text, text)` (`0140-user_authentications.sql:583`)
- `stars_on_posts`, `posts_user_starred`, `star_post` and `unstar_post`
  (`1020-stars.sql:30,37,45,53`)
- `stars_on_comments`, `comments_user_starred`, `star_comment` and
  `unstar_comment` (`1020-stars.sql:86,98,105,113`)

### Roles and how they are created

- **Owner:** `effect_test_owner`, a group role (`.gmrc:12-13`;
  `DATABASE_OWNER=<db>_owner` at `scripts/generateEnvFile.mjs:93`). The
  cartridge `migration` login is a member, and the API root pool and the
  worker connect as it (`cartridge.json:46-50,85-89`).
- **Authenticator:** `alchemy_<db>_api` (`scripts/generateEnvFile.mjs:94`).
  It is the cartridge `api` login → `AUTH_DATABASE_URL`
  (`cartridge.json:52-56`).
- **Visitor:** `<db>_visitor` (`scripts/generateEnvFile.mjs:95`). The
  migrations refer to it through the placeholder `:DATABASE_VISITOR`
  (`.gmrc:48`), and requests switch to it with `set_config('role', ...)`
  (`server/requestDatabase.ts:39-46`).
- **How roles are created:** nothing in the repo runs `CREATE ROLE`. The
  external `ops dev db` tool creates the database, roles and extensions from
  `cartridge.json` (`scripts/dbSetup.mjs:1-4`, commit `1c0dd25`).
  `migrations/afterReset.sql:1-7` only grants `CONNECT` to the owner and the
  authenticator, grants `ALL` on the database to the owner, and gives the
  owner the `public` schema. No file in the repo grants visitor membership to
  the authenticator.
