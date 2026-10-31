# Effect workarounds, as evidence for Quill

Each line names a place where Effect or TypeScript forced one of the
workarounds in `~/build/quill/doc/design.md#acceptance-test`.

- `~/build/effect-web-template/server/requestDatabase.ts:13-16`: string-keyed
  Context. The visitor handle service is registered under the string
  `'CurrentDb'`.
