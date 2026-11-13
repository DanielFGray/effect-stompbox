# Schema delivery: design

Status: accepted after council review (round 1 of 1). Decision record:
`docs/adr/0007-features-delivered-as-versioned-sql.md`.
Step 3 of the plan in `README.md`. The auth package's SQL comes after this
design and uses it.

## The problem

Much of auth is SQL: tables, functions, policies and grants. The package must
install that SQL into each app's database and upgrade it later, in an app
that also has its own migrations and data. The survey shows what fails today
(`docs/matrix/README.md`):

- **Drift.** Four apps hold copies of the same 20 auth functions. A fix in one
  copy does not reach the others.
- **Release gap.** Code ships that needs SQL the production database does not
  have. Nothing checks it.
- **Re-grants.** dfg.rocks revoked a function from the visitor, and a later
  migration that recreated the function granted it back through default
  privileges.

Terms used below:

- **Feature**: a unit of SQL that the package delivers, such as `sessions` or
  `password-auth`. A feature has a name, a list of migrations, and the
  features it depends on.
- **Migration**: one numbered SQL file of a feature. Once released, it never
  changes.
- **Feature version**: the number of the last migration of a feature that ran
  in a database.
- **Public SQL API**: the package functions and tables that the app's SQL may
  use. The package documents the list.

## Decisions

### 1. The app is a feature too

The runner knows one concept: a feature. The app's own migrations are the
last feature, named `app`, and it depends on every package feature it uses.
One runner, one order, one record of versions. There is no second migration
tool for the app.

### 2. Order: features in dependency order, each to its latest version

Feature dependencies form a graph without cycles; the runner refuses a cycle
or a missing dependency before it runs anything. The runner sorts the
features so that each comes after the features it depends on, then brings
each feature to its latest migration before the next feature starts.

A feature never needs objects of a feature that depends on it, because that
would be a cycle. So each feature's dependencies are complete before it
starts.

This order has one consequence that the package must accept: on a fresh
install, an app migration written against version 1 of a feature runs after
version 3 of that feature. Rule 7 makes this safe.

### 3. One transaction, one lock, as the owner

All pending migrations of all features run in one transaction. If one fails,
the database stays at its old versions. Postgres DDL is transactional, so
this covers tables, functions, policies and grants.

- The transaction first takes `pg_advisory_xact_lock` on a fixed key, so a
  second runner waits until the first commits, then finds nothing to do.
- The runner connects as the migration login (ADR 0002) and refuses to run
  unless `current_user` is the owner role. Objects then belong to the owner,
  not to a login that may be rotated.

### 4. One record table, with a hash of each migration

`stompbox.migrations` has one row per migration that ran: feature,
number, name, and the SHA-256 of the SQL text after the role names are
filled in. Before it runs anything, the runner compares the recorded hashes
with the files and refuses to run when a released migration has changed.
This makes "a released migration never changes" a check.

Effect's `Migrator` is not used: it records no hash, keeps one table per
history, and takes its lock after creating that table, so two first installs
can collide. What remains of it here (read the last number, run the pending
files, record them) is a few lines.

### 5. Migrations are `.sql` files in a limited SQL subset

Migrations are SQL files, so that SQL tools can read them (the
postgres-language-server migration linter, `plpgsql_check`).

`@effect/sql-pg` sends every statement through the extended query protocol,
which takes one statement at a time; it has no simple-query path
(`PgConnection.ts`). The runner therefore splits each file into statements
with a small lexer that knows Postgres quoting: `'…'` and `E'…'` strings,
`"…"` identifiers, `$tag$…$tag$` bodies, `--` and nested `/* */` comments,
and `::` casts.

The accepted subset is plain SQL statements that can run in a transaction.
The runner refuses, before it runs anything:

- psql meta-commands (`\set`, `\i`) and `COPY … FROM STDIN`;
- transaction control (`BEGIN`, `COMMIT`, `ROLLBACK`, `SAVEPOINT`);
- `CREATE INDEX CONCURRENTLY` and other statements that cannot run in a
  transaction;
- `DROP … CASCADE` (rule 7).

### 6. Role names come from the role contract, outside quoted text

