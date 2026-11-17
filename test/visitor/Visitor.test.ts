import { BunServices } from '@effect/platform-bun'
import { assert, describe, expectTypeOf, it, layer } from '@effect/vitest'
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
import type { Generated } from 'kysely'

import { DatabaseError, onSqlState, toDatabaseError } from '../../src/db/index.ts'
import { Features } from '../../src/delivery/index.ts'
import {
	ApiPool,
	NestedVisitorRun,
	ownerDb,
	OwnerPool,
	RequestSession,
	StartupCheckFailed,
	Visitor,
	visitorDb,
	VisitorTransaction,
} from '../../src/visitor/index.ts'

/** The visitor transaction's client, inside `Visitor.run`. */
const visitorSql = Effect.map(Effect.service(VisitorTransaction), (t) => t.sql)

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
 * A schema of its own for one test. `insert` and `failCreds` stand for a
 * service's raw queries, which convert their failure with `toDatabaseError`:
 * a notes table under row-level security
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
		name,
		insert: (body: string) =>
			Effect.flatMap(visitorSql, (sql) =>
				sql
					.unsafe(`insert into ${name}.notes (body) values ($1)`, [body])
					.pipe(toDatabaseError),
			),
		bodies: Effect.flatMap(visitorSql, (sql) =>
			sql
				.unsafe(`select body from ${name}.notes order by id`)
				.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Note)))),
		).pipe(Effect.map((rows) => rows.map((row) => row.body))),
		failCreds: Effect.flatMap(visitorSql, (sql) =>
			sql.unsafe(`select ${name}.fail_creds()`).pipe(toDatabaseError),
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
	Schema.is(
		Schema.Struct({
			cause: Schema.Struct({ reason: Schema.TaggedStruct('ConnectionError', {}) }),
		}),
	)(Cause.squash(exit.cause))

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
				Effect.provideService(t.insert('by owner'), VisitorTransaction, {
					sql: owner,
				}).pipe(Effect.andThen(Effect.fail(new BadCredentials()))),
			).pipe(Effect.exit)
			assert.deepStrictEqual(yield* t.allBodies, ['by owner'])
		}),
	)

	it.effect(
		'maps SQLSTATE codes outside the run, and leaves the rest as DatabaseError',
		() =>
			Effect.gen(function* () {
				const t = yield* fixture
				const codes = onSqlState({
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
				const unmapped = yield* as('a')(t.failCreds).pipe(onSqlState({}), Effect.flip)
				assert.isTrue(Schema.is(DatabaseError)(unmapped))
			}),
	)

	it.effect(
		'fails a deferred constraint at commit as DatabaseError with its report',
		() =>
			Effect.gen(function* () {
				const t = yield* fixture
				const error = yield* as('a')(
					t.insert('same').pipe(Effect.andThen(t.insert('same'))),
				).pipe(Effect.flip)
				assert.isTrue(Schema.is(DatabaseError)(error))
				assert.deepStrictEqual(
					Option.map(error.report, ({ code, constraint }) => [code, constraint]),
					Option.some(['23505', Option.some('body_unique')]),
				)
				assert.deepStrictEqual(yield* t.allBodies, [])
			}),
	)

	it.effect('maps a code inside the run, and the transaction still rolls back', () =>
		Effect.gen(function* () {
			const t = yield* fixture
			const mapped = yield* as('a')(
				t
					.insert('lost')
					.pipe(
						Effect.andThen(t.failCreds),
						onSqlState({ CREDS: () => new BadCredentials() }),
					),
			).pipe(Effect.flip)
			assert.instanceOf(mapped, BadCredentials)
			assert.deepStrictEqual(yield* t.allBodies, [])
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
					const { sql } = yield* VisitorTransaction
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
				Effect.flatMap(visitorSql, (sql) => sql`select pg_sleep(0.3)`).pipe(
					Effect.andThen(t.bodies),
				),
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
				/^postgres(?:ql)?:\/\/alchemy_(\w+)_migration:.*$/,
				'$1_owner',
			)
			const error = yield* Layer.build(
				Visitor.layer.pipe(Layer.provide(pools({ DATABASE_VISITOR: ownerRole }))),
			).pipe(Effect.flip)
			assert.instanceOf(error, StartupCheckFailed)
			if (error instanceof StartupCheckFailed)
				assert.include(
					error.findings.map((f) => f.check),
					'C1',
				)
		}),
	)
})

