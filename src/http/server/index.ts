import { Cause, Effect, Layer, Option, Record, type Schema } from 'effect'
import type * as Context from 'effect/Context'
import { HttpApiError, type HttpApiMiddleware } from 'effect/http-api'
import * as SchemaIssue from 'effect/SchemaIssue'
import type { unhandled } from 'effect/Types'

import {
	type DatabaseError,
	isDatabaseError,
	type PostgresReport,
} from '../../db/DatabaseError.ts'
import {
	Conflict,
	Forbidden,
	InternalError,
	InvalidOperation,
	ServiceUnavailable,
} from '../index.ts'

/** A tagged error class instance an app answers with, such as `SlugTaken`. */
type Answer = Cause.YieldableError & { readonly _tag: string }

/** The classes the package's standard codes raise. */
type StandardAnswer = Conflict | Forbidden | InvalidOperation | ServiceUnavailable

/**
 * The answer table: what each database failure means to a client. `codes` maps
 * a custom SQLSTATE that the app's SQL raises to an answer built from the
 * SQL's own message, which was written for users; `constraints` maps a unique
 * constraint a user can hit to its answer. The package answers the standard
 * codes a client can cause with fixed text. Anything else dies, and the
 * boundary answers 500.
 *
 * The result fails with the exact union of its answers: the `codes` results,
 * the `constraints` values and the standard classes. An expected refusal logs
 * once, at Info (custom code) or Warning (standard code).
 */
export const DatabaseAnswers = { make: makeAnswers }

function makeAnswers<
	const Codes extends Record<string, (message: string) => Answer>,
	const Constraints extends Record<string, Answer>,
>(answers: {
	readonly codes: Codes
	readonly constraints: Constraints
}): (
	error: DatabaseError,
) => Effect.Effect<
	never,
	ReturnType<Codes[keyof Codes]> | Constraints[keyof Constraints] | StandardAnswer
>
// The implementation signature is wider than the overload: TypeScript cannot
// relate a lookup by a runtime code to the exact union the overload promises.
function makeAnswers(answers: {
	readonly codes: Record<string, (message: string) => Answer>
	readonly constraints: Record<string, Answer>
}) {
	return Effect.fn('DatabaseAnswers.toHttpError')(function* (error: DatabaseError) {
		const report = Option.getOrUndefined(error.report)
		if (report === undefined) return yield* Effect.die(error)
		const custom = Record.get(answers.codes, report.code)
		if (Option.isSome(custom)) {
			yield* Effect.logInfo('Database refused the request', Cause.fail(error))
			return yield* custom.value(report.message)
		}
		const standard = standardAnswer(report, answers.constraints)
		if (Option.isNone(standard)) return yield* Effect.die(error)
		yield* Effect.logWarning('Database refused the request', Cause.fail(error))
		return yield* standard.value
	})
}

/**
 * Standard SQLSTATEs a client can cause, answered with fixed text because
 * Postgres's message can name tables, columns and values.
 *
 * - 23505 unique: the answer for its constraint, else 409 `already_exists`.
 * - 23503 foreign key: 409 `related_data`.
 * - 42501 insufficient privilege, which is also how Postgres refuses a row a
 *   row-level security policy rejects: 403.
 * - 23502 not null, 23514 check and class 22 (a value out of range or in the
 *   wrong format): 400 `invalid_input`.
 * - 40001 serialization failure and 40P01 deadlock: 503 `busy`. The server does
 *   not retry, because a request can have effects outside its transaction.
 * - 57014 query canceled (a statement timeout): 503 `timed_out`.
 */
const standardAnswer = (
	report: PostgresReport,
	constraints: Record<string, Answer>,
): Option.Option<Answer> => {
	switch (report.code) {
		case '23505':
			return Option.some(
				Option.flatMap(report.constraint, (name) => Record.get(constraints, name)).pipe(
					Option.getOrElse(
						() =>
							new Conflict({ message: 'That already exists.', reason: 'already_exists' }),
					),
				),
			)
		case '23503':
			return Option.some(
				new Conflict({
					message: 'This change conflicts with related data.',
					reason: 'related_data',
				}),
			)
		case '42501':
			return Option.some(
				new Forbidden({
					message: 'You do not have permission to do that.',
					reason: 'access_denied',
				}),
			)
		case '23502':
		case '23514':
			return Option.some(invalidInput())
		case '40001':
		case '40P01':
			return Option.some(
				new ServiceUnavailable({
					message: 'The server is busy. Try again.',
					reason: 'busy',
				}),
			)
		case '57014':
			return Option.some(
				new ServiceUnavailable({
					message: 'The request took too long. Try again.',
					reason: 'timed_out',
				}),
			)
		default:
			return report.code.startsWith('22') ? Option.some(invalidInput()) : Option.none()
	}
}

