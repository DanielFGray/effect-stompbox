# Security checker: design

Status: draft for council review. No code exists yet.

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
  inside a transaction that is rolled back.

## Why the database answers, not a model of it

Every privilege question goes to Postgres itself: `has_table_privilege`,
`has_function_privilege`, `has_schema_privilege` and `pg_has_role`, called with
the visitor role's name. Postgres applies role membership, `PUBLIC` grants and
`NOINHERIT` the same way it does when a request runs. pg-sourcerer's
`pg-introspection` package can resolve ACLs offline (`packages/pg-introspection/src/acl.ts`),
but a second implementation of the ACL rules is a second place to be wrong.
The checker uses it only if a later check needs data the catalog functions do
not give.

## Inputs

| Input                | Source                                              | Example                        |
| -------------------- | --------------------------------------------------- | ------------------------------ |
| Connection           | `DATABASE_URL`, any role that can read `pg_catalog` | the migration login            |
| Visitor role         | `DATABASE_VISITOR`                                  | `giglist_visitor`              |
| API login            | the user of `AUTH_DATABASE_URL`                     | `alchemy_giglist_api`          |
| Visitor surface file | committed in the app repo                           | `security/visitor-surface.txt` |

The visitor surface file lists everything the visitor may reach: each table
or view with its privileges, and each function it may execute, with its full
signature. The checker compares the database with the file.
`--write-surface` writes the file from the database. A reviewer then sees each
change to the visitor's reach as a diff in the pull request, as with a
lockfile. This replaces a hand-written allowlist, which nobody would keep up
to date.

## Catalog checks

Each check has an id, the query idea, and the bug or prior art that motivates
it. Splinter is Supabase's database linter (`github.com/supabase/splinter`);
its lint numbers are given where a check matches one.

| Id  | Rule                                                                                                                     | How                                                                                                                       | Motivated by                                                               |
| --- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| C1  | The API login does not inherit, is a member of the visitor role, and is not a superuser and has no `BYPASSRLS`.          | `pg_roles`, `pg_auth_members`                                                                                             | ADR 0002                                                                   |
| C2  | The visitor role is not a superuser, has no `BYPASSRLS`, cannot log in, and owns no object.                              | `pg_roles`, owner columns of `pg_class`, `pg_proc`, `pg_namespace`, `pg_type`                                             | ADR 0002                                                                   |
| C3  | The visitor's reach equals the visitor surface file.                                                                     | `has_*_privilege(visitor, …)` over every table, view, sequence and function outside `pg_catalog` and `information_schema` | dfg.rocks billing functions executable again after drop and create         |
| C4  | No default privilege grants `EXECUTE` on new functions to `PUBLIC` or to the visitor.                                    | `pg_default_acl`, and the built-in default that grants `EXECUTE` to `PUBLIC` when no entry revokes it                     | the cause of the dfg.rocks bug                                             |
| C5  | Every table the visitor has any privilege on has RLS enabled.                                                            | `pg_class.relrowsecurity`                                                                                                 | template rule; splinter 0013 checks the `public` schema only               |
| C6  | Every table with RLS enabled has at least one policy, and every table with policies has RLS enabled.                     | `pg_policy`, `relrowsecurity`                                                                                             | splinter 0007, 0008                                                        |
| C7  | Every `SECURITY DEFINER` function sets `search_path`, and no schema on that path is writable by `PUBLIC` or the visitor. | `pg_proc.prosecdef`, `proconfig`, `has_schema_privilege(…, 'CREATE')`                                                     | template star functions; splinter 0011                                     |
| C8  | Every view the visitor can read runs as the caller (`security_invoker`), or is listed as deliberate in the surface file. | `pg_class.reloptions`                                                                                                     | a view owned by the owner role reads its tables without RLS; splinter 0010 |
| C9  | A `SECURITY INVOKER` function the visitor can execute reads only tables the visitor can read.                            | for `LANGUAGE sql` bodies: the relations the Postgres parser finds in `prosrc`; PL/pgSQL is out of scope                  | dfg.codes `top_posts()`                                                    |

C9 needs a SQL parser. Two ways are open: `libpg-query` (the Postgres parser
compiled for JavaScript), or the dependencies Postgres records for SQL
functions written with `BEGIN ATOMIC` (`pg_depend`). The second needs no
parser but covers only that style. The design picks one after the corpus shows
which style the apps use.

## Behaviour probes

These check what a function does, which the catalog cannot show. Each probe
runs in a transaction that is rolled back.

| Id  | Rule                                                                                                       | How                                                                                                        | Motivated by                       |
| --- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| P1  | `current_user_id()` returns null for an expired, revoked or unknown session, and the user for a valid one. | insert sessions as the owner, then as the API login set the role and `my.session_id` and call the function | ADR 0004; security rule 7          |
| P2  | A secret check rejects every input when the stored secret is NULL.                                         | create a user whose stored hash is NULL, call the auth function with any input                             | setlist NULL-secret bug            |
| P3  | An emailed token stops working after its expiry.                                                           | create a token, move its creation time past the limit, call the function                                   | setlist and dfg.rocks reset tokens |

P1 is generic, because ADR 0004 fixes the session bridge for every auth
implementation. P2 and P3 depend on the auth functions' names and arguments,
so they belong to the auth implementation. The checker runs them for the
starter SQL contract (`reset_password`, `login`, `change_password`), which
three apps share; the auth package (step 3) will own them.

## Output

One finding per violation: check id, object (schema-qualified name and
signature), what is wrong, and the rule it breaks. Text by default, JSON with
`--json`. The exit code is non-zero when any finding remains.

An app can accept a finding by naming it in the visitor surface file with a
reason. The checker prints accepted findings in a separate list, so they stay
visible.

## Where it runs

- In the app's tests, after migrations, against the test database: all
  catalog checks and all probes.
- In CI before a deploy, against a database built from the migrations that
  will deploy.
- Against production, read-only: catalog checks only.
- At API startup: C1 and C2 only, as ADR 0002 requires. That code belongs to
  the visitor transaction library (step 2) and calls the same check functions.

## Implementation outline

An Effect program on `SqlClient` from `@effect/sql-pg`, with the CLI from
`effect/cli`. Each check is an Effect that returns its findings, so the
library, the CLI and the startup check share one set of functions. It runs on
Bun and on Node. This choice is local to the checker and does not decide open
decision 2 (query execution in apps).

## How we know it works

The corpus (`docs/checker/corpus.md`) lists each known bug with the app commit
where it exists. For each entry:

1. Build that commit's schema into a scratch database.
2. Run the checker.
3. Pass: the check named for that bug reports it.

Then run the checker against each app's current schema. Pass: every finding is
a real defect or an accepted one; no false positives remain unexplained. A
check that flags many correct objects is wrong, not strict.

## Open questions

- C9: parser or `BEGIN ATOMIC` dependencies (decided from the corpus).
- Is the visitor surface file one file per app, or one per schema?
- Does the checker build the scratch databases itself, or rely on each app's
  migration command? The corpus records what each app needs.
