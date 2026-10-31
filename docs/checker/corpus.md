# Checker corpus: known RLS-app security bugs

This file lists six known bugs in four apps. For each bug it gives an exact
app commit where the bug is in the schema, the SQL objects, and the catalog
state that a checker connected to the built database would see. A second part
tells how to build each app's schema into a scratch database without `ops`.

Research was read-only. No migration was run and no database was made. All
claims come from reading files at the named commits.

Terms:

- **Owner role**: the group role that owns the schema objects (for example
  `giglist_owner`). Migrations run as this role.
- **Visitor role**: the group role that end-user requests run as. The API
  login is `NOINHERIT` and switches to it per transaction with
  `set_config('role', <visitor>, true)`.
- **API login**: the login role that the server uses (`alchemy_<db>_api`).
- **committed / current**: graphile-migrate keeps released migrations in
  `migrations/committed/` and the unreleased one in `migrations/current/`.
  `graphile-migrate migrate` applies committed only. `graphile-migrate watch
  --once` applies committed, then current. Production applies committed only.
- **Default privileges**: `alter default privileges ... grant execute on
  functions to <visitor>` adds the grant to each function that the same role
  creates later. A `drop function` then `create function` gets the default
  ACL (access-control list) again. A `create or replace` with the same
  signature keeps the old ACL.
- **C:**, **K:**: short forms for a committed or current file, defined per app.

Commits at the time of writing (HEAD of each repo):

| App                 | HEAD      | Date       |
| ------------------- | --------- | ---------- |
| setlist             | `5775660` | 2026-10-29 |
| dfg.rocks           | `5d9f334` | 2026-10-31 |
| effect-web-template | `db51b82` | 2026-10-31 |
| dfg.codes           | `9ce49aa` | 2026-10-31 |

## Part 1: bugs

### Bug 1. setlist: reset_password accepts a reset token of any age (prog ts-363e8d)

- **Commit**: present at HEAD `5775660` (2026-10-29), in both committed and
  current. Also present at `0991cfb` (2026-10-22), the commit that made
  release 1. Not fixed.
- **Objects**:
  - `app_private.reset_password(user_id uuid, reset_token text, new_password text) returns app_private.sessions`.
    - Committed: `migrations/committed/000001-release-1.sql:1032-1105`.
    - Current (replaces the body, same bug): `migrations/current/2-null-safe-auth.sql:75-149`.
  - Column `app_private.user_secrets.reset_password_token_generated timestamptz`
    (`000001-release-1.sql:417`).
- **Catalog state** (either build mode):
  - `prosrc` of `reset_password` contains `reset_password_token_generated`
    only as the assignment `reset_password_token_generated = null` in the
    success UPDATE (C:1083, K:127). It contains `now()` and
    `v_token_max_duration` only in the failed-attempt lockout window
    (C:1055, C:1067-1068; K:98, K:111-112). No predicate compares the token's
    generation time with `now()`. A check that only asks "is the column
    referenced" would pass this function.
  - Reference (fixed) body for contrast: effect-web-template
    `migrations/current/0140-user_authentications.sql:390-394` compares
    `reset_password_token_generated <= now() - app_private.reset_password_token_lifetime()`.
  - `prosecdef = false`, `proisstrict = true`, schema `app_private`.
    `has_function_privilege(visitor, oid, 'EXECUTE')` is false: the default
    grants cover only `public, app_public, app_hidden` (C:59-64) and C:33
    revokes function EXECUTE from PUBLIC; the visitor has no USAGE on
    `app_private` (C:55). The function is reached only through the owner
    pool (`src/server/httpapi/auth.ts:62-68`). So a check that looks only at
    visitor-executable functions will not see it.
  - Only `app_public.forgot_password` rotates a token older than 3 days
    (C:977-990).

### Bug 2. setlist: login, reset_password and change_password accept any input when the stored secret is NULL (prog ts-96d324)

- **Commit**: buggy SQL is in committed at every commit since `0991cfb`.
  The fix `dd69022` (2026-10-27) is in current only
  (`migrations/current/2-null-safe-auth.sql`). Last buggy commit before the
  fix: `e911343` (2026-10-26).
