import { Features } from '@effect-backend/delivery'
import { BunServices } from '@effect/platform-bun'
import { assert, describe, it, layer } from '@effect/vitest'
import {
	Cause,
	Config,
	ConfigProvider,
	Deferred,
	Effect,
	Exit,
	Fiber,
	Layer,
	Option,
	Schema,
} from 'effect'
import { SqlClient } from 'effect/sql/SqlClient'

import {
	ApiPool,
	mapSqlState,
	NestedVisitorRun,
	OwnerPool,
	RequestSession,
	StartupCheckFailed,
	Visitor,
} from '../src/index.ts'

// The test database is declared in cartridge.json (`ops dev db up`). The API
// pool has one connection, so consecutive requests always reuse the same one.
const settings = (overrides: Record<string, string>) =>
	ConfigProvider.layer(
		Effect.gen(function* () {
			const api = yield* Config.String('VISITOR_API_URL')
			const owner = yield* Config.String('VISITOR_OWNER_URL')
			return ConfigProvider.fromUnknown({
				AUTH_DATABASE_URL: api,
				AUTH_DATABASE_POOL_SIZE: '1',
				DATABASE_URL: owner,
				DATABASE_POOL_SIZE: '2',
				...overrides,
			})
		}),
	)

// These tests deliver no features, so the startup version check has nothing to check.
const pools = (overrides: Record<string, string> = {}) =>
	Layer.mergeAll(
		ApiPool.layer,
		OwnerPool.layer,
		Layer.succeed(Features, []),
		BunServices.layer,
	).pipe(Layer.provideMerge(settings(overrides)))

const live = Visitor.layer.pipe(Layer.provideMerge(pools()))

class BadCredentials extends Schema.TaggedError<
	BadCredentials,
	{ readonly brand: unique symbol }
>()('BadCredentials', {}) {}
class Taken extends Schema.TaggedError<Taken, { readonly brand: unique symbol }>()(
	'Taken',
	{},
) {}

const Note = Schema.Struct({ body: Schema.String })
const Login = Schema.Struct({
	role: Schema.String,
	session: Schema.NullOr(Schema.String),
})

/**
 * A schema of its own for one test: a notes table under row-level security
 * that shows each session its own rows, and a function that raises `CREDS`.
 * Dropped when the test's scope closes.
 */
const fixture = Effect.gen(function* () {
	const owner = yield* OwnerPool
	const name = `t_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`
	const [{ visitor }] =
		yield* owner`select current_database() || '_visitor' as visitor`.pipe(
			Effect.flatMap(
				Schema.decodeUnknownEffect(
					Schema.Tuple([Schema.Struct({ visitor: Schema.String })]),
				),
			),
		)
	yield* Effect.forEach(
		[
			`create schema ${name}`,
			`grant usage on schema ${name} to ${visitor}`,
			`create table ${name}.notes (
        id int generated always as identity primary key,
        session_id text not null default coalesce(current_setting('my.session_id', true), ''),
        body text not null,
        constraint body_unique unique (body) deferrable initially deferred)`,
			`alter table ${name}.notes enable row level security`,
			`create policy own on ${name}.notes to ${visitor}
        using (session_id = current_setting('my.session_id', true))
        with check (session_id = current_setting('my.session_id', true))`,
			`grant select, insert on ${name}.notes to ${visitor}`,
			`create function ${name}.fail_creds() returns void language plpgsql as $$
        begin raise exception 'bad credentials' using errcode = 'CREDS'; end $$`,
			`grant execute on function ${name}.fail_creds() to ${visitor}`,
		],
		(statement) => owner.unsafe(statement),
		{ discard: true },
	)
	yield* Effect.addFinalizer(() =>
		owner.unsafe(`drop schema ${name} cascade`).pipe(Effect.orDie),
	)
	return {
		insert: (body: string) =>
			Effect.flatMap(Effect.service(SqlClient), (sql) =>
				sql.unsafe(`insert into ${name}.notes (body) values ($1)`, [body]),
			),
		bodies: Effect.flatMap(Effect.service(SqlClient), (sql) =>
			sql
				.unsafe(`select body from ${name}.notes order by id`)
				.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Note)))),
		).pipe(Effect.map((rows) => rows.map((row) => row.body))),
		failCreds: Effect.flatMap(Effect.service(SqlClient), (sql) =>
			sql.unsafe(`select ${name}.fail_creds()`),
		),
		allBodies: owner.unsafe(`select body from ${name}.notes order by id`).pipe(
			Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Note))),
			Effect.map((rows) => rows.map((row) => row.body)),
		),
	}
})

