# HTTP failure handling: design

Status: API decided by the user on 2026-11-13; council review next. No code
exists yet. Shared under ADR 0008: setlist, postgres.garden and the template
carry this code today, differing only in import paths and per-app data.

## What it is

What a client receives when a request fails, decided in one place:

- A request that fails its schema answers 400 `InvalidOperation`
  (`invalid_input`) with an `issues` list.
- A database refusal answers through the app's answer table.
- Anything unexpected is logged once with the trace id and answers 500
  `InternalError { message, traceId }`, never the defect's text.

## Subpaths

Subpath exports of `@danielfgray/stompbox` (ADR 0009):

| Import                                | Holds                                                | Bundle            |
| ------------------------------------- | ---------------------------------------------------- | ----------------- |
| `@danielfgray/stompbox/http`          | generic error classes, the `FailureBoundary` tag     | client and server |
| `@danielfgray/stompbox/http/server`   | `FailureBoundaryLive`, `DatabaseAnswers.make`        | server            |
| `@danielfgray/stompbox/http/client`   | `errorMessage`                                       | client            |
| `@danielfgray/stompbox/visitor`       | `DatabaseError`, `PostgresReport`, `onSqlState`      | server            |
| `@danielfgray/stompbox/worker`        | `effectTask`, `promiseTask`, the `Worker.job` span   | worker            |

`http/server` imports `visitor` for `DatabaseError`. `http` and `http/client`
import nothing server-side, so a client bundle stays free of them.

## Error classes

The package owns one class per status, with only the reasons its own code
raises:

- `InternalError` 500 `{ message, traceId }`
- `InvalidOperation` 400, reason `invalid_input`, with `issues`
- `Unauthorized` 401, `Forbidden` 403 (`access_denied`), `NotFound` 404
- `Conflict` 409, reason `already_exists` | `related_data`
- `ServiceUnavailable` 503, reason `busy` | `timed_out` | `misconfigured`

An app-specific refusal is the app's own tagged class with its status
(`SlugTaken` 409, `AlreadyMember` 409). The client tells errors apart by
`_tag`.

## The answer table

The app's `dbErrors.ts` holds only its data:

```ts
export const toHttpError = DatabaseAnswers.make({
  codes: {
    DNIED: (message) => new Forbidden({ message, reason: "access_denied" }),
    ISMBR: (message) => new AlreadyMember({ message }),
  },
  constraints: {
    bands_slug_key: new SlugTaken({ message: "That slug is already in use." }),
  },
})
```

- A listed custom code answers with the SQL's own message. Only these codes
  pass Postgres text on.
- The package answers standard codes a client can cause with fixed text:
  23505 (by constraint, else `already_exists`), 23503, 42501, 23502, 23514,
  class 22, 40001, 40P01, 57014.
- Anything else dies, and `FailureBoundaryLive` answers 500.
- An expected refusal logs at Info (custom) or Warning (standard), once.

## Service-level codes

`visitorDb` and `ownerDb` fail with `DatabaseError`, its report decoded
once. A service maps the codes it reacts to with `onSqlState`; every other
`DatabaseError` reaches the handler's table:

```ts
onSqlState({
  DNIED: () => new BandRefused({ message: "You must be the band owner to invite" }),
})
```

`onSqlState` replaces `mapSqlState`, which died on unlisted codes at the
service.

## Open

- Tracing: shared package, or template wiring under ADR 0008.
- `errorMessage` and app classes: how the client helper reads an app tag.