- **One checkout gives both cases.** `migrations/committed/` is identical at
  `e911343` and HEAD (`git diff --stat e911343 HEAD -- migrations/committed`
  is empty), and HEAD's `migrations/current/1-current.sql` does not redefine
  these three functions. So at HEAD `5775660`:
  - committed only (`graphile-migrate migrate`, the production path): bug present.
  - committed + current (`watch --once`): fixed bodies.
- **Objects** (committed `000001-release-1.sql`):
  - `app_private.login(username citext, password text) returns app_private.sessions`, C:804-870.
    Bug line C:851: `if v_user_secret.password_hash != crypt(password, v_user_secret.password_hash) then`.
    C:850 has a comment that says NULL is "fine".
  - `app_private.reset_password(user_id uuid, reset_token text, new_password text)`, C:1032-1105.
    Bug line C:1063: `if v_user_secret.reset_password_token != reset_token then`.
  - `app_public.change_password(old_password text, new_password text) returns boolean`, C:1206-1250.
    Bug line C:1223: `if v_user_secret.password_hash != crypt(old_password, ...) then`.
- **Why it is a bug**: `NULL != x` is NULL, so the `if` is not taken and the
  function goes on as if the secret matched. A user with no reset token can
  have the password reset with any token; a user with no password hash (for
  example OAuth-only) can log in with any password.
- **Catalog state** (committed-only build):
  - `prosrc` of each function has a `!=` comparison against the stored secret
    with no `is null` / `is distinct from` guard. The fixed bodies add
    `password_hash is null or ...` (K:53) and `reset_password_token is null or ...` (K:106).
  - `login`, `reset_password`: `prosecdef = false`, schema `app_private`,
    not visitor-executable (same reasons as Bug 1). Reached via the owner pool.
  - `change_password`: `prosecdef = true`, `proconfig = {search_path=pg_catalog, public, pg_temp}`
    (C:1250), and `has_function_privilege(visitor, oid, 'EXECUTE')` is true
    (explicit grant C:1255, and default privileges C:63-64).

### Bug 3. dfg.rocks: functions revoked from the visitor become executable again after drop + create in current (prog ts-26969b)

The prog note is partly wrong. Restated from the code:

- **Commit**: present at HEAD `5d9f334` (2026-10-31). The bug is in
  `migrations/current/1-current.sql` only. It shows only in a
  committed + current build; a committed-only build is the negative case.
  - `484da40` (2026-10-31 09:44) first dropped and recreated
    `monthly_billing_eligible`, `get_effective_discount` and
    `get_effective_tax_rate` in current (same line numbers as HEAD).
  - `1cf8c4b` (2026-10-31 09:58) added the signature changes of the two
    single-booking functions.
  - Not fixed.
- **Mechanism**: committed `000001-initial-schema.sql:63-64` sets default
  privileges `grant execute on functions to :DATABASE_VISITOR` in
  `public, app_public, app_hidden`. Committed then revokes some functions.
  Current drops and recreates them, so they get the default grant again.
- **Real regressions** (revoked in committed, executable again after current):

  | Function                                                                           | Revoked     | Recreated | Attributes at recreate                                                       |
  | ---------------------------------------------------------------------------------- | ----------- | --------- | ---------------------------------------------------------------------------- |
  | `app_public.monthly_billing_eligible(p_billing_month date) returns table(...)`     | C:5498-5499 | K:409-435 | `language sql stable security definer set search_path to pg_catalog` (K:435) |
  | `app_public.get_effective_discount(p_payer_id uuid, p_on_date date) returns jsonb` | C:5504-5505 | K:367-382 | `language sql stable security definer set search_path to pg_catalog` (K:382) |
  | `app_public.get_effective_tax_rate(p_payer_id uuid, p_on_date date) returns jsonb` | C:5507-5508 | K:384-407 | `language sql stable security definer set search_path to pg_catalog` (K:407) |

  C = `migrations/committed/000001-initial-schema.sql`, K = `migrations/current/1-current.sql`.
  The last two are not in the prog note. The committed comment at C:5494-5496
  says these helpers are "never directly" called by visitors.

