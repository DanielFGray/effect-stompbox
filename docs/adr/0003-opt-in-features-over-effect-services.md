---
status: proposed
---

# Features are opt-in layers; adapters are Effect layers

The project is an Effect backend with Postgres as the default database. An
app chooses the features it wants, and it can replace the part of a feature
that talks to the outside world. The project uses Effect's own mechanism for
this and adds no plugin system:

- A **service** is a `Context.Service` tag: the interface a feature needs.
- An **adapter** is a `Layer` that implements a service.
- A **feature** is a `Layer` (plus, where it has them, an `HttpApi` group and a
  SQL module) whose requirements name the services it needs.
- The **template** wires the default adapter for every service with plain
  `Layer` composition. No package exports a stack layer (ADR 0005).

Effect already uses this shape. `RateLimiter.layer` requires a
`RateLimiterStore`, and `layerStoreMemory` and `layerStoreRedis` are two
adapters for it (`effect/src/persistence/RateLimiter.ts:231`, `:991`, `:1460`).
Because layer requirements are types, an app that adds a feature without an
adapter for one of its services fails to compile. That makes the dependency
between features visible without a configuration file.

## Which adapters ship

The project ships one adapter per service: the default that the template
uses.
It ships a second adapter only when an existing app already uses it, or when
Effect already provides it. It does not write adapters for hosts or vendors
that no app uses.

| Service                                       | Default adapter               | Other adapters an app already uses         |
| --------------------------------------------- | ----------------------------- | ------------------------------------------ |
| HTTP server host (`HttpServer`, Effect)       | Bun                           | Node (Effect provides both)                |
| Database client                               | `pg` pools, owner and visitor | none                                       |
| Rate limit store (`RateLimiterStore`, Effect) | memory                        | Redis/Valkey (setlist; Effect provides it) |
| Mail transport                                | SMTP (nodemailer)             | none                                       |
| OAuth provider                                | GitHub (`arctic`)             | Google, Apple (dfg.rocks)                  |
| Telemetry exporter                            | OTLP (Effect)                 | none                                       |

The query execution path (open decision 2 in `docs/matrix/README.md`) decides
the database client row.

## Limits

A feature whose logic is SQL inside Postgres (password auth, sessions,
row-level security, the outbox, the worker queue) has no adapter for its
storage. The database is the service. Those features require Postgres
(`docs/adr/0001-postgres-only-auth.md`).

Opt-in features with SQL make schema delivery harder: each feature brings its
own SQL, features depend on each other (password auth needs the users and
sessions tables), and an app may add a feature after its database already has
data. The schema delivery design must install and upgrade the SQL of each
feature on its own, in dependency order.
