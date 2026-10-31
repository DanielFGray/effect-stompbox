# effect-backend - Agent Guidelines

## Runtime & Commands

- **Runtime**: Bun (`bun`, `bun run`, `bunx`).
- **Install**: `bun install` (runs `prepare`, which patches tsc and oxlint for Effect diagnostics).
- **Typecheck**: `bun run typecheck` (`tsc --noEmit`, Effect diagnostics via `@effect/tsgo`)
- **Lint**: `bun run lint` (`oxlint --type-aware`)
- **Format**: `bun run fmt` / `bun run fmt:check` (`oxfmt`)
- **Prepare / re-patch**: `bun run prepare` (`effect-tsgo patch --typescript --oxlint`)

`@effect/tsgo`, `typescript`, `oxlint` and `oxlint-tsgolint` are pinned to the
versions in the "Supported Package Versions" table of
`node_modules/@effect/tsgo/README.md`. Upgrade them together.

# Learning more about Effect

This repository uses the Effect Typescript library.

Before writing any Effect code, first read `node_modules/effect/AGENTS.md`
**completely**, and follow the links in the file when required.

If you need to learn more about particular Effect apis and concepts that the
guide doesn't cover, search through the source code in `node_modules/effect/src`.

# Evidence for Quill

When Effect or TypeScript forces one of the workarounds listed in
`~/build/quill/doc/design.md#acceptance-test`, add one line to
`docs/quill-evidence.md`: the file and line, and which workaround.