- **Not a revoke regression**: `create_single_booking_obligation(uuid, integer)`
  and `settle_single_booking_cancellation(uuid, integer, boolean)` had
  explicit visitor grants in committed (C:5964, C:6031). Current drops them
  and creates new signatures `create_single_booking_obligation(p_lesson_id uuid)`
  (K:730-801) and `settle_single_booking_cancellation(p_lesson_id uuid, p_captured_deposit_cents integer default 0)`
  (K:803-853), both SECURITY DEFINER with `search_path to pg_catalog`. The
  new signatures are visitor-executable through default privileges. The
  visitor could execute the old ones too, so whether this is a bug depends on
  intent, not on the catalog.
- **Negative controls in the same file**: `create_monthly_bill_line_items(uuid, uuid, date, date)`
  (K:437) and `issue_monthly_bills(date)` (K:603) use `create or replace`
  with the committed signature. Their ACL stays as committed left it
  (revoked at C:5115, C:5106). The checker must not flag them.
- **Catalog state** (committed + current build):
  - `has_function_privilege(visitor, 'app_public.monthly_billing_eligible(date)', 'EXECUTE')`
    is true; same for the two `get_effective_*` functions. In a committed-only
    build all three are false.
  - `proacl` of each contains `<visitor>=X/<owner>`. `pg_default_acl` has a
    row for the owner role in `app_public` with EXECUTE to the visitor.
  - `prosecdef = true`; `proconfig = {search_path=pg_catalog}`.
  - Catalog alone cannot tell "revoked on purpose, then lost" from "always
    granted". To find this bug the checker needs either an allowlist of
    visitor-executable functions, or a diff between a committed-only build and
    a committed + current build.

### Bug 4. dfg.rocks: reset_password accepts a reset token of any age (prog ts-67aa3a)

- **Commit**: present at HEAD `5d9f334` (2026-10-31), in committed. Not
  fixed. Current does not redefine it.
- **Object**: `app_private.reset_password(user_id uuid, reset_token text, new_password text) returns app_private.sessions`,
  `migrations/committed/000001-initial-schema.sql:1005-1079`
  (`language plpgsql strict volatile`, not SECURITY DEFINER).
  Column `reset_password_token_generated timestamptz` at C:377.
- **Catalog state**: same pattern as Bug 1. `prosrc` names
  `reset_password_token_generated` only in `reset_password_token_generated = null`
  (C:1057). `v_token_max_duration` and `now()` appear only in the lockout
  window (C:1028, C:1041-1042). No predicate compares generation time with
  `now()`. This body already has the NULL guard (C:1036-1037,
  `reset_password_token is null or ... is distinct from reset_token`), so it
  is a negative case for Bug 2's pattern. Not visitor-executable (schema
  `app_private`); reached via the owner pool.

### Bug 5. effect-web-template: SECURITY DEFINER star functions set no search_path (prog ts-cf1913)

- **Commit**: present at HEAD `db51b82` (2026-10-31). All SQL is in
  `migrations/current/`; `migrations/committed/` is empty. First present at
  `706c2f7` (2025-08-12); last change to the file `bea3a85` (2026-09-15).
  Not fixed.
- **Objects** (`migrations/current/1020-stars.sql`): six functions, not four.
  The prog note's "two more" are the two `*_user_starred` functions.

  | Function                                                                  | Lines   | Attributes                               |
  | ------------------------------------------------------------------------- | ------- | ---------------------------------------- |
  | `app_public.posts_user_starred(p app_public.posts) returns boolean`       | 32-37   | `language sql stable security definer`   |
  | `app_public.star_post(id bigint) returns bigint`                          | 39-45   | `language sql volatile security definer` |
  | `app_public.unstar_post(id bigint) returns bigint`                        | 47-53   | `language sql volatile security definer` |
  | `app_public.comments_user_starred(c app_public.comments) returns boolean` | 88-98   | `language sql stable security definer`   |
  | `app_public.star_comment(id bigint) returns bigint`                       | 100-105 | `language sql volatile security definer` |
  | `app_public.unstar_comment(id bigint) returns bigint`                     | 107-113 | `language sql volatile security definer` |

- **Catalog state**: `prosecdef = true` and `proconfig IS NULL` for all six.
  `has_function_privilege(visitor, oid, 'EXECUTE')` is true (explicit grants
  on the line after each definition). Owner is whatever role ran the
  migration (should be `effect_test_owner`). The bodies reference
  `app_public.*` qualified names; the risk is name resolution of unqualified
  operators and functions (for example `count`, `=`) through a
  caller-controlled `search_path`.