const invalidInput = () =>
	new InvalidOperation({
		message: 'Some values are not valid.',
		reason: 'invalid_input',
		issues: [],
	})

/**
 * The failure boundary's server half: every failed request answers from here.
 *
 * - A request part that fails its schema answers `InvalidOperation` with its
 *   issues.
 * - A typed `DatabaseError`, from a handler or a middleware (`SignedIn` at
 *   commit), answers through `toHttpError`, the answer table.
 * - A cause with a defect is logged once with the trace id and answers
 *   `InternalError`, never with the defect's text.
 * - Other typed failures pass through for the endpoint to encode.
 *
 * `tag` is the app's boundary tag. It must list `InternalError`,
 * `InvalidOperation`, `DatabaseError` and every class `toHttpError` can raise, so a class the
 * app forgot to declare is a compile error, not a 500.
 */
export const FailureBoundaryLayer = { make: makeBoundary }

function makeBoundary<Id, E extends ReadonlyArray<Schema.Top>>(
	tag: Context.Service<Id, HttpApiMiddleware.HttpApiMiddleware<never, E, never>> &
		ListsBoundaryErrors<E[number]['Type']>,
	toHttpError: (error: DatabaseError) => Effect.Effect<never, E[number]['Type']>,
): Layer.Layer<Id>
// The implementation signature is wider than the overload for the same reason
// as `makeAnswers`: the overload checks the tag against `toHttpError`, and the
// body only needs to raise classes the overload has already shown the tag lists.
function makeBoundary(
	tag: Context.Service<
		unknown,
		HttpApiMiddleware.HttpApiMiddleware<
			never,
			ReadonlyArray<Schema.Top & { readonly Type: Answer }>,
			never
		>
	>,
	toHttpError: (error: DatabaseError) => Effect.Effect<never, Answer>,
) {
	const answer = (error: unhandled): Effect.Effect<never, unhandled | Answer> =>
		isDatabaseFailure(error)
			? toHttpError(error)
			: isSchemaError(error)
				? rejectRequest(error)
				: Effect.fail(error)
	return Layer.succeed(tag, (httpEffect) =>
		httpEffect.pipe(
			Effect.catch(answer),
			Effect.catchCauseIf(Cause.hasDies, reportUnexpected),
		),
	)
}

/** No constraint when the tag lists the classes the boundary raises; otherwise a property that names what is missing. */
type ListsBoundaryErrors<Listed> = [
	InternalError | InvalidOperation | DatabaseError,
] extends [Listed]
	? unknown
	: { readonly tagMustList: 'InternalError, InvalidOperation and DatabaseError' }

/** The middleware sees failures as `unhandled`; HttpApi tags its own schema failures. */
const isSchemaError = (
	error: unhandled,
): error is unhandled & HttpApiError.HttpApiSchemaError =>
	HttpApiError.HttpApiSchemaError.is(error)

const isDatabaseFailure = (error: unhandled): error is unhandled & DatabaseError =>
	isDatabaseError(error)

/**
 * A request part that fails decoding is the caller's mistake. A response that
 * fails encoding (`Body`, `ResponseHeaders`) is ours, so it is unexpected.
 */
const rejectRequest = Effect.fn('FailureBoundary.rejectRequest')(function* (
	error: HttpApiError.HttpApiSchemaError,
) {
	if (error.kind === 'Body' || error.kind === 'ResponseHeaders')
		return yield* reportUnexpected(Cause.fail(error))
	return yield* new InvalidOperation({
		message: 'Some values are not valid.',
		reason: 'invalid_input',
		issues: formatIssues(error.cause.issue).issues.map((issue) => ({
			path: [error.kind.toLowerCase(), ...(issue.path ?? []).map(pathSegment)],
			message: issue.message,
		})),
	})
})

const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1()

const pathSegment = (segment: PropertyKey | { readonly key: PropertyKey }) => {
	const key = typeof segment === 'object' ? segment.key : segment
	return typeof key === 'number' ? key : String(key)
}

/**
 * Runs in its own span: a child of the request span shares its trace id, and a
 * request that tracing skips still gets an id that its log line carries.
 */
const reportUnexpected = <E>(cause: Cause.Cause<E>) =>
	Effect.useSpan('FailureBoundary.report', (span) =>
		Effect.logError('Unexpected failure', cause).pipe(
			Effect.annotateLogs({ traceId: span.traceId }),
			Effect.andThen(
				new InternalError({
					message: 'Something went wrong on our side.',
					traceId: span.traceId,
				}),
			),
		),
	)
