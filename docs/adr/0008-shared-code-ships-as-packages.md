---
status: accepted
supersedes: the template half of 0005
---

# Shared code ships as packages when three apps carry it

ADR 0005 packaged only what Postgres buys. The failure boundary, database
error answers, tracing and the worker's job adapters stayed in the template,
owned by each app. In November 2026 they were ported by hand into setlist,
postgres.garden and dfg.rocks. The copies differed only in import paths and
per-app data (custom SQLSTATE codes, constraint names), and a review found a
port that had missed six endpoints. Decided by the user on 2026-11-13.

- Code with logic that three apps share ships in a versioned package,
  whatever it depends on. The app passes its own data in (for example its
  custom codes).
- Wiring stays in the template and the app: layer composition, routes,
  config.
- 0005's rule stands: no package only renames Effect.
