import { BunServices } from '@effect/platform-bun'
import { assert, layer } from '@effect/vitest'
import { Config, ConfigProvider, Effect, Layer, Option, Schema } from 'effect'
import * as Digest from 'effect/crypto/Digest'
import * as SecureRandom from 'effect/crypto/SecureRandom'
import { SqlClient } from 'effect/sql/SqlClient'

import { auth, SessionLifetimesInvalid, Sessions } from '../../src/auth/index.ts'
import {
	c3,
	c4,
	c5,
	c6,
	c7,
	c8,
	roleContract,
	visitorReach,
} from '../../src/checker/index.ts'
import { sqlState } from '../../src/db/index.ts'
import { deliver, Features } from '../../src/delivery/index.ts'
import {
	ApiPool,
	OwnerPool,
	RequestSession,
	Visitor,
	VisitorTransaction,
} from '../../src/visitor/index.ts'

// The test database is declared in cartridge.json (`ops dev db up`). The
// suite installs the feature `auth` once, on a database without it, then
// builds the visitor.
const settings = ConfigProvider.layer(
	Effect.gen(function* () {
		return ConfigProvider.fromUnknown({
			AUTH_DATABASE_URL: yield* Config.String('AUTH_API_URL'),
			AUTH_DATABASE_POOL_SIZE: '1',
			DATABASE_URL: yield* Config.String('AUTH_OWNER_URL'),
			DATABASE_POOL_SIZE: '2',
		})
	}),
)

const install = Layer.effectDiscard(
	Effect.gen(function* () {
		const sql = yield* OwnerPool
		yield* sql`drop schema if exists auth, auth_private, stompbox cascade`
		yield* deliver([auth]).pipe(Effect.provideService(SqlClient, sql))
	}),
)

const live = Layer.mergeAll(Visitor.layer, Sessions.layer).pipe(
	Layer.provideMerge(Layer.mergeAll(install, Layer.succeed(Features, [auth]))),
	Layer.provideMerge(
		Layer.mergeAll(
			OwnerPool.layer,
			ApiPool.layer,
			BunServices.layer,
			Digest.layerWebCrypto,
			SecureRandom.layerWebCrypto,
		),
	),
	Layer.provideMerge(settings),
)

/** The visitor transaction's client, inside `Visitor.run`. */
const visitorSql = Effect.map(Effect.service(VisitorTransaction), (t) => t.sql)

const owner = <A, E>(f: (sql: SqlClient) => Effect.Effect<A, E>) =>
	Effect.flatMap(Effect.service(OwnerPool), f)

const newUser = owner((sql) =>
	sql`insert into auth.users default values returning id`.pipe(
		Effect.flatMap(
			Schema.decodeUnknownEffect(Schema.Tuple([Schema.Struct({ id: Schema.String })])),
		),
		Effect.map(([{ id }]) => id),
	),
)

/** `auth.current_user_id()` and `auth.current_session_id()` in a visitor run with this session. */
const bridge = (session: Option.Option<string>) =>
	Effect.gen(function* () {
		const visitor = yield* Visitor
		const rows = yield* visitor
			.run(
				Effect.flatMap(
					visitorSql,
					(sql) =>
						sql`select auth.current_user_id() as "user", auth.current_session_id() as session`,
				),
			)
			.pipe(Effect.provideService(RequestSession, session))
		return yield* Schema.decodeUnknownEffect(
			Schema.Tuple([
				Schema.Struct({
					user: Schema.NullOr(Schema.String),
					session: Schema.NullOr(Schema.String),
				}),
			]),
		)(rows).pipe(Effect.map(([row]) => row))
	})

/** Moves a session's times by `interval`, as if it had been created that long before. */
const age = (sessionId: string, interval: string) =>
	owner(
		(sql) => sql`update auth_private.sessions
		             set created_at = created_at - ${interval}::interval,
		                 refreshed_at = refreshed_at - ${interval}::interval,
		                 expires_at = expires_at - ${interval}::interval,
		                 absolute_expires_at = absolute_expires_at - ${interval}::interval
		             where id = ${sessionId}`,
	)

