import { Array as Arr, Effect, Option, Schema } from 'effect'
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
		const cause = error.reason.cause
		const report = Schema.decodeUnknownOption(PostgresReport)(cause)
		return Effect.fail(
			new DatabaseError({ message: logMessage(report, cause), report, cause: error }),
		)
	})

/** Every part of the report, so one log line explains the refusal. */
const logMessage = (report: Option.Option<PostgresReport>, cause: unknown) =>
	Option.match(report, {
		onNone: () =>
			Option.match(Schema.decodeUnknownOption(DriverFailure)(cause), {
				onNone: () => 'Database call failed',
				onSome: (failure) => `Database call failed: ${failure.message}`,
			}),
		onSome: ({ code, message, detail, hint, constraint }) =>
			Arr.getSomes([
				Option.some(`[${code}] ${message}`),
				Option.map(detail, (text) => `detail: ${text}`),
				Option.map(hint, (text) => `hint: ${text}`),
				Option.map(constraint, (name) => `constraint: ${name}`),
			]).join('; '),
	})

/** A driver failure that carries no Postgres report, such as a lost connection. */
const DriverFailure = Schema.Struct({ message: Schema.String })
