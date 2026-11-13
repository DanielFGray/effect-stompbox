import { Effect, Option, Schema } from 'effect'
import { isSqlError, type SqlError } from 'effect/sql/SqlError'

/**
 * Turns database errors into the caller's typed errors by SQLSTATE code, and
 * every other database error into a defect. `errors` maps a code to the
 * error to fail with: a Postgres code such as `23505`, or a code an app's SQL
 * function raises, such as `CREDS`.
 *
 * Apply it outside `Visitor.run`: a failed statement aborts the Postgres
 * transaction, so the transaction must roll back before code recovers.
 */
export const mapSqlState = <M>(errors: {
	readonly [K in keyof M]: (error: SqlError) => M[K]
}) => {
	// A Map, so a code never matches a property inherited from Object.prototype.
	const byCode = new Map<string, (error: SqlError) => M[keyof M]>(Object.entries(errors))
	return <A, E, R>(self: Effect.Effect<A, E | SqlError, R>) =>
		Effect.catchIf(self, isSqlError, (error) =>
			sqlState(error).pipe(
				Option.flatMap((code) => Option.fromNullishOr(byCode.get(code))),
				Option.match({
					onNone: () => Effect.die(error),
					onSome: (toError) => Effect.fail(toError(error)),
				}),
			),
		)
}

/** The SQLSTATE code the Postgres driver reported, when it reported one. */
export const sqlState = (error: SqlError) =>
	Schema.decodeUnknownOption(DriverError)(error.reason.cause).pipe(
		Option.map((e) => e.code),
	)

const DriverError = Schema.Struct({ code: Schema.String })
