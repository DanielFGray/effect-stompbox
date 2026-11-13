# Effect workarounds, as evidence for Quill

Each line names a place where Effect or TypeScript forced one of the
workarounds in `~/build/quill/doc/design.md#acceptance-test`.

- `~/build/effect-web-template/server/requestDatabase.ts:13-16`: string-keyed
  Context. The visitor handle service is registered under the string
  `'CurrentDb'`.
- `src/testing/TestApp.ts:89`: E erased at the boundary.
  `HttpRouter.asHttpEffect` types its errors as `unknown`, so the caller
  catches everything and sorts it at run time (respondable or defect). The
  typed form, `HttpRouter.toHttpEffect`, keeps per-request requirements as a
  generic `Exclude` that TypeScript cannot reduce to `never`.