const sessionTimes = (sessionId: string) =>
	owner((sql) =>
		sql`select extract(epoch from expires_at - now())::float8 as expires_in,
		           extract(epoch from absolute_expires_at - now())::float8 as absolute_in,
		           extract(epoch from now() - refreshed_at)::float8 as refreshed_ago
		    from auth_private.sessions where id = ${sessionId}`.pipe(
			Effect.flatMap(
				Schema.decodeUnknownEffect(
					Schema.Tuple([
						Schema.Struct({
							expires_in: Schema.Finite,
							absolute_in: Schema.Finite,
							refreshed_ago: Schema.Finite,
						}),
					]),
				),
			),
			Effect.map(([row]) => row),
		),
	)

const day = 86_400

layer(live, { excludeTestServices: true })('session bridge', (it) => {
	it.effect(
		'gives the user of a live session, and null for no, unknown, expired or revoked sessions',
		() =>
			Effect.gen(function* () {
				const sessions = yield* Sessions
				const user = yield* newUser
				const live = yield* sessions.create(user)
				assert.deepStrictEqual(yield* bridge(Option.some(live.sessionId)), {
					user,
					session: live.sessionId,
				})

				const none = { user: null, session: null }
				assert.deepStrictEqual(yield* bridge(Option.none()), none)
				assert.deepStrictEqual(
					yield* bridge(Option.some('00000000-0000-4000-8000-000000000000')),
					none,
				)

				const expired = yield* sessions.create(user)
				yield* age(expired.sessionId, '8 days')
				assert.deepStrictEqual(yield* bridge(Option.some(expired.sessionId)), none)

				const revoked = yield* sessions.create(user)
				yield* sessions.revoke(revoked.sessionId)
				assert.deepStrictEqual(yield* bridge(Option.some(revoked.sessionId)), none)
			}),
	)

	it.effect('denies the visitor the sessions and users tables', () =>
		Effect.gen(function* () {
			const visitor = yield* Visitor
			const denied = (table: string) =>
				visitor
					.run(Effect.flatMap(visitorSql, (sql) => sql.unsafe(`select 1 from ${table}`)))
					.pipe(
						Effect.provideService(RequestSession, Option.none()),
						Effect.flip,
						Effect.map(sqlState),
					)
			assert.deepStrictEqual(yield* denied('auth_private.sessions'), Option.some('42501'))
			assert.deepStrictEqual(yield* denied('auth.users'), Option.some('42501'))
		}),
	)

	it.effect('passes C3 to C8 with the feature installed', () =>
		Effect.gen(function* () {
			const findings = yield* owner((sql) =>
				Effect.gen(function* () {
					const roles = yield* roleContract
					const reach = yield* visitorReach(roles)
					return [
						...c3(reach, approvedSurface),
						...(yield* c4(roles)),
						...(yield* c5(roles)),
						...(yield* c6(roles)),
						...(yield* c7(roles)),
						...(yield* c8(roles)),
					]
				}).pipe(Effect.provideService(SqlClient, sql)),
			)
			assert.deepStrictEqual(
				findings.map((f) => `${f.check} ${f.object}: ${f.problem}`),
				[],
			)
		}),
	)
})

