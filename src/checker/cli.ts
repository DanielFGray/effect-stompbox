import { BunRuntime, BunServices } from '@effect/platform-bun'
import { PgClient } from '@effect/sql-pg'
import { Config, Console, Effect, Layer, Option, Schema } from 'effect'
import { Argument, Command, Flag } from 'effect/cli'

import { Finding } from './Finding.ts'
import { c3, c4, readSurface, visitorReach, writeSurface } from './Reach.ts'
import { c1, c2, roleContract } from './Roles.ts'

class ChecksFailed extends Schema.TaggedError<
	ChecksFailed,
	{ readonly brand: unique symbol }
>()('ChecksFailed', {
	errors: Schema.Int,
}) {}

const check = Command.make(
	'check',
	{
		surface: Flag.String('surface').pipe(
			Flag.withDescription('Visitor surface file for C3; without it, C3 does not run'),
			Flag.optional,
		),
		json: Flag.Boolean('json').pipe(
			Flag.withDescription('Print findings as JSON'),
			Flag.withDefault(false),
		),
	},
	Effect.fn(function* ({ surface, json }) {
		const roles = yield* roleContract
		const [catalog, reachFindings] = yield* Effect.all([
			Effect.all([c1(roles), c2(roles), c4(roles)]),
			Option.match(surface, {
				onNone: () =>
					Console.error('C3 not run: pass --surface <file>').pipe(Effect.as([])),
				onSome: (path) => Effect.zipWith(visitorReach(roles), readSurface(path), c3),
			}),
		])
		const found = [...catalog.flat(), ...reachFindings]
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

const writeSurfaceCommand = Command.make(
	'write-surface',
	{ path: Argument.String('path').pipe(Argument.withDescription('File to write')) },
	Effect.fn(function* ({ path }) {
		const roles = yield* roleContract
		yield* writeSurface(path, yield* visitorReach(roles))
	}),
).pipe(
	Command.withDescription(
		'Write the visitor surface file from this database; use a known-good database',
	),
)

/**
 * `search_path = pg_catalog` makes Postgres print every app object with its
 * schema, so surface lines read the same in every database.
 */
const database = PgClient.layerConfig({
	url: Config.Redacted('DATABASE_URL'),
	startupParameters: Config.succeed({ search_path: 'pg_catalog' }),
})

Command.make('checker').pipe(
	Command.withSubcommands([check, writeSurfaceCommand]),
	Command.run({ version: '0.0.0' }),
	Effect.provide(Layer.mergeAll(BunServices.layer, database)),
	BunRuntime.runMain,
)
