import { BunServices } from '@effect/platform-bun'
import { assert, layer } from '@effect/vitest'
import { Config, ConfigProvider, Effect, Layer, Schema } from 'effect'
import * as Digest from 'effect/crypto/Digest'
import * as FileSystem from 'effect/FileSystem'
import * as Path from 'effect/Path'
import { ChildProcess, ChildProcessSpawner } from 'effect/process'
import { SqlClient } from 'effect/sql/SqlClient'

import { c3, c4, roleContract, visitorReach } from '../../src/checker/index.ts'
import { deliver, DeliveryRefused, Feature, Features } from '../../src/delivery/index.ts'
import {
	ApiPool,
	OwnerPool,
	StartupCheckFailed,
	Visitor,
} from '../../src/visitor/index.ts'

// The test database is declared in cartridge.json (`ops dev db up`). Each
// test starts from a database with none of the fixture features installed.
const settings = ConfigProvider.layer(
	Effect.gen(function* () {
		return ConfigProvider.fromUnknown({
			AUTH_DATABASE_URL: yield* Config.String('DELIVERY_API_URL'),
			AUTH_DATABASE_POOL_SIZE: '1',
			DATABASE_URL: yield* Config.String('DELIVERY_OWNER_URL'),
			DATABASE_POOL_SIZE: '2',
		})
	}),
)

const live = Layer.mergeAll(
	ApiPool.layer,
	OwnerPool.layer,
	BunServices.layer,
	Digest.layerWebCrypto,
).pipe(Layer.provideMerge(settings))

/**
 * The fixture feature at a version: a scoped copy of its first `version`
 * migration files, as a released package of that version would hold them.
 */
const at = Effect.fnUntraced(function* (
	name: 'users' | 'sessions' | 'app',
	version: number,
) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const source = path.join(import.meta.dirname, 'fixtures', name)
	const directory = yield* fs.makeTempDirectoryScoped()
	const files = (yield* fs.readDirectory(source)).sort().slice(0, version)
	yield* Effect.forEach(
		files,
		(file) => fs.copyFile(path.join(source, file), path.join(directory, file)),
		{
			discard: true,
		},
	)
	return new Feature({ name, dependsOn: dependencies[name], directory })
})

const dependencies = { users: [], sessions: ['users'], app: ['users', 'sessions'] }

const versions = (users: number, sessions: number, app: number) =>
	Effect.all([at('users', users), at('sessions', sessions), at('app', app)])

/** Runs `deliver` on the owner pool. */
const deliverAsOwner = (features: ReadonlyArray<Feature>) =>
	Effect.flatMap(Effect.service(OwnerPool), (owner) =>
		Effect.provideService(deliver(features), SqlClient, owner),
	)

const ownerSql = <A, E>(f: (sql: SqlClient) => Effect.Effect<A, E>) =>
	Effect.flatMap(Effect.service(OwnerPool), (owner) => f(owner))

const reset = ownerSql(
	(sql) => sql`drop schema if exists fx_app, fx_auth, stompbox cascade`,
)

const recordedCount = ownerSql((sql) =>
	sql`select count(*)::int as n from stompbox.migrations`.pipe(
		Effect.flatMap(
			Schema.decodeUnknownEffect(Schema.Tuple([Schema.Struct({ n: Schema.Int })])),
		),
		Effect.map(([{ n }]) => n),
	),
)

/** The schema of the test database as `pg_dump` writes it, without the lines that differ per run. */
const dumpSchema = Effect.gen(function* () {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
	const url = yield* Config.String('DATABASE_URL')
	const lines = yield* spawner.lines(ChildProcess.make('pg_dump', ['--schema-only', url]))
	return lines
		.filter((l) => !/^\\(un)?restrict |^-- Dumped (from|by) /.test(l))
		.join('\n')
})

/** The reason a delivery was refused, or the tag of any other failure. */
const refusal = <A, E extends { readonly _tag: string }, R>(
	effect: Effect.Effect<A, E, R>,
) =>
	effect.pipe(
		Effect.flip,
		Effect.map((e) => (e instanceof DeliveryRefused ? e.reason : e._tag)),
	)