layer(live, { excludeTestServices: true })('Sessions.validate', (it) => {
	it.effect(
		'gives the session and its user for its token, and none for a bad or ended one',
		() =>
			Effect.gen(function* () {
				const sessions = yield* Sessions
				const user = yield* newUser
				const session = yield* sessions.create(user)
				assert.deepStrictEqual(
					yield* sessions.validate(session.token),
					Option.some({ sessionId: session.sessionId, userId: user }),
				)
				assert.closeTo(
					(session.absoluteExpiresAt.getTime() - session.expiresAt.getTime()) / 1000,
					23 * day,
					60,
				)

				const wrongSecret = `${session.sessionId}.${'0'.repeat(64)}`
				for (const token of [wrongSecret, 'not a token', `${session.sessionId}.zz`, ''])
					assert.deepStrictEqual(yield* sessions.validate(token), Option.none())

				yield* age(session.sessionId, '8 days')
				assert.deepStrictEqual(yield* sessions.validate(session.token), Option.none())

				const revoked = yield* sessions.create(user)
				yield* sessions.revokeAll(user)
				assert.deepStrictEqual(yield* sessions.validate(revoked.token), Option.none())
			}),
	)

	it.effect(
		'moves the idle expiry once per refresh interval, never back and never past the absolute expiry',
		() =>
			Effect.gen(function* () {
				const sessions = yield* Sessions
				const user = yield* newUser

				const fresh = yield* sessions.create(user)
				yield* age(fresh.sessionId, '30 minutes')
				yield* sessions.validate(fresh.token)
				assert.isAbove((yield* sessionTimes(fresh.sessionId)).refreshed_ago, 29 * 60)

				const due = yield* sessions.create(user)
				yield* age(due.sessionId, '2 days')
				yield* sessions.validate(due.token)
				const moved = yield* sessionTimes(due.sessionId)
				assert.isBelow(moved.refreshed_ago, 60)
				assert.closeTo(moved.expires_in, 7 * day, 60)

				const nearEnd = yield* sessions.create(user)
				yield* age(nearEnd.sessionId, '27 days')
				yield* owner(
					(sql) =>
						sql`update auth_private.sessions set expires_at = now() + interval '1 hour' where id = ${nearEnd.sessionId}`,
				)
				yield* sessions.validate(nearEnd.token)
				const capped = yield* sessionTimes(nearEnd.sessionId)
				assert.closeTo(capped.expires_in, 3 * day, 60)
				assert.strictEqual(capped.expires_in, capped.absolute_in)

				const later = yield* sessions.create(user)
				yield* owner(
					(sql) => sql`update auth_private.sessions
				             set created_at = now() - interval '2 hours', refreshed_at = now() - interval '2 hours', expires_at = now() + interval '20 days'
				             where id = ${later.sessionId}`,
				)
				yield* Effect.all(
					[sessions.validate(later.token), sessions.validate(later.token)],
					{
						concurrency: 2,
					},
				)
				assert.closeTo((yield* sessionTimes(later.sessionId)).expires_in, 20 * day, 60)
			}),
	)

	it.effect('refuses lifetimes that cannot work together', () =>
		Effect.gen(function* () {
			const refused = (lifetimes: Record<string, string>) =>
				Sessions.make.pipe(
					Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(lifetimes))),
					Effect.flip,
					Effect.map((e) => (e instanceof SessionLifetimesInvalid ? e.reason : e._tag)),
				)
			assert.strictEqual(
				yield* refused({ SESSION_REFRESH_INTERVAL: '8 days' }),
				'the refresh interval must be shorter than the idle lifetime',
			)
			assert.strictEqual(
				yield* refused({ SESSION_ABSOLUTE_LIFETIME: '0 seconds' }),
				'not positive: absolute',
			)
		}),
	)

	it.effect('deletes ended sessions and keeps live ones', () =>
		Effect.gen(function* () {
			const sessions = yield* Sessions
			const user = yield* newUser
			const ended = yield* sessions.create(user)
			const live = yield* sessions.create(user)
			yield* age(ended.sessionId, '8 days')
			yield* sessions.deleteExpired
			const left = yield* owner(
				(sql) =>
					sql`select id from auth_private.sessions where user_id = ${user} order by id`,
			)
			assert.deepStrictEqual(left, [{ id: live.sessionId }])
		}),
	)
})

/** What the feature `auth` grants the visitor, reviewed by hand. */
const approvedSurface = [
	'function auth.current_session_id()',
	'function auth.current_user_id()',
	'function stompbox.feature_versions()',
	'schema auth',
	'schema stompbox',
	'schema public',
]
