# Security checker: design

Status: revised after a council review (two members, one round, recorded on
the prog task for the checker). No code exists yet.

## What it is

A command and a library that connect to the Postgres database of an app that
uses row-level security (RLS), and report each place where the database
breaks a security rule. It works on any app that has an owner role and a
visitor role (ADR 0002), with or without the other packages. It is step 1 of
the plan in `README.md`.

The checker has two kinds of check:

- **Catalog checks** only read the system catalogs. They change nothing, so
  they can run against any database, production included.
- **Behaviour probes** call functions with prepared rows and look at the
  result. They write data, so they run only against a disposable database,
  on one admin connection, inside a transaction that is rolled back.

Each finding has a level:

- **error**: a security defect. The exit code is non-zero.
- **warning**: a defect that breaks a function but exposes no data, such as a
  function that fails with "permission denied".
- **review**: a state that is correct in some apps and wrong in others, such
  as a table with RLS and no policies, which denies every row.

## Why the database answers, not a model of it

Every privilege question goes to Postgres itself: `has_table_privilege`,
`has_function_privilege`, `has_schema_privilege`, `has_database_privilege` and
`pg_has_role`, called with the role's name. Postgres applies role membership,
`PUBLIC` grants and inheritance the same way it does when a request runs.
pg-sourcerer's `pg-introspection` package can resolve ACLs offline
(`packages/pg-introspection/src/acl.ts`), but a second implementation of the
ACL rules is a second place to be wrong. The checker uses it only if a later
check needs data the catalog functions do not give.

## Inputs

| Input                | Source                                              | Example                        |
| -------------------- | --------------------------------------------------- | ------------------------------ |
| Connection           | `DATABASE_URL`, any role that can read `pg_catalog` | the migration login            |
| Visitor role         | `DATABASE_VISITOR`                                  | `giglist_visitor`              |
| Owner role           | the owner of the app's schemas                      | `giglist_owner`                |
| API login            | the user of `AUTH_DATABASE_URL`                     | `alchemy_giglist_api`          |
| Visitor surface file | committed in the app repo                           | `security/visitor-surface.txt` |
| Probe targets        | committed in the app repo, typed                    | `security/probes.json`         |
| Admin connection     | `ROOT_DATABASE_URL`, probes only                    | written by `ops dev db`        |

The platform runs PostgreSQL 17 (`server-ansible/nixos/cynic/postgres-image.nix:4`).
The checker supports 16 and later, because C1 depends on per-grant
inheritance, which 16 introduced.

### The visitor surface file

The file lists everything the visitor may reach: each table or view with its
privileges, and each function it may execute, with its full signature.
Objects that belong to an extension (`pg_depend.deptype = 'e'`) are left out;
each extension appears as one line with its schema and version, so an
extension upgrade does not fill the diff with function signatures.

The file is a record of what a reviewer approved, so it must be written from a
state that is known to be good, never from the change under review. If it
were written from the change, a regression would be approved with it. Two
uses follow:

- **Diff mode (the default in CI).** Build the base branch's migrations and
  the change's migrations into two scratch databases, and report every
  difference in the visitor's reach between them. This catches a regression
  even when someone ran `--write-surface` on the bad state and committed it.
- **File mode.** Compare one database with the committed file. This serves
  production and local runs. `--write-surface` writes the file.

## Catalog checks

Splinter is Supabase's database linter (`github.com/supabase/splinter`); its
lint numbers are given where a check matches one.