layer(live, { excludeTestServices: true })('deliver', (it) => {
	it.effect('upgrades across two versions to the same schema as a fresh install', () =>
		Effect.gen(function* () {
			yield* reset
			yield* deliverAsOwner(yield* versions(1, 1, 1))
			yield* ownerSql(
				(
					sql,
				) => sql`with u as (insert into fx_auth.users (name) values ('ada') returning id)
				             insert into fx_app.posts (author, body) select id, 'hello' from u`,
			)
			const upgraded = yield* deliverAsOwner(yield* versions(3, 3, 2))
			assert.deepStrictEqual(upgraded, [
				{ feature: 'users', from: 1, to: 3 },
				{ feature: 'sessions', from: 1, to: 3 },
				{ feature: 'app', from: 1, to: 2 },
			])
			const afterUpgrade = yield* dumpSchema
			yield* reset
			yield* deliverAsOwner(yield* versions(3, 3, 2))
			assert.strictEqual(afterUpgrade, yield* dumpSchema)
			assert.include(afterUpgrade, 'CREATE POLICY own_posts')
		}),
	)

	it.effect('leaves every feature at its old version when a migration fails', () =>
		Effect.gen(function* () {
			yield* reset
			yield* deliverAsOwner(yield* versions(1, 1, 1))
			const fs = yield* FileSystem.FileSystem
			const sessions = yield* at('sessions', 1)
			yield* fs.writeFileString(`${sessions.directory}/0002-broken.sql`, 'select 1 / 0;')
			const failed = yield* refusal(
				deliverAsOwner([yield* at('users', 3), sessions, yield* at('app', 1)]),
			)
			assert.strictEqual(failed, 'SqlError')
			assert.strictEqual(yield* recordedCount, 3)
			const email = yield* ownerSql(
				(sql) => sql`select 1 from information_schema.columns
				             where table_schema = 'fx_auth' and table_name = 'users' and column_name = 'email'`,
			)
			assert.strictEqual(email.length, 0)
		}),
	)

	it.effect('refuses before changing anything', () =>
		Effect.gen(function* () {
			yield* reset
			const fs = yield* FileSystem.FileSystem
			const [users, sessions, app] = yield* versions(1, 1, 1)

			const cycle = [
				new Feature({ name: 'a', dependsOn: ['b'], directory: users.directory }),
				new Feature({ name: 'b', dependsOn: ['a'], directory: users.directory }),
			]
			assert.strictEqual(
				yield* refusal(deliverAsOwner(cycle)),
				'dependency cycle: a -> b -> a',
			)
			assert.strictEqual(
				yield* refusal(deliverAsOwner([sessions])),
				'sessions depends on users, which is not listed',
			)

			const transaction = yield* at('users', 0)
			yield* fs.writeFileString(
				`${transaction.directory}/0001-users.sql`,
				'create table t (a int);\nbegin;',
			)
			assert.strictEqual(
				yield* refusal(deliverAsOwner([transaction])),
				'users/0001-users.sql:2: transaction control; the runner owns the transaction',
			)

			const asApi = Effect.flatMap(Effect.service(ApiPool), (api) =>
				Effect.provideService(deliver([users]), SqlClient, api),
			)
			assert.match(
				yield* refusal(asApi),
				/^migrations run as the owner role .*_owner, not as alchemy_.*_api$/,
			)

			yield* deliverAsOwner([users, sessions, app])
			yield* fs.writeFileString(
				`${users.directory}/0001-users.sql`,
				`${yield* fs.readFileString(`${users.directory}/0001-users.sql`)}\n-- edited after release\n`,
			)
			assert.strictEqual(
				yield* refusal(deliverAsOwner([users, sessions, app])),
				'users migration 1 changed after it ran here',
			)
			assert.strictEqual(yield* recordedCount, 3)
		}),
	)

	it.effect(
		'runs each migration once when two runners start together on an empty database',
		() =>
			Effect.gen(function* () {
				yield* reset
				const features = yield* versions(3, 3, 2)
				const [first, second] = yield* Effect.all(
					[deliverAsOwner(features), deliverAsOwner(features)],
					{
						concurrency: 2,
					},
				)
				assert.sameDeepMembers(
					[first, second].map((run) => run.map((d) => d.from)),
					[
						[0, 0, 0],
						[3, 3, 2],
					],
				)
				assert.strictEqual(yield* recordedCount, 8)
			}),
	)

	it.effect(
		'passes C3 and C4 after an upgrade: the visitor reaches only the approved surface',
		() =>
			Effect.gen(function* () {
				yield* reset
				yield* deliverAsOwner(yield* versions(1, 1, 1))
				yield* deliverAsOwner(yield* versions(3, 3, 2))
				const findings = yield* ownerSql((sql) =>
					Effect.gen(function* () {
						const roles = yield* roleContract
						const reach = yield* visitorReach(roles)
						return [...c3(reach, approvedSurface), ...(yield* c4(roles))]
					}).pipe(Effect.provideService(SqlClient, sql)),
				)
				assert.deepStrictEqual(
					findings.map((f) => `${f.check} ${f.object}: ${f.problem}`),
					[],
				)
			}),
	)
})

/** What the fixture features grant the visitor, reviewed by hand. */
const approvedSurface = [
	'function stompbox.feature_versions()',
	'function fx_auth.current_user_id()',
	'schema stompbox',
	'schema fx_app',
	'schema fx_auth',
	'schema public',
	'table fx_app.posts INSERT,SELECT',
]

layer(live, { excludeTestServices: true })('startup check', (it) => {
	const startVisitor = (features: ReadonlyArray<Feature>) =>
		Layer.build(
			Visitor.layer.pipe(Layer.provide(Layer.succeed(Features, features))),
		).pipe(Effect.asVoid, Effect.scoped)

	it.effect(
		'refuses a database behind the code, and accepts one level with it or ahead',
		() =>
			Effect.gen(function* () {
				yield* reset
				yield* deliverAsOwner(yield* versions(3, 3, 1))
				const behind = yield* Effect.flip(startVisitor(yield* versions(3, 3, 2)))
				assert.instanceOf(behind, StartupCheckFailed)
				if (behind instanceof StartupCheckFailed)
					assert.deepStrictEqual(
						behind.findings.map((f) => [f.object, f.problem]),
						[['feature app', 'the database has version 1, the code needs 2']],
					)
				yield* deliverAsOwner(yield* versions(3, 3, 2))
				yield* startVisitor(yield* versions(3, 3, 2))
				yield* startVisitor(yield* versions(3, 3, 1))
			}),
	)
})