SQL cannot take a role name as a bound parameter. A migration writes the
placeholders `:DATABASE_VISITOR`, `:DATABASE_OWNER` and
`:DATABASE_AUTHENTICATOR`, as graphile-migrate does. The runner replaces each
with the quoted identifier from the same `RoleContract` the visitor startup
check uses: derived from `current_database()`, with the `DATABASE_VISITOR`
override.

The runner replaces placeholders only outside strings, bodies and comments,
and refuses a file that has a placeholder inside one. A function body that
needs a role name gets it from a function, not from the text.

### 7. The package owns its schemas, and its public SQL API only grows

Package features put their objects in schemas that only the package writes,
as Supabase's auth server owns the `auth` schema: `auth` for what the visitor
may reach, `auth_private` for the rest, `stompbox` for the records of
rule 4. The app does not create objects there, with one exception: the app
may put triggers on `auth` tables, with the trigger function in its own
schema (for example, to create a profile row when a user is created).

Every change to the public SQL API is additive:

- A public function keeps its name, arguments, return type and meaning.
  `CREATE OR REPLACE FUNCTION` cannot change a return type, and
  `DROP FUNCTION … CASCADE` would silently drop the app's policies that call
  it. A new shape or meaning gets a new name; the old function stays.
- A public table may get a new column with a default or a null value. It
  keeps its columns, their types and their constraints.

This is what makes rule 2 safe: an app migration that uses only the public
SQL API of version 1 still works on version 3.

### 8. The package controls the grants on its objects

Default privileges grant rights on new functions, and recreating a function
creates a new one. So every migration that creates or replaces a function
also revokes `EXECUTE` from `PUBLIC` and grants it to the roles that need it,
in the same file. The runner also sets the owner's default privileges so that
new functions are not executable by `PUBLIC` (check C4), because a host
provisioner does not always do it.

The package's grants are part of each feature. An app that wants less access
does not revoke package grants, because the next upgrade grants them again;
it leaves the feature out, or wraps the function in one of its own. The
security checker's C3 and C4 run after an upgrade, not only after a fresh
install.

### 9. The server refuses to start behind the code

Each feature's code knows the last migration it ships. The visitor startup
check (`src/visitor`) also reads the feature versions and fails with
`StartupCheckFailed` when the database is behind the code. A database ahead
of the code is accepted, because during a deploy the old code runs against
the migrated database. This closes the release gap.

The API login holds no direct privilege on any object (check C1), so it
cannot read `stompbox`. A function
`stompbox.feature_versions()`, `SECURITY DEFINER` with a fixed
`search_path`, returns the versions; the visitor may execute it, and it is on
the visitor's declared list of functions (check C3). The startup check calls
it inside a visitor transaction. The version numbers are not secret.

## Not in this step

- A development loop like graphile-migrate's `current.sql`, re-run on every
  save. Apps write numbered migrations at first.
- Down migrations. An upgrade either commits or leaves the old versions.
- Moving any app onto the runner, and running the apps' existing SQL through
  the splitter.
- The auth features themselves. They follow this design.

## How we know it works

Tests run against `stompbox_dev_delivery`, a database separate from
the visitor tests, with the same role contract. The tests use fixture
features with three versions each, and a fixture app whose migrations were
written against version 1 and never changed.

1. **Upgrade equals fresh install** (the README check). Install version 1 of
   the fixtures and the fixture app, add rows, upgrade to version 3, and take
   `pg_dump --schema-only`. Drop the fixture schemas and `stompbox`,
   install version 3 fresh in the same database (the role names depend on
   its name), and dump again. The two dumps are equal.
2. A failing migration in the second of three features leaves all three at
   their old versions.
3. The runner refuses, before it runs anything: a dependency cycle, a missing
   dependency, a changed released migration, a connection that is not the
   owner, and each statement kind of rule 5.
4. Two runners started together on an empty database: both finish without
   error, and each migration ran once.
5. The startup check refuses a database one migration behind the code, and
   accepts it after the upgrade and when it is one migration ahead.
6. After an upgrade that replaces a function body, C3 and C4 pass: the
   visitor reaches exactly the approved surface, and no default privilege
   grants new functions to PUBLIC. (`create or replace` keeps a function's
   grants; a function in the public SQL API cannot be dropped, because app
   objects depend on it.)
7. The splitter and the placeholders: the package's own migration files, and
   hand-written cases for `$$` and tagged bodies, `E'\''` strings, `::`
   casts, nested comments, and a placeholder inside a body (refused).