/** Runs `effect` as the visitor for `session`. */
const as =
	(session: string) =>
	<A, E, R>(effect: Effect.Effect<A, E, R>) =>
		Effect.flatMap(Effect.service(Visitor), (visitor) => visitor.run(effect)).pipe(
			Effect.provideService(RequestSession, Option.some(session)),
		)

/** Who the API pool's connection is, outside any request. */
const apiLogin = Effect.flatMap(Effect.service(ApiPool), (api) =>
	api`select current_user as role, nullif(current_setting('my.session_id', true), '') as session`.pipe(
		Effect.flatMap(Schema.decodeUnknownEffect(Schema.Tuple([Login]))),
		Effect.map(([login]) => login),
	),
)

/** The fiber died with `NestedVisitorRun`. */
const diedNested = (exit: Exit.Exit<unknown, unknown>) =>
	Exit.isFailure(exit) &&
	Cause.hasDies(exit.cause) &&
	Schema.is(NestedVisitorRun)(Cause.squash(exit.cause))

/** The fiber failed because its connection lease was gone. */
const lostConnection = (exit: Exit.Exit<unknown, unknown>) =>
	Exit.isFailure(exit) &&
	Schema.is(Schema.Struct({ reason: Schema.TaggedStruct('ConnectionError', {}) }))(
		Cause.squash(exit.cause),
	)

