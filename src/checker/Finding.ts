import { Effect, Schema } from 'effect'
import type { SqlError } from 'effect/sql/SqlError'

/**
 * error: a security defect. warning: a defect that breaks a function but
 * exposes no data. review: correct in some apps and wrong in others.
 */
export const Level = Schema.Literals(['error', 'warning', 'review'])
export type Level = typeof Level.Type

export class Finding extends Schema.Class<Finding, { readonly brand: unique symbol }>(
	'Finding',
)({
	level: Level,
	check: Schema.String,
	object: Schema.String,
	problem: Schema.String,
	rule: Schema.String,
}) {}

/** What a check is, apart from the query that finds its violations. */
export interface CheckInfo {
	readonly check: string
	readonly level: Level
	readonly rule: string
}

/**
 * Turns the rows of a check's query into findings. Each check is one query
 * that returns one row per violation, with an `object` and a `problem` column,
 * so Postgres answers every privilege question.
 */
export const findings =
	(info: CheckInfo) => (rows: Effect.Effect<ReadonlyArray<unknown>, SqlError>) =>
		rows.pipe(
			Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Violation))),
			Effect.map((violations) =>
				violations.map((violation) => new Finding({ ...info, ...violation })),
			),
		)

const Violation = Schema.Struct({ object: Schema.String, problem: Schema.String })
