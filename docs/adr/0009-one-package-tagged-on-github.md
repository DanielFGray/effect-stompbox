---
status: accepted
---

# Stompbox ships as one package, tagged on GitHub

- The package is `@danielfgray/stompbox`, from
  github.com/DanielFGray/effect-stompbox. Apps depend on
  `"@danielfgray/stompbox": "github:DanielFGray/effect-stompbox#v0.2.0"`, so
  imports keep their names if it moves to npm later.
- Each concern is a subpath export: `/visitor`, `/http`, `/http/server`,
  `/http/client`, `/worker`, `/auth`, `/checker`, `/delivery`, `/testing`.
  The build emits one JS file per source file with `.d.ts`, and the package
  declares `"sideEffects": false`, so a bundler takes only the modules an app
  imports.
- `effect` is a peer dependency, so an app has one copy of Effect. A library
  that only one subpath uses (kysely, graphile-worker, `@effect/sql-pg`) is an
  optional peer dependency.
- A release is a commit that holds the built `dist/`, tagged `v<semver>`, as
  alphatab-kit does: production Docker installs run with `--ignore-scripts`,
  so the package cannot build itself on install.

Why one package: a git dependency installs the repository root (tested with
bun 1.4.4), so a workspace of packages would need a split tree per package.
Decided by the user on 2026-11-13.

## Considered options

- **A split tree tagged per package**: more release tooling, and an app
  upgrade edits several tags.
- **npm**: later, under the same name.

## Consequences

- One version for every subpath; an upgrade edits one tag per app.
- ADR 0005's "an app can drop any package and keep the others" becomes "an
  app imports only the subpaths it uses".