- **Negative control**: every other SECURITY DEFINER function in
  `migrations/current/` sets `search_path` (for example
  `0130-user_emails.sql:134-135`).
- **Side note, not a security-rule bug**: `unstar_comment` line 111 filters
  `where comment_id = t.comment_id`. Inside the function `comment_id` binds to
  the table column, so the count is of all rows, not of one comment.

### Bug 6. dfg.codes: top_posts() runs as the caller and reads hidden.likes, but the visitor has no grant on schema hidden (prog ts-e460fd)

- **Commit**: present at HEAD `9ce49aa` and at `55748ea` (both 2026-10-31),
  in committed. Not fixed.
- **Objects** (`migrations/committed/000001-discussion-schema.sql`):
  - `public.top_posts() returns json`, lines 252-322,
    `language sql stable`, no `security definer`, so SECURITY INVOKER.
    Reads `hidden.likes` at line 269.
  - Table `hidden.likes`, line 213. Schema `hidden`, line 7.
  - `grant execute on function public.top_posts() to :DATABASE_VISITOR` (line 331).
  - Only schema grant on `hidden`: `grant usage on schema hidden to :DATABASE_AUTHENTICATOR`
    (`000002-authenticator-grants.sql:12`). The API login is `NOINHERIT`, and
    after `set_config('role', visitor, true)` (`server/db.ts:95`) only the
    visitor's privileges apply.
  - Called under `withAuthContext` at `server/services/discussion-live.ts:258-264`.
- **Catalog state**:
  - `prosecdef = false`, `prolang = sql`, `provolatile = 's'`.
  - `has_function_privilege(visitor, 'public.top_posts()', 'EXECUTE')` is true.
    The file revokes nothing from PUBLIC, so PUBLIC also has EXECUTE.
  - `has_schema_privilege(visitor, 'hidden', 'USAGE')` is false;
    `has_table_privilege(visitor, 'hidden.likes', 'SELECT')` is false.
  - The link from `top_posts` to `hidden.likes` is only in `prosrc`. A
    `language sql` function with a string body records no `pg_depend` rows
    for the tables it reads (only a `begin atomic` body does), so the checker
    must parse `prosrc` to find it.
- **Negative control**: `public.get_likes(text)` (lines 220-233) and
  `public.like_post(text, integer)` (235-250) also read `hidden.likes`, but are
  SECURITY DEFINER with `search_path = hidden, public, pg_catalog`.

## Part 2: building each schema into a scratch database

### What `ops dev db` does (the reference to copy)

From `~/build/server-ansible/tools/alchemy` at `1f8d855`. For a cartridge
database `<db>`:

1. Group roles `<db>_owner` and `<db>_visitor`, both `NOLOGIN`
   (`src/PostgresDatabase.ts:63-66`, `src/PostgresProvisioning.ts:115-145`).
2. `CREATE DATABASE <db> OWNER <db>_owner` (`src/PostgresProvisioning.ts:224`).
3. `CREATE EXTENSION IF NOT EXISTS` for each cartridge extension, as
   superuser (`src/PostgresProvisioning.ts:251-290`).
4. Login `alchemy_<db>_api`: `LOGIN NOINHERIT`, member of `<db>_visitor`
   (`src/devdb/Declaration.ts:127-133`, `src/Cartridge.ts:201-202`).
5. Login `alchemy_<db>_migration`: `LOGIN`, `CREATEDB`, member of
   `<db>_owner`, with `ALTER ROLE ... SET role = <db>_owner`, so its sessions
   run as the owner (`src/devdb/Declaration.ts:134-140`,
   `src/PostgresProvisioning.ts:61-71`).
6. `GRANT CONNECT` on the database to each login (`src/PostgresProvisioning.ts:435`).

Shadow and test databases (`<db>_shadow`, `<db>_test`) reuse the same roles.
The dev cluster is Postgres 17, container `ops-dev-pg17`, port 5417, with the
image that the platform cartridge pins (`src/devdb/Cluster.ts:20-23,43-55`).

### Rules that apply to every app

- **Run migrations as the owner role.** graphile-migrate does not `SET ROLE`;
  it only applies `pgSettings` with `set_config` (`node_modules/graphile-migrate/dist/pgReal.js:81-94`).
  `alter default privileges` without `for role` binds to the role that runs
  it, and the owner of each SECURITY DEFINER function is part of what the
  checker reads. Connect as a superuser or member login with
  `PGOPTIONS='-c role=<owner>'` (the same startup-option form that `ops` uses
  for `-c role=none`).
