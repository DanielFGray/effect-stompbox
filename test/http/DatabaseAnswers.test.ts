import { assert, describe, it } from '@effect/vitest'
import { Cause, Effect, Exit, Option, Schema } from 'effect'

import { DatabaseError } from '../../src/db/index.ts'
import { Conflict, ServiceUnavailable } from '../../src/http/index.ts'
import { DatabaseAnswers } from '../../src/http/server/index.ts'

class SlugTaken extends Schema.TaggedError<
	SlugTaken,
	{ readonly brand: unique symbol }
>()('SlugTaken', { message: Schema.String }, { httpApiStatus: 409 }) {}
class AlreadyMember extends Schema.TaggedError<
	AlreadyMember,
	{ readonly brand: unique symbol }
>()('AlreadyMember', { message: Schema.String }, { httpApiStatus: 409 }) {}

const toHttpError = DatabaseAnswers.make({
	codes: { ISMBR: (message) => new AlreadyMember({ message }) },
	constraints: {
		bands_slug_key: new SlugTaken({ message: 'That slug is already in use.' }),
	},
})

const refused = (code: string, options: { constraint?: string } = {}) =>
	new DatabaseError({
		message: `[${code}] text from postgres`,
		report: Option.some({
			code,
			message: 'text from postgres',
			detail: Option.none(),
			hint: Option.none(),
			constraint: Option.fromNullishOr(options.constraint),
		}),
		cause: undefined,
	})

const answer = (error: DatabaseError) => Effect.flip(toHttpError(error))

describe('DatabaseAnswers', () => {
	it.effect('answers a listed custom code with the SQL message', () =>
		Effect.gen(function* () {
			const result = yield* answer(refused('ISMBR'))
			assert.instanceOf(result, AlreadyMember)
			assert.strictEqual(result.message, 'text from postgres')
		}),
	)

	it.effect('answers a unique violation on a listed constraint with its class', () =>
		Effect.gen(function* () {
			const result = yield* answer(refused('23505', { constraint: 'bands_slug_key' }))
			assert.instanceOf(result, SlugTaken)
		}),
	)

	it.effect('answers each standard code with its class and fixed text', () =>
		Effect.gen(function* () {
			const answered = yield* Effect.forEach(
				['23505', '23503', '42501', '23502', '23514', '22P02', '40001', '40P01', '57014'],
				(code) => answer(refused(code)),
			)
			assert.deepStrictEqual(
				answered.map((e) => e._tag),
				[
					'Conflict',
					'Conflict',
					'Forbidden',
					'InvalidOperation',
					'InvalidOperation',
					'InvalidOperation',
					'ServiceUnavailable',
					'ServiceUnavailable',
					'ServiceUnavailable',
				],
			)
			assert.isFalse(answered.some((e) => e.message.includes('postgres')))
			const [exists, related, , , , , busy, deadlock, timedOut] = answered
			assert.instanceOf(exists, Conflict)
			assert.instanceOf(related, Conflict)
			assert.instanceOf(busy, ServiceUnavailable)
			assert.instanceOf(deadlock, ServiceUnavailable)
			assert.instanceOf(timedOut, ServiceUnavailable)
			assert.deepStrictEqual(
				[exists, related, busy, timedOut].map((e) =>
					e instanceof Conflict || e instanceof ServiceUnavailable ? e.reason : undefined,
				),
				['already_exists', 'related_data', 'busy', 'timed_out'],
			)
		}),
	)

	it.effect(
		'answers a unique violation on an unlisted constraint as already_exists',
		() =>
			Effect.gen(function* () {
				const result = yield* answer(refused('23505', { constraint: 'other_key' }))
				assert.instanceOf(result, Conflict)
			}),
	)

	it.effect('dies on an unlisted code and on a failure with no report', () =>
		Effect.gen(function* () {
			const unlisted = yield* Effect.exit(toHttpError(refused('XX000')))
			assert.isTrue(Exit.isFailure(unlisted) && Cause.hasDies(unlisted.cause))
			const noReport = yield* Effect.exit(
				toHttpError(
					new DatabaseError({ message: 'lost', report: Option.none(), cause: undefined }),
				),
			)
			assert.isTrue(Exit.isFailure(noReport) && Cause.hasDies(noReport.cause))
		}),
	)
})
