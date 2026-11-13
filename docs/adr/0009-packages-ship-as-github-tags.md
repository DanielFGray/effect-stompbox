---
status: accepted
---

# Packages ship as tags on GitHub

- A release is a tag `<package>-v<semver>` on
  github.com/DanielFGray/effect-backend. Its tree holds only that package,
  built to JS with `.d.ts`. Apps depend on
  `github:DanielFGray/effect-backend#visitor-v0.2.0`.
- `effect` and `@effect/*` are peer dependencies, so an app has one copy of
  Effect.

Docker builds already install alphatab-kit this way. A git dependency on the
monorepo installs its root, not the package (tested with bun 1.4.4).
Decided by the user on 2026-11-13.

## Considered options

- **npm**: semver ranges, but public and permanent names.
- **A self-hosted registry**: Docker builds would need network access and
  credentials to it.

## Consequences

- An upgrade edits the tag in each app. A fleet check lists apps behind the
  newest tag.