- **Copy `.gmrc` `pgSettings.search_path`** into `PGOPTIONS` too
  (`-c search_path=...`). `language sql` bodies are checked at create time
  under the session `search_path`.
- **Do not run graphile-migrate inside the app repo.** `afterCurrent` (and in
  dfg.codes `afterAllMigrations`) runs `db:types`, which writes generated
  files into the repo. Export the commit first:
  `git -C ~/build/<app> archive <sha> migrations .gmrc | tar -x -C <scratch>`,
  or `git worktree add`. Then use psql (recommended) or graphile-migrate from
  the scratch directory with the hooks removed.
- **`graphile-migrate reset`/`migrate`/`watch` never create extensions or
  roles.** Make them first as superuser. `migrate` and `watch --once` need
  only `DATABASE_URL` plus one env var per `!ENV` placeholder; no shadow URL
  (`dist/settings.js:65-109,142-150`, `dist/commands/watch.js:164-165`).
  `afterReset` actions run only on `reset`, so run `afterReset.sql` by hand.
- **Placeholders.** graphile-migrate replaces `:DATABASE_NAME` (from the URL),
  `:DATABASE_OWNER` (from `.gmrc` `databaseOwner`, else the URL user) and each
  `!ENV` placeholder as plain text everywhere (`dist/migration.js:20-25`).
  psql `-v NAME=value` replaces `:NAME` only outside quotes and `$$` bodies.
  I checked all four apps: every placeholder used is declared, and the only
  placeholder inside a quoted or `$$` context is dfg.rocks
  `migrations/afterReset.sql:14`.
- **Role names are cluster-wide.** On the shared `ops-dev-pg17` cluster the
  roles above already exist and belong to the dev databases. No migration in
  the four apps hard-codes a role name, so with psql you can use unique names
  (for example `corpus_giglist_owner`) or a separate throwaway cluster.
- **psql order**: `afterReset.sql`, then each `committed/*.sql` in name order,
  then (for a committed + current build) each `current/*.sql` in name order,
  each with `-v ON_ERROR_STOP=1 -1`. setlist's own `tests/db/run.sh:19-28`
  does exactly this. graphile-migrate runs all of `current/` as one
  transaction; per-file transactions give the same final catalog.
- **What differs from a `reset` build**: `graphile-migrate reset` revokes
  CONNECT from PUBLIC on the database (per the comment at dfg.rocks
  `migrations/afterReset.sql:7`); a hand-made database keeps PUBLIC CONNECT
  unless you revoke it. The `graphile_migrate` bookkeeping schema exists only
  when graphile-migrate ran.

### setlist (`~/build/setlist`)

- Corpus commit: `5775660`. Bug 1 in both modes; Bug 2 in committed-only.
- Cartridge database name `giglist` (`cartridge.json:4`).
- Roles: owner `giglist_owner` (NOLOGIN group), visitor `giglist_visitor`
  (NOLOGIN group), API login `alchemy_giglist_api` (LOGIN NOINHERIT, member
  of the visitor). Sources: `.gmrc:2-3`, `scripts/generateEnvFile.ts:35-40`,
  `tests/db/run.sh:16-18`.
- Extensions (superuser, before migrations): `citext`, `pgcrypto`,
  `uuid-ossp` (`cartridge.json:4`).
- `.gmrc`: `databaseOwner: giglist_owner`, `search_path =
  app_public,app_private,app_hidden,public`, placeholders
  `:DATABASE_AUTHENTICATOR`, `:DATABASE_VISITOR` from env (`.gmrc:3,6,10-11`).
- `afterReset.sql` (`migrations/afterReset.sql:1-7`): grants connect to owner
  and authenticator, all to owner, makes owner own schema `public`. Needs
  `DATABASE_NAME`, `DATABASE_OWNER`, `DATABASE_AUTHENTICATOR`.
- graphile-migrate 2.0.0-rc.2. Env for it: `DATABASE_URL` (as the owner),
  `DATABASE_AUTHENTICATOR`, `DATABASE_VISITOR`. Commands:
  `graphile-migrate migrate` (committed only) or `graphile-migrate watch --once`.