| Id  | Level         | Rule                                                                                                                                                                                                                                                                                                                                                              | How                                                                                                                                                                                                                                                                                                                                               | Motivated by                                                                                     |
| --- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| C1  | error         | The API login can switch to the visitor role but does not inherit its rights; it cannot reach the owner role; it owns no object and holds no direct privilege on any app object; it is not a superuser and has no `BYPASSRLS`.                                                                                                                                    | `pg_has_role(api, visitor, 'SET')` true and `'USAGE'` false; `pg_has_role(api, owner, 'MEMBER')` false; owner columns of the catalogs; `has_*_privilege(api, …)` with the visitor's grants excluded; `pg_roles`. From PostgreSQL 16 inheritance is set per grant, so `rolinherit` alone is not the answer. `pg_has_role` follows chains of roles. | ADR 0002                                                                                         |
| C2  | error         | The visitor role cannot log in, is not a superuser, has no `BYPASSRLS`, owns no object, and is a member of no role other than `PUBLIC`.                                                                                                                                                                                                                           | `pg_roles`; owner columns of `pg_class`, `pg_proc`, `pg_namespace`, `pg_type`; `pg_has_role(visitor, r, 'MEMBER')` for every role `r`                                                                                                                                                                                                             | ADR 0002                                                                                         |
| C3  | error         | The visitor's reach has not grown beyond the approved state.                                                                                                                                                                                                                                                                                                      | diff mode or file mode (above), over `has_*_privilege(visitor, …)` for every table, view, sequence and function outside `pg_catalog`, `information_schema` and extensions                                                                                                                                                                         | dfg.rocks billing functions executable again after drop and create                               |
| C4  | error         | No default privilege grants `EXECUTE` on new functions to `PUBLIC`. A default grant to the visitor is the convention for the visitor's schemas; C3 shows each new function it reaches.                                                                                                                                                                            | `pg_default_acl`, and the built-in default that grants `EXECUTE` to `PUBLIC` when no entry revokes it                                                                                                                                                                                                                                             | dfg.codes, which never revokes it                                                                |
| C5  | error         | Every table on which the visitor holds `SELECT`, `INSERT`, `UPDATE` or `DELETE` has RLS enabled. The visitor holds no `TRUNCATE`, `REFERENCES` or `TRIGGER` on any table, because RLS does not limit them.                                                                                                                                                        | `pg_class.relrowsecurity`; `has_table_privilege` per privilege                                                                                                                                                                                                                                                                                    | template rule; splinter 0013 checks the `public` schema only                                     |
| C6  | error, review | A table with policies but RLS disabled is an error (splinter 0007). A table the visitor can reach, with RLS but no policy that applies to the visitor, is a review finding: the visitor sees no rows. A table the visitor cannot reach may deny every row on purpose and is not reported; the apps keep their private tables that way.                            | `pg_policy`, `relrowsecurity`                                                                                                                                                                                                                                                                                                                     | splinter                                                                                         |
| C7  | error         | Every `SECURITY DEFINER` function sets `search_path`; no schema on that path is writable by `PUBLIC` or the visitor; and either `pg_temp` is listed last, or the visitor has no `TEMP` privilege on the database. Without an explicit `pg_temp`, Postgres searches it first for tables, so a temporary table can replace a table the body names without a schema. | `pg_proc.prosecdef`, `proconfig`; `has_schema_privilege(…, 'CREATE')`; `has_database_privilege(visitor, db, 'TEMP')`                                                                                                                                                                                                                              | template star functions; dfg.rocks billing functions (`search_path = pg_catalog`); splinter 0011 |
| C8  | error         | Every view the visitor can read runs as the caller (`security_invoker`), or is listed as deliberate in the surface file. A view otherwise reads its tables as its owner, without RLS.                                                                                                                                                                             | `pg_class.reloptions`                                                                                                                                                                                                                                                                                                                             | splinter 0010                                                                                    |
| C9  | warning       | A `SECURITY INVOKER` function the visitor can execute reads only tables the visitor can read.                                                                                                                                                                                                                                                                     | see below                                                                                                                                                                                                                                                                                                                                         | dfg.codes `top_posts()`                                                                          |

### C9 in detail

C9 finds functions that fail. It does not find exposure: a function that runs
as the caller and reads a table the caller cannot read stops with "permission
denied". So C9 is a warning, and it is bounded:

- **Which tables a body reads.** For a body written with `BEGIN ATOMIC`,
  Postgres records the dependencies in `pg_depend`, and C9 reads them. For a
  plain `language sql` body, which is what the apps write
  (`docs/checker/corpus.md`, bug 6), C9 parses `prosrc` with `libpg-query`, the
  Postgres parser compiled for JavaScript.
- **How names resolve.** A schema-qualified name resolves directly. An
  unqualified name resolves through the function's own `search_path` when
  `proconfig` sets one. Otherwise it resolves through the caller's path, which
  the checker cannot know, so C9 reports the name as not analysed instead of
  guessing.
