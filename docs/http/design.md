# HTTP failure handling: design

Status: API decided by the user on 2026-11-13 and revised after the council
review (task "Council review of the http failure-handling design"). No code
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

| Import                              | Holds                                               | Bundle            |
| ----------------------------------- | --------------------------------------------------- | ----------------- |
| `@danielfgray/stompbox/http`        | generic error classes, `boundaryErrors`             | client and server |
| `@danielfgray/stompbox/http/server` | `FailureBoundaryLayer.make`, `DatabaseAnswers.make` | server            |
| `@danielfgray/stompbox/http/client` | `errorMessage`                                      | client            |
| `@danielfgray/stompbox/db`          | Kysely runner `db`, `DatabaseError`, `onSqlState`   | server            |
| `@danielfgray/stompbox/visitor`     | `Visitor.run`, `visitorDb`, `ownerDb` (bound `db`)  | server            |
| `@danielfgray/stompbox/worker`      | `effectTask`, `promiseTask`, the `Worker.job` span  | worker            |

`/db` holds the Kysely runner every app uses, with or without row-level
security: Kysely compiles the query, the ambient `SqlClient` runs it, and a
Schema decodes the rows (ADR 0006). `/visitor` binds it to the visitor's
connection. `DatabaseError` and `PostgresReport` live in a module of `/db`
that imports only `effect`, so `http/server` imports them without the SQL
driver. `http` and `http/client` import nothing server-side.

## Error classes

The package owns one class per status, with only the reasons its own code
raises:

- `InternalError` 500 `{ message, traceId }`
- `InvalidOperation` 400, reason `invalid_input`, with `issues`
- `Unauthorized` 401, `Forbidden` 403 (`access_denied`), `NotFound` 404
- `Conflict` 409, reason `already_exists` | `related_data`
- `ServiceUnavailable` 503, reason `busy` | `timed_out` | `misconfigured`

`boundaryErrors` lists the classes the boundary and the standard answers
raise. An app-specific refusal is the app's own tagged class with its status
(`SlugTaken` 409, `AlreadyMember` 409). The client tells errors apart by
`_tag`.

## The boundary tag

Effect's HttpApi encodes a failure only when an endpoint or a middleware tag
declares its schema, and a middleware tag's list is fixed when its class is
made. So the app owns the tag, in a client-safe module, and lists every
class once:

```ts
export class FailureBoundary extends HttpApiMiddleware.Service<FailureBoundary>()(
	'giglist/FailureBoundary',
	{ error: [...boundaryErrors, SlugTaken, AlreadyMember] },
) {}
```

The server builds it with `FailureBoundaryLayer.make(FailureBoundary,
toHttpError)`. Its type accepts only a `toHttpError` whose answers the tag
lists, so a class the app forgot to declare is a compile error, not a 500.

## The answer table

The app's `dbErrors.ts` holds only its data:

```ts
export const toHttpError = DatabaseAnswers.make({
	codes: {
		DNIED: (message) => new Forbidden({ message, reason: 'access_denied' }),
		ISMBR: (message) => new AlreadyMember({ message }),
	},
	constraints: {
		bands_slug_key: new SlugTaken({ message: 'That slug is already in use.' }),
	},
})
```

- `make` keeps the literal keys and returns the exact union of its answers:
  the `codes` results, the `constraints` values and the standard classes.
- A listed custom code answers with the SQL's own message. Only these codes
  pass Postgres text on.
- The package answers standard codes a client can cause with fixed text:
  23505 (by constraint, else `already_exists`), 23503, 42501, 23502, 23514,
  class 22, 40001, 40P01, 57014.
- Anything else dies, and the boundary answers 500.
- An expected refusal logs at Info (custom) or Warning (standard), once.

## Service-level codes

Every database failure reaches services as `DatabaseError`, its report
decoded once: `visitorDb` and `ownerDb` fail with it, and `Visitor.run` and
the owner transaction convert a failure at begin or commit (a deferred
constraint) the same way. A service maps the codes it reacts to with
`onSqlState`; every other `DatabaseError` reaches the handler's table:

```ts
onSqlState({
	DNIED: () => new BandRefused({ message: 'You must be the band owner to invite' }),
})
```

Mapping inside `Visitor.run` is safe: the mapped error still fails the
transaction. Recovering is not, because Postgres aborts the transaction on a
failed statement; recover outside `Visitor.run`, or inside a nested
transaction (a savepoint).

`onSqlState` replaces `mapSqlState`, which died on unlisted codes at the
service.

## Client messages

`errorMessage` takes any decoded API error and shows its `message`, with the
trace id for `InternalError`. A transport failure gets fixed text. App code
that treats one refusal differently matches its `_tag`; the package keeps no
list of app classes.

## Verification

- One app refusal (`SlugTaken`) goes through the real server and the
  generated client, and arrives with its status and `_tag`.
- A deferred constraint that fails at commit reaches the answer table.
- A client bundle built from a release tag contains no `http/server`,
  `db`, `visitor` or SQL driver code.

## Tracing

Tracing stays template wiring (ADR 0008): it is layer composition each app
tunes.