- graphile-worker schema: not needed to build. `graphile_worker.add_job` is
  called only inside plpgsql bodies (`perform`), which Postgres does not
  resolve at create time. Install it (`graphile-worker` 0.18.0,
  `--schema-only`) only if the checker calls those functions.
- At the older commit `e911343`, `afterReset.sql` also created the
  extensions; not needed, since the committed SQL is the same at HEAD.

### dfg.rocks (`~/build/dfg.rocks`)

- Corpus commit: `5d9f334`. Bug 3 needs committed + current; Bug 4 shows in
  either mode. Tracked files are clean; the working tree has untracked files,
  so build from `git archive`.
- Cartridge database name `dfg_rocks` (`cartridge.json`, `postgres[0]`).
- Roles: owner `dfg_rocks_owner` (`.gmrc:3`), visitor `dfg_rocks_visitor`,
  API login `alchemy_dfg_rocks_api` (NOINHERIT, member of the visitor). The
  repo has no authenticator placeholder; `afterReset.sql:9-18` grants CONNECT
  to every member of the visitor role, so create the API login and its
  membership before running `afterReset.sql`.
- Extensions: `citext`, `pgcrypto`, `uuid-ossp` (cartridge).
- `.gmrc`: `search_path = app_public,app_private,public`; placeholder
  `:DATABASE_VISITOR` from env (`.gmrc:5,8`).
- **graphile-worker schema is required before committed `000001`.** Top-level
  statements use it: `select graphile_worker.add_job(...)` at
  `000001-initial-schema.sql:2367` and `delete from graphile_worker._private_jobs ... using graphile_worker._private_tasks`
  at :3038-3039. Version 0.16.6 (`node_modules/graphile-worker`). Command
  used by the repo: `DATABASE_URL=<url> bun --cwd=worker graphile-worker --schema-only`
  (`.gmrc:15`, `package.json:16`). Run it as the owner (add
  `?options=-c%20role%3Ddfg_rocks_owner` to the URL) so the owner owns the
  schema. Running it from the repo's `worker/` reads the repo but writes nothing.
- `afterReset.sql:14` has `':DATABASE_VISITOR'::regrole` inside a `do $$`
  body. psql will not substitute it. Substitute with `sed
  "s/:DATABASE_VISITOR/dfg_rocks_visitor/g; s/:DATABASE_OWNER/dfg_rocks_owner/g; s/:DATABASE_NAME/<db>/g"`
  before running, or run it through graphile-migrate.
- graphile-migrate 2.0.0-rc.2. Env: `DATABASE_URL`, `DATABASE_VISITOR`.
  `afterCurrent` runs `bun db:types` (`.gmrc:18-20`); remove it in the
  scratch copy.

### effect-web-template (`~/build/effect-web-template`)

- Corpus commit: `db51b82`. Everything is in `current/`, so only a
  committed + current build (`watch --once`, or psql over `current/*.sql`)
  has any schema. `current/0001-reset.sql` drops the app schemas first.
- Cartridge database name `effect_test` (`cartridge.json`, `postgres[0]`).
- Roles: owner `effect_test_owner` (`.gmrc:13`), visitor
  `effect_test_visitor`, authenticator `alchemy_effect_test_api`
  (`scripts/generateEnvFile.mjs:93-95`). The cartridge has no
  environment mapping for `DATABASE_VISITOR` or `DATABASE_AUTHENTICATOR`.
- Extensions (`cartridge.json` `postgres[0].extensions`): `uuid-ossp`,
  `citext`, `btree_gin`, `pgcrypto`, `pg_trgm`, `fuzzystrmatch`, `pgsodium`.
- **pgsodium is required at build time.** `app_private.hash_password`
  (`current/0140-user_authentications.sql:88-93`) is `language sql` and calls
  `pgsodium.crypto_pwhash_str`, so Postgres checks it at create time. A stock
  `postgres:17` image does not ship pgsodium; use the platform-pinned image
  that `ops` uses. I could not confirm whether that image preloads pgsodium
  (`shared_preload_libraries`) or whether `crypto_pwhash_str` needs it.
- `.gmrc`: `search_path = app_public,app_private,app_hidden,public`;
  placeholders `:DATABASE_AUTHENTICATOR`, `:DATABASE_VISITOR` (`.gmrc:26,47-48`).
  `afterReset.sql:1-7` matches setlist's.