/** The fixture's notes table, as Kysely sees it under `withSchema`. */
interface NoteTables {
	readonly notes: {
		readonly id: Generated<number>
		readonly session_id: Generated<string>
		readonly body: string
	}
}

const visitor = visitorDb<NoteTables>()
const owner = ownerDb<NoteTables>()

layer(live, { excludeTestServices: true })('visitorDb and ownerDb', (it) => {
	it.effect('runs Kysely queries in the visitor transaction and decodes the rows', () =>
		Effect.gen(function* () {
			const t = yield* fixture
			const insert = (body: string) =>
				visitor.one(Note, (k) =>
					k.withSchema(t.name).insertInto('notes').values({ body }).returning('body'),
				)
			assert.deepStrictEqual(yield* as('a')(insert('from a')), { body: 'from a' })
			yield* as('b')(insert('from b'))
			const mine = yield* as('a')(
				visitor.all(Note, (k) => k.withSchema(t.name).selectFrom('notes').select('body')),
			)
			assert.deepStrictEqual(mine, [{ body: 'from a' }])
			const none = yield* as('a')(
				visitor.maybe(Note, (k) =>
					k
						.withSchema(t.name)
						.selectFrom('notes')
						.select('body')
						.where('body', '=', 'from b'),
				),
			)
			assert.deepStrictEqual(none, Option.none())
		}),
	)

	it.effect('recovers from an error inside a request with a nested transaction', () =>
		Effect.gen(function* () {
			const t = yield* fixture
			const bodies = yield* as('a')(
				Effect.gen(function* () {
					const { sql } = yield* VisitorTransaction
					yield* t.insert('before')
					// The nested transaction is a savepoint: its failure rolls back only
					// the savepoint, so the request goes on and commits.
					const refused = yield* sql
						.withTransaction(t.insert('in savepoint').pipe(Effect.andThen(t.failCreds)))
						.pipe(onSqlState({ CREDS: () => new BadCredentials() }), Effect.flip)
					assert.instanceOf(refused, BadCredentials)
					yield* t.insert('after')
					return yield* t.bodies
				}),
			)
			assert.deepStrictEqual(bodies, ['before', 'after'])
			assert.deepStrictEqual(yield* t.allBodies, ['before', 'after'])
		}),
	)

	it.effect('rolls back every owner query in withTransaction together', () =>
		Effect.gen(function* () {
			const t = yield* fixture
			const insert = (body: string) =>
				owner.one(Note, (k) =>
					k.withSchema(t.name).insertInto('notes').values({ body }).returning('body'),
				)
			const exit = yield* owner
				.withTransaction(
					insert('first').pipe(
						Effect.andThen(insert('second')),
						Effect.andThen(Effect.fail(new BadCredentials())),
					),
				)
				.pipe(Effect.exit)
			assert.isTrue(Exit.isFailure(exit))
			assert.deepStrictEqual(yield* t.allBodies, [])
		}),
	)

	it('refuses at compile time a visitor query outside a request, and a Schema that does not fit', () => {
		const query = visitor.all(Note, (k) => k.selectFrom('notes').select('body'))
		// It needs VisitorTransaction, which only Visitor.run provides.
		expectTypeOf<Effect.Services<typeof query>>().toEqualTypeOf<VisitorTransaction>()
		const wrong = visitor.all(Schema.Struct({ id: Schema.String }), (k) =>
			// @ts-expect-error: the row's `id` is a number, the Schema expects a string
			k.selectFrom('notes').select('id'),
		)
		assert.isDefined(wrong)
	})
})
