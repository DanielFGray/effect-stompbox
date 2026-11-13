import { BunServices } from '@effect/platform-bun'
import { assert, layer } from '@effect/vitest'
import { Config, ConfigProvider, Effect, Layer, Option, Schema } from 'effect'
import * as Digest from 'effect/crypto/Digest'
import * as SecureRandom from 'effect/crypto/SecureRandom'
import { SqlClient } from 'effect/sql/SqlClient'

import { auth, Passwords, passwords, Sessions } from '../../src/auth/index.ts'
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
import { deliver, Features } from '../../src/delivery/index.ts'
import {
	ApiPool,
	OwnerPool,
	RequestSession,
	Visitor,
	VisitorTransaction,
} from '../../src/visitor/index.ts'

// The test database is declared in cartridge.json (`ops dev db up`), with
// pgsodium, which the host creates. The suite installs the features `auth`
// and `passwords` once, on a database without them.
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
		yield* deliver([auth, passwords]).pipe(Effect.provideService(SqlClient, sql))
	}),
)

const live = Layer.mergeAll(Visitor.layer, Passwords.layer).pipe(
	Layer.provideMerge(Sessions.layer),
	Layer.provideMerge(Layer.mergeAll(install, Layer.succeed(Features, [auth, passwords]))),
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

const owner = <A, E>(f: (sql: SqlClient) => Effect.Effect<A, E>) =>
	Effect.flatMap(Effect.service(OwnerPool), f)

/** A new user with this password, committed. */
const userWith = (password: string) =>
	Effect.flatMap(Effect.service(Passwords), (p) => p.createUser(password))

const signIn = (userId: Option.Option<string>, password: string) =>
	Effect.flatMap(Effect.service(Passwords), (p) => p.signIn(userId, password))

/** The reason a sign-in failed, by tag. */
const refusal = (userId: Option.Option<string>, password: string) =>
	signIn(userId, password).pipe(
		Effect.flip,
		Effect.map((e) => e._tag),
	)

const failedAttempts = (userId: string) =>
	owner((sql) =>
		sql`select failed_attempts from auth_private.passwords where user_id = ${userId}`.pipe(
			Effect.flatMap(
				Schema.decodeUnknownEffect(
					Schema.Tuple([Schema.Struct({ failed_attempts: Schema.Finite })]),
				),
			),
			Effect.map(([row]) => row.failed_attempts),
		),
	)

layer(live, { excludeTestServices: true })('Passwords', (it) => {
	it.effect('signs in with the right password, and the session belongs to the user', () =>
		Effect.gen(function* () {
			const sessions = yield* Sessions
			const user = yield* userWith('correct horse')
			const session = yield* signIn(Option.some(user), 'correct horse')
			assert.deepStrictEqual(
				yield* sessions.validate(session.token),
				Option.some({ sessionId: session.sessionId, userId: user }),
			)
			const [row] = yield* owner(
				(sql) =>
					sql`select user_id, octet_length(hash) as length, left(convert_from(rtrim(hash, '\\x00'::bytea), 'UTF8'), 10) as prefix
					    from auth_private.passwords where user_id = ${user}`,
			).pipe(
				Effect.flatMap(
					Schema.decodeUnknownEffect(
						Schema.Tuple([
							Schema.Struct({
								user_id: Schema.String,
								length: Schema.Finite,
								prefix: Schema.String,
							}),
						]),
					),
				),
			)
			assert.deepStrictEqual(row, { user_id: user, length: 128, prefix: '$argon2id$' })
		}),
	)

	it.effect(
		'refuses a wrong password, an unknown user, and a user with no password',
		() =>
			Effect.gen(function* () {
				const user = yield* userWith('correct horse')
				const noPassword = yield* owner((sql) =>
					sql`insert into auth.users default values returning id`.pipe(
						Effect.flatMap(
							Schema.decodeUnknownEffect(
								Schema.Tuple([Schema.Struct({ id: Schema.String })]),
							),
						),
						Effect.map(([{ id }]) => id),
					),
				)
				assert.strictEqual(
					yield* refusal(Option.some(user), 'wrong'),
					'InvalidCredentials',
				)
				assert.strictEqual(
					yield* refusal(Option.none(), 'correct horse'),
					'InvalidCredentials',
				)
				assert.strictEqual(
					yield* refusal(Option.some(noPassword), 'correct horse'),
					'InvalidCredentials',
				)
			}),
	)

	it.effect(
		'locks after 3 failures in 5 minutes, and unlocks when the window passes',
		() =>
			Effect.gen(function* () {
				const user = yield* userWith('correct horse')
				for (let i = 1; i <= 3; i++) {
					assert.strictEqual(
						yield* refusal(Option.some(user), 'wrong'),
						'InvalidCredentials',
					)
					// Each failure commits, so it survives the failed sign-in.
					assert.strictEqual(yield* failedAttempts(user), i)
				}
				assert.strictEqual(
					yield* refusal(Option.some(user), 'correct horse'),
					'AccountLocked',
				)

				yield* owner(
					(sql) => sql`update auth_private.passwords
				             set first_failed_at = first_failed_at - interval '6 minutes'
				             where user_id = ${user}`,
				)
				yield* signIn(Option.some(user), 'correct horse')
				assert.strictEqual(yield* failedAttempts(user), 0)
			}),
	)

	it.effect('replaces a password', () =>
		Effect.gen(function* () {
			const passwords = yield* Passwords
			const user = yield* userWith('correct horse')
			yield* passwords.set(user, 'battery staple')
			assert.strictEqual(
				yield* refusal(Option.some(user), 'correct horse'),
				'InvalidCredentials',
			)
			yield* signIn(Option.some(user), 'battery staple')
		}),
	)

	it.effect('denies the visitor the passwords table and functions', () =>
		Effect.gen(function* () {
			const visitor = yield* Visitor
			const denied = (statement: string) =>
				visitor
					.run(
						Effect.flatMap(Effect.service(VisitorTransaction), ({ sql }) =>
							sql.unsafe(statement),
						),
					)
					.pipe(
						Effect.provideService(RequestSession, Option.none()),
						Effect.flip,
						Effect.map((error) => Option.map(error.report, ({ code }) => code)),
					)
			assert.deepStrictEqual(
				yield* denied('select 1 from auth_private.passwords'),
				Option.some('42501'),
			)
			assert.deepStrictEqual(
				yield* denied(`select auth_private.check_password(gen_random_uuid(), 'x')`),
				Option.some('42501'),
			)
		}),
	)

	it.effect('passes C3 to C8 with the features installed', () =>
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

// The feature `passwords` adds nothing the visitor can reach.
const approvedSurface = [
	'function auth.current_session_id()',
	'function auth.current_user_id()',
	'function stompbox.feature_versions()',
	'schema auth',
	'schema stompbox',
	'schema public',
]
