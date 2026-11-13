import { Effect, Option, Schema } from 'effect'
import { isSqlError, type SqlError } from 'effect/sql/SqlError'

import { DatabaseError, PostgresReport } from './DatabaseError.ts'

/**
 * Turns a `SqlError` into a `DatabaseError`. `@effect/sql-pg` keeps the
 * protocol fields on the reason's cause, so the report is decoded from there,
 * once; the `SqlError` stays as `cause`. Any other error passes through.
 * This module needs `effect/sql`, so `DatabaseError` lives apart from it and a
 * client bundle can import the class without SQL code.
 */
export const toDatabaseError = <A, E, R>(self: Effect.Effect<A, E | SqlError, R>) =>
	Effect.catchIf(self, isSqlError, (error) => {
		const report = Schema.decodeUnknownOption(PostgresReport)(error.reason.cause)
		return Effect.fail(
			new DatabaseError({
				message: Option.match(report, {
					onNone: () => 'Database call failed',
					onSome: ({ code, message }) => `[${code}] ${message}`,
				}),
				report,
				cause: error,
			}),
		)
	})
