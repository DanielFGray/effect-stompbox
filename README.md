# effect-backend (working name)

A production-ready Effect v4 backend framework, extracted from the patterns
standardized in `~/build/effect-web-template`: owner and visitor pools on
Postgres with row-level security, typed visitor handles, sessions and cookies,
password and OAuth auth, rate limits, a realtime outbox, a worker mailer, an
in-process test harness, and telemetry.

The existing apps (dfg.codes, dfg.rocks, postgres.garden, knowledgebase,
setlist, twitter-bookmarks, budget) are evidence and possible future
consumers. None of them is migrated until the design is settled.

## Status

Design phase. Auth, migrations and the worker require Postgres
(`docs/adr/0001-postgres-only-auth.md`); the database host contract is
proposed in `docs/adr/0002-database-host-contract.md`. Terms are in
`GLOSSARY.md`. Code goes into the framework only where at least three apps
already do the same thing. See `docs/matrix/` for the comparison of concerns
across apps.