- graphile-migrate 1.4.1. Env: `DATABASE_URL`, `DATABASE_AUTHENTICATOR`,
  `DATABASE_VISITOR`. `afterCurrent` runs `bun run db:types` (`.gmrc:91-98`);
  remove it in the scratch copy. graphile-worker schema is not needed to
  build (only plpgsql `perform` calls).

### dfg.codes (`~/build/dfg.codes`)

- Corpus commit: `9ce49aa`. Bug 6 is in committed; `current/1-current.sql`
  is empty.
- This app does not use `ops` for local dev. It uses docker compose
  (`postgres:17`, port 5433) and `scripts/dbSetup.ts`, which creates roles
  and databases from env (`scripts/dbSetup.ts:60-94`):
  - owner `$DATABASE_OWNER` with LOGIN; dev default is the database name
    itself (`scripts/generateEnvFile.ts:37`);
  - authenticator `$DATABASE_AUTHENTICATOR` LOGIN NOINHERIT, default
    `<db>_authenticator` (`:39`), granted the visitor;
  - visitor `$DATABASE_VISITOR`, default `<db>_visitor` (`:41`), NOLOGIN;
  - `<db>_shadow` superuser login for the shadow database.
- Production names differ: owner `dfg_codes_owner`, visitor
  `dfg_codes_visitor`, authenticator `alchemy_dfg_codes_api`
  (`cartridge.json` environment). For the corpus, the ops-style names fit the
  checker's model best; the migrations accept any names.
- Extensions: `afterReset.sql:3-5` creates `plpgsql`, `citext`, `pgcrypto`
  itself (`citext` and `pgcrypto` are trusted, so the database owner can
  create them). It also grants all and connect, and sets the database owner
  (`:7-9`).
- `.gmrc` has no `databaseOwner`, so `:DATABASE_OWNER` is the user in
  `DATABASE_URL`. Connect as the owner login itself (not a member with
  `-c role=`), or `:DATABASE_OWNER` will be the wrong name. With psql, pass
  `-v DATABASE_OWNER=<owner>`. `000001` uses `alter default privileges for
  role :DATABASE_OWNER` (lines 12-25), so the role running it must be the
  owner or a member.
- `.gmrc`: `search_path = public,auth,hidden`; placeholders
  `:DATABASE_AUTHENTICATOR`, `:DATABASE_VISITOR` (`.gmrc:3,6-7`).
- graphile-migrate 1.4.1. Env: `DATABASE_URL`, `DATABASE_AUTHENTICATOR`,
  `DATABASE_VISITOR`. Both `afterAllMigrations` and `afterCurrent` run
  `bun db:types` (`.gmrc:12-25`), so even `migrate` writes into the repo;
  use psql or a scratch copy with the hooks removed.
- No graphile-worker.

## Open questions

1. Answered: the cluster image ships pgsodium 3.1.9 and does not preload
   it; the effect-web-template build succeeds without the preload.
2. Bug 3: is the visitor meant to execute the new
   `create_single_booking_obligation(uuid)` and
   `settle_single_booking_cancellation(uuid, integer)`? The old signatures
   had explicit grants, so the catalog alone cannot decide.
3. Bug 3 needs a baseline (allowlist or committed-only diff). Which one does
   the checker use?
4. Bugs 1, 2 and 4 live in `app_private` functions that the visitor cannot
   execute; the API calls them on the owner pool. Is "functions the API calls
   as owner" in the checker's scope, and where does it get that list?
5. dfg.codes production maps `DATABASE_URL` to the **api** login
   (`cartridge.json` secrets), so a production migrate would run as the API
   login, not the owner. Intended?
6. effect-web-template's cartridge does not map `DATABASE_VISITOR` or
   `DATABASE_AUTHENTICATOR`, which its `.gmrc` requires as `!ENV`. A
   production migrate would fail at settings parse.
7. Answered: the shared `ops-dev-pg17` cluster. `cartridge.json` in this
   repo declares one database per corpus build, named `effect_backend_<build>`,
   so `ops dev db up` gives each its own roles and extensions, and
   `scripts/corpus-build.sh` builds them. A `_base` build has committed
   migrations only.
