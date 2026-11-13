import { Schema } from 'effect'

import { DatabaseError } from '../db/DatabaseError.ts'

// What the browser and the server share. This module imports only `effect`,
// so a client bundle can import it without the Postgres driver.
//
// Each class owns one status through `httpApiStatus`; where one status has
// several causes, a `reason` literal tells them apart. The client tells
// classes apart by `_tag`.

/** One rejected request value. `path` starts with the request part (`payload`, `params`, `query`, `headers`). */
export const InputIssue = Schema.Struct({
	path: Schema.Array(Schema.Union([Schema.String, Schema.Int])),
	message: Schema.String,
})

/** A defect. The body carries a fixed message and the trace id that finds the logged cause. */
export class InternalError extends Schema.TaggedError<
	InternalError,
	{ readonly brand: unique symbol }
>()(
	'InternalError',
	{ message: Schema.String, traceId: Schema.String },
	{ httpApiStatus: 500 },
) {}

/** A request the server cannot accept as sent; `issues` names each value the request schema rejected. */
export class InvalidOperation extends Schema.TaggedError<
	InvalidOperation,
	{ readonly brand: unique symbol }
>()(
	'InvalidOperation',
	{
		message: Schema.String,
		reason: Schema.Literals(['invalid_input']),
		issues: Schema.Array(InputIssue),
	},
	{ httpApiStatus: 400 },
) {}

/** A request with no live session. */
export class Unauthorized extends Schema.TaggedError<
	Unauthorized,
	{ readonly brand: unique symbol }
>()('Unauthorized', { message: Schema.String }, { httpApiStatus: 401 }) {}

/** A request the signed-in user may not make. */
export class Forbidden extends Schema.TaggedError<
	Forbidden,
	{ readonly brand: unique symbol }
>()(
	'Forbidden',
	{ message: Schema.String, reason: Schema.Literals(['access_denied']) },
	{ httpApiStatus: 403 },
) {}

export class NotFound extends Schema.TaggedError<
	NotFound,
	{ readonly brand: unique symbol }
>()('NotFound', { message: Schema.String }, { httpApiStatus: 404 }) {}

/** The request conflicts with data that exists now. */
export class Conflict extends Schema.TaggedError<
	Conflict,
	{ readonly brand: unique symbol }
>()(
	'Conflict',
	{
		message: Schema.String,
		reason: Schema.Literals(['already_exists', 'related_data']),
	},
	{ httpApiStatus: 409 },
) {}

/**
 * The server could not finish the request now: a conflict with a concurrent
 * transaction (`busy`), a statement timeout (`timed_out`), or a fault in the
 * server's settings (`misconfigured`). The client may send the request again.
 */
export class ServiceUnavailable extends Schema.TaggedError<
	ServiceUnavailable,
	{ readonly brand: unique symbol }
>()(
	'ServiceUnavailable',
	{
		message: Schema.String,
		reason: Schema.Literals(['busy', 'timed_out', 'misconfigured']),
	},
	{ httpApiStatus: 503 },
) {}

/** The classes the boundary and the standard database answers raise. An app's boundary tag lists these and its own classes. */
export const boundaryErrors = [
	InternalError,
	InvalidOperation,
	Unauthorized,
	Forbidden,
	NotFound,
	Conflict,
	ServiceUnavailable,
	DatabaseError,
] as const
