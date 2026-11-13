---
status: accepted
---

# Features are delivered as versioned SQL in package-owned schemas

The package's SQL comes in features. A feature is a directory of numbered
migration files. The runner (`@danielfgray/stompbox/delivery`) installs and
upgrades every feature an app uses, the app's own migrations included, in
one transaction, as the owner role. It records each migration with a SHA-256
hash of its text, and refuses to run when a migration that already ran has
changed. The package owns the `auth`, `auth_private` and `stompbox`
schemas. The SQL API that app code and app SQL call (functions, tables and
columns in `auth`) only grows: a release adds to it and never changes what an
existing name means. The full design and its tests are in
`docs/delivery/design.md`.

Each of these is hard to undo once apps depend on it:

- **Package-owned schemas.** Apps write SQL against `auth.*`. Moving the
  objects later breaks every app's policies and functions.
- **An SQL API that only grows.** An app migration released against version 1
  must still run, unchanged, on a fresh install of version 3. A rename or a
  changed meaning breaks that app's history, which cannot be edited.
- **One transaction and a hash per migration.** The record table and its
  meaning are the runner's own contract with every database it has touched.

## Considered options

- **Copy the SQL into each app** (today's practice). Rejected: four apps hold
  diverging copies of the same auth functions, and a fix reaches none of the
  others.
- **Effect's `Migrator`.** Rejected: it keeps one history table per
  migration set, stores no hash, and takes its lock only after it creates the
  table, so two runners can both create it.
- **Objects in the app's `app_public` and `app_private` schemas.** Rejected:
  the package could not tell its objects from the app's, so it could not own
  their grants or check them after an upgrade.

## Consequences

- An app that adopts the package moves its session bridge objects to
  `auth.*` (ADR 0004).
- A package release that needs a different shape adds a new name and keeps
  the old one working. Removing the old one is a decision for a major
  version, with its own migration path for apps.
- Migration files are limited to a subset of SQL that runs in one
  transaction, because `@effect/sql-pg` sends one statement at a time.
- The server refuses to start when a feature in the database is behind the
  code, and starts when it is ahead, so old code keeps running during a
  deploy.