- **Out of scope, reported as not analysed:** PL/pgSQL bodies, dynamic SQL,
  names that resolve to a common table expression, temporary tables, column
  grants, and calls to other functions.

## Behaviour probes

These check what a function does, which the catalog cannot show.

**Connection.** Each probe runs on the admin connection, in one transaction
that is rolled back. Inside it, `SET LOCAL ROLE` switches to the owner role to
prepare rows, then to the role the app calls the function with. A second
connection could not see rows that are not committed. Each expected SQL error
runs inside a savepoint, because an error otherwise aborts the transaction.

**Targets.** The probe targets file names, for each probe: the function, its
argument order, the role that calls it (the owner role for functions the API
calls on the owner pool, such as `app_private.reset_password`; the visitor
role with `my.session_id` set for functions the visitor calls, such as
`app_public.change_password`), the columns that hold the secret, the token and
its creation time, the lifetime, and the expected failure. The auth package
(step 3) will own this file for the starter SQL functions. Until then it is
written per app from the corpus, which shows up to four versions of each
function (`docs/matrix/sql-drift.md`).

**Controls.** Each probe first runs a control that must succeed: a correct
password logs in, a fresh token resets the password. Only then does it run the
case that must fail. A probe whose control fails, or whose target is not in the
targets file, reports **not covered**. Not covered is never a pass.

| Id  | Rule                                                               | Control                          | Case that must fail                                    | Motivated by                       |
| --- | ------------------------------------------------------------------ | -------------------------------- | ------------------------------------------------------ | ---------------------------------- |
| P1  | `current_user_id()` returns the user only for a valid session.     | a valid session returns its user | expired, revoked and unknown sessions return null      | ADR 0004; security rule 7          |
| P2  | A secret check rejects every input when the stored secret is NULL. | the right secret succeeds        | with the stored hash set to NULL, any input fails      | setlist NULL-secret bug            |
| P3  | An emailed token stops working after its lifetime.                 | a fresh token succeeds           | a token whose creation time is past the lifetime fails | setlist and dfg.rocks reset tokens |

P1 is generic, because ADR 0004 fixes the session bridge for every auth
implementation. P2 and P3 depend on the targets file.

## Output

One finding per violation: level, check id, object (schema-qualified name and
signature), what is wrong, and the rule it breaks. Then the list of objects
and probes that were not analysed or not covered. Text by default, JSON with
`--json`. The exit code is non-zero when any error remains.

An app can accept a finding by naming it in the visitor surface file with a
reason. The checker prints accepted findings in a separate list, so they stay
visible.

## Where it runs

- In the app's tests, after migrations, against the test database: all
  catalog checks in file mode, and all probes.
- In CI before a deploy: all catalog checks in diff mode, between the base
  branch and the change.
- Against production, read-only: catalog checks in file mode only.
- At API startup: C1 and C2 only, as ADR 0002 requires. That code belongs to
  the visitor transaction library (step 2) and calls the same check functions.

## Implementation outline

An Effect program on `SqlClient` from `@effect/sql-pg`, with the CLI from
`effect/cli`. Each check is an Effect that returns its findings, so the
library, the CLI and the startup check share one set of functions. It runs on
Bun and on Node. This choice is local to the checker and does not decide open
decision 2 (query execution in apps).

Build order: the catalog checks C1 to C8 and the surface file first, then the
probes with their targets file, then C9.

## How we know it works

The corpus (`docs/checker/corpus.md`) lists each known bug with the app commit
where it exists. For each entry:

1. Build that commit's schema into a scratch database.
2. For C3, write the surface file from the last good state (for the dfg.rocks
   billing bug: the build from `migrations/committed` only), or run diff mode
   between that state and the buggy one. Never write it from the buggy state.
3. Run the checker.
4. Pass: the check named for that bug reports it at its level. The corpus's
   negative controls (functions recreated with `create or replace` and an
   unchanged signature) produce no finding.

Then run the checker against each app's current schema. Pass: every finding is
a real defect or an accepted one; no false positives remain unexplained. A
check that flags many correct objects is wrong, not strict.

## Open questions

- Is the visitor surface file one file per app, or one per schema?
- Who builds the scratch databases for an app that adopts the checker: the
  checker, or the app's migration command? The corpus builds its own with
  `scripts/corpus-build.sh` on the shared dev cluster.
