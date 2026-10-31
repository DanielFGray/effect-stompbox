import { BunRuntime, BunServices } from '@effect/platform-bun'
import { PgClient } from '@effect/sql-pg'
import { Config, Console, Effect, Layer, Schema } from 'effect'
import { Command, Flag } from 'effect/cli'

import { Finding } from './Finding.ts'
import { c1, c2, roleContract } from './Roles.ts'

class ChecksFailed extends Schema.TaggedError<
	ChecksFailed,
	{ readonly brand: unique symbol }
>()('ChecksFailed', {
	errors: Schema.Int,
}) {}

/** Runs every catalog check against the database in DATABASE_URL. */
const catalogChecks = Effect.gen(function* () {
	const roles = yield* roleContract
	const results = yield* Effect.all([c1(roles), c2(roles)])
	return results.flat()
})

const check = Command.make(
	'check',
	{
		json: Flag.Boolean('json').pipe(
			Flag.withDescription('Print findings as JSON'),
			Flag.withDefault(false),
		),
	},
	Effect.fn(function* ({ json }) {
		const found = yield* catalogChecks
		yield* json
			? Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Finding)))(found).pipe(
					Effect.flatMap(Console.log),
				)
			: Effect.forEach(found, (f) =>
					Console.log(`${f.level.toUpperCase()} ${f.check} ${f.object}: ${f.problem}`),
				)
		const errors = found.filter((f) => f.level === 'error').length
		if (errors > 0) return yield* new ChecksFailed({ errors })
	}),
).pipe(
	Command.withDescription('Report each place where the database breaks a security rule'),
)

const database = PgClient.layerConfig({ url: Config.Redacted('DATABASE_URL') })

Command.make('checker').pipe(
	Command.withSubcommands([check]),
	Command.run({ version: '0.0.0' }),
	Effect.provide(Layer.mergeAll(BunServices.layer, database)),
	BunRuntime.runMain,
)