layer(live, { excludeTestServices: true })('Visitor.run', (it) => {
	it.effect('shows a session only its own rows', () =>
		Effect.gen(function* () {
			const t = yield* fixture
			yield* as('a')(t.insert('from a'))
			yield* as('b')(t.insert('from b'))
			assert.deepStrictEqual(yield* as('a')(t.bodies), ['from a'])
			assert.deepStrictEqual(yield* as('b')(t.bodies), ['from b'])
		}),
	)

	it.effect('returns the connection to the API login after every request', () =>
		Effect.gen(function* () {
			const t = yield* fixture
			yield* as('a')(t.insert('a'))
			yield* as('b')(t.insert('b'))
			const login = yield* apiLogin
			for (let i = 0; i < 50; i++) {
				const session = i % 2 === 0 ? 'a' : 'b'
				assert.deepStrictEqual(yield* as(session)(t.bodies), [session])
				assert.deepStrictEqual(yield* apiLogin, login)
			}
			assert.strictEqual(login.session, null)
		}),
	)

	it.effect('rolls back a failed request, and the next request is clean', () =>
		Effect.gen(function* () {
			const t = yield* fixture
			const login = yield* apiLogin
			const exit = yield* as('a')(
				t.insert('lost').pipe(Effect.andThen(Effect.fail(new BadCredentials()))),
			).pipe(Effect.exit)
			assert.isTrue(Exit.isFailure(exit))
			assert.deepStrictEqual(yield* t.allBodies, [])
			assert.deepStrictEqual(yield* apiLogin, login)
			assert.deepStrictEqual(yield* as('b')(t.bodies), [])
		}),
	)

	it.effect('keeps an owner pool query out of the visitor transaction', () =>
		Effect.gen(function* () {
			const t = yield* fixture
			const owner = yield* OwnerPool
			yield* as('a')(
				Effect.provideService(t.insert('by owner'), SqlClient, owner).pipe(
					Effect.andThen(Effect.fail(new BadCredentials())),
				),
			).pipe(Effect.exit)
			assert.deepStrictEqual(yield* t.allBodies, ['by owner'])
		}),
	)

	it.effect('maps SQLSTATE codes after the rollback, and makes the rest defects', () =>
		Effect.gen(function* () {
			const t = yield* fixture
			const codes = mapSqlState({
				CREDS: () => new BadCredentials(),
				'23505': () => new Taken(),
			})
			const creds = yield* as('a')(t.failCreds).pipe(codes, Effect.flip)
			assert.strictEqual(creds._tag, 'BadCredentials')
			// The unique constraint is deferred, so the duplicate fails at COMMIT.
			const taken = yield* as('a')(
				t.insert('same').pipe(Effect.andThen(t.insert('same'))),
			).pipe(codes, Effect.flip)
			assert.strictEqual(taken._tag, 'Taken')
			const unmapped = yield* as('a')(t.failCreds).pipe(mapSqlState({}), Effect.exit)
			assert.isTrue(Exit.isFailure(unmapped) && Cause.hasDies(unmapped.cause))
		}),
	)

	it.effect('runs concurrent queries in one request on its one connection', () =>
		Effect.gen(function* () {
			const t = yield* fixture
			yield* as('a')(t.insert('a'))
			const results = yield* as('a')(
				Effect.all(
					Array.from({ length: 8 }, () => t.bodies),
					{ concurrency: 'unbounded' },
				),
			)
			assert.deepStrictEqual(
				results,
				Array.from({ length: 8 }, () => ['a']),
			)
		}),
	)

	it.effect('refuses a nested run, and the outer session stays', () =>
		Effect.gen(function* () {
			const t = yield* fixture
			yield* as('b')(t.insert('b'))
			const result = yield* as('a')(
				Effect.gen(function* () {
					const nested = yield* as('b')(t.bodies).pipe(Effect.exit)
					return { nested, outer: yield* t.bodies }
				}),
			)
			assert.isTrue(diedNested(result.nested))
			assert.deepStrictEqual(result.outer, [])
		}),
	)

	it.effect('lets afterCommit work start a new request, which sees the commit', () =>
		Effect.gen(function* () {
			const t = yield* fixture
			const after = yield* Deferred.make<ReadonlyArray<string>>()
			yield* as('a')(
				Effect.gen(function* () {
					const sql = yield* SqlClient
					yield* t.insert('committed')
					yield* sql.afterCommit(
						as('a')(t.bodies).pipe(
							Effect.orDie,
							Effect.flatMap((bodies) => Deferred.succeed(after, bodies)),
							Effect.asVoid,
						),
					)
				}),
			)
			assert.deepStrictEqual(yield* Deferred.await(after), ['committed'])
		}),
	)

	/**
	 * Request a forks a fiber that queries 100 ms later, then ends with `end`;
	 * `settle` waits for request a or interrupts it. Request b then holds the
	 * pool's only connection while the forked fiber wakes up. Returns the forked
	 * fiber when request a succeeded.
	 */
	const escape = (
		end: Effect.Effect<void, BadCredentials>,
		settle: <A, E>(
			request: Fiber.Fiber<A, E>,
		) => Effect.Effect<Exit.Exit<A, E>> = Fiber.await,
	) =>
		Effect.gen(function* () {
			const t = yield* fixture
			yield* as('b')(t.insert('b'))
			const forked = yield* as('a')(
				Effect.gen(function* () {
					const fiber = yield* Effect.forkDetach(
						Effect.sleep('100 millis').pipe(Effect.andThen(t.insert('escaped'))),
					)
					yield* end
					return fiber
				}),
			).pipe(
				Effect.forkChild,
				Effect.flatMap(settle),
				Effect.map((exit) =>
					Exit.isSuccess(exit) ? Option.some(exit.value) : Option.none(),
				),
			)
			const seen = yield* as('b')(
				Effect.flatMap(
					Effect.service(SqlClient),
					(sql) => sql`select pg_sleep(0.3)`,
				).pipe(Effect.andThen(t.bodies)),
			)
			assert.deepStrictEqual(seen, ['b'])
			yield* Effect.sleep('100 millis')
			assert.deepStrictEqual(yield* t.allBodies, ['b'])
			return forked
		})

	it.effect('stops a forked fiber from querying after the request ends', () =>
		Effect.gen(function* () {
			const forked = yield* escape(Effect.void)
			assert.isTrue(Option.isSome(forked))
			if (Option.isSome(forked)) {
				assert.isTrue(lostConnection(yield* Fiber.await(forked.value)))
			}
		}),
	)

	it.effect('stops a forked fiber after a failed request', () =>
		Effect.asVoid(escape(Effect.fail(new BadCredentials()))),
	)

	it.effect('stops a forked fiber after an interrupted request', () =>
		Effect.asVoid(
			escape(Effect.never, (request) =>
				Effect.sleep('20 millis').pipe(
					Effect.andThen(Fiber.interrupt(request)),
					Effect.andThen(Fiber.await(request)),
				),
			),
		),
	)
})

describe('Visitor startup check', () => {
	it.effect('refuses an API pool that logs in as the migration login', () =>
		Effect.gen(function* () {
			const owner = yield* Config.String('VISITOR_OWNER_URL')
			const error = yield* Layer.build(
				Visitor.layer.pipe(Layer.provide(pools({ AUTH_DATABASE_URL: owner }))),
			).pipe(Effect.flip)
			assert.instanceOf(error, StartupCheckFailed)
			if (error instanceof StartupCheckFailed) {
				assert.include(
					error.findings.map((f) => f.check),
					'session_user',
				)
			}
		}),
	)

	it.effect('refuses a visitor role the API login cannot switch to', () =>
		Effect.gen(function* () {
			const owner = yield* Config.String('VISITOR_OWNER_URL')
			const ownerRole = owner.replace(
				/^postgres:\/\/alchemy_(\w+)_migration:.*$/,
				'$1_owner',
			)
			const error = yield* Layer.build(
				Visitor.layer.pipe(Layer.provide(pools({ DATABASE_VISITOR: ownerRole }))),
			).pipe(Effect.flip)
			assert.instanceOf(error, StartupCheckFailed)
		}),
	)
})
