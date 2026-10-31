# Schema delivery: design

Status: draft, before council review. Step 3 of the plan in `README.md`. The
auth package's SQL comes after this design and uses it.

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

## Decisions

### 1. The app is a feature too

The runner knows one concept: a feature. The app's own migrations are the
last feature, named `app`, and it depends on every package feature it uses.
One runner, one order, one record of versions. There is no second migration
tool for the app.

### 2. Order: features in dependency order, each to its latest version

Feature dependencies form a graph without cycles; the runner refuses a cycle.
The runner sorts the features so that each comes after the features it
depends on, then brings each feature to its latest migration before the next
feature starts.

This order is always valid. A feature's migration can only need objects of
the features it depends on, and those are complete before it starts. A
feature never needs objects of a feature that depends on it, because that
would be a cycle. Django needs a graph of single migrations because its apps
may depend on each other both ways; features here may not.

### 3. One transaction for the whole upgrade

All pending migrations of all features run in one transaction, on the
migration login (ADR 0002). If one fails, the database stays at its old
versions. Postgres DDL is transactional, so this covers tables, functions,
policies and grants. A migration that cannot run in a transaction
(`CREATE INDEX CONCURRENTLY`) is not allowed in a feature.

### 4. Effect's `Migrator`, one table per feature

`effect/sql/Migrator` records migrations in a table, locks it, runs the
pending ones (id greater than the last recorded id) and records them in the
same transaction. Each feature gets its own table,
`effect_backend.migrations_<feature>`, so its last id is its feature version.
The runner calls `Migrator` once per feature, in the order of decision 2,
inside the transaction of decision 3; the nested transactions become
savepoints.

### 5. Migrations are `.sql` files, split by the runner

Migrations are SQL files, so that SQL tools can read them (the
postgres-language-server migration linter, `plpgsql_check`).

`@effect/sql-pg` sends every statement through the extended query protocol,
which takes one statement at a time. The runner therefore splits each file
into statements before it runs them. The splitter is a small lexer that knows
Postgres quoting: `'…'` and `E'…'` strings, `"…"` identifiers, `$tag$…$tag$`
bodies, and `--` and nested `/* */` comments. Its test corpus is every
migration file of the surveyed Postgres apps: each file, split and run in
order, must give the same `pg_dump --schema-only` as `psql -f` of the same
file.

### 6. The package owns its schemas

Package features put their objects in schemas that only the package writes,
as Supabase's auth server owns the `auth` schema. The app never creates
objects there, and the package never creates objects in the app's schemas
(`app_public`, `app_private`). This makes two checks possible: every object
in a package schema comes from a feature migration, and an upgrade touches
nothing of the app's.

Proposed schemas: `auth` for objects the visitor may reach (tables under RLS,
the functions the visitor may call) and `auth_private` for the rest. The
records of decision 4 live in `effect_backend`, which the visitor cannot
reach.

### 7. The public SQL API does not change shape

The app's policies and functions call package functions, for example
`auth.current_user_id()`. A package function that the app may call is part
of the public SQL API, and the package documents the list.

- A public function keeps its name, arguments and return type forever.
  `CREATE OR REPLACE FUNCTION` cannot change a return type, and
  `DROP FUNCTION … CASCADE` would silently drop the app's policies that call
  it. A new shape gets a new name; the old function stays.
- A feature migration never uses `DROP … CASCADE`. A test greps for it.
- Tables in `auth` that the app may read are public in the same way: a column
  may be added, not removed or retyped.

### 8. Every migration states its grants

Default privileges grant rights on new functions, and recreating a function
creates a new one. So every migration that creates or replaces a function
also revokes `EXECUTE` from `PUBLIC` and grants it to the roles that need it,
in the same file. The security checker's C3 and C4 run after an upgrade, not
only after a fresh install.

### 9. Role names come from the role contract

SQL cannot take a role name as a bound parameter. A migration writes the
placeholders `:DATABASE_VISITOR`, `:DATABASE_OWNER` and
`:DATABASE_AUTHENTICATOR`, and the runner replaces them with quoted
identifiers from the role contract, which derives the names from
`current_database()` as the checker does. graphile-migrate uses the same
placeholder form, so the apps' existing SQL keeps working.

### 10. The server refuses to start below the version it needs

Each feature's code knows the last migration it ships. The visitor startup
check (`packages/visitor`) also reads the feature versions and fails with
`StartupCheckFailed` when a database is behind. "The code needs schema
version N" becomes a check, which closes the release gap.

The API login holds no direct privilege on any object (check C1), so it
cannot read `effect_backend` itself. A function
`effect_backend.feature_versions()`, `SECURITY DEFINER`, executable by the
visitor, returns the versions; the startup check calls it inside a visitor
transaction. The version numbers are not secret.

## Not in this step

- A development loop like graphile-migrate's `current.sql`, re-run on every
  save. Apps write numbered migrations at first; the loop can follow.
- Down migrations. An upgrade either commits or leaves the old versions.
- Moving any app onto the runner.
- The auth features themselves. They follow this design.

## How we know it works

Tests run against `effect_backend_dev_delivery`, a database separate from
the visitor tests, with the same role contract. Each test uses fixture
features with three versions each, because the auth features do not exist
yet.

1. **Upgrade equals fresh install** (the README check). Install v1 of the
   fixtures, upgrade to v3, and take `pg_dump --schema-only`. Recreate the
   database under the same name (the role names depend on it), install v3
   fresh, dump again. The two dumps are equal.
2. A failing migration in the second of three features leaves all three at
   their old versions.
3. The runner refuses a dependency cycle and a missing dependency, before it
   runs anything.
4. Two runners started together: one runs, the other waits or fails as
   `Locked`, and the versions are correct after both.
5. The startup check refuses a database one migration behind the code, and
   accepts it after the upgrade.
6. After an upgrade that recreates a function, C3 and C4 pass: the visitor's
   reach has not grown.
7. The splitter: the corpus test of decision 5.
