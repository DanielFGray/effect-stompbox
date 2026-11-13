import { TestApp } from '@effect-backend/testing'
import { OwnerPool } from '@effect-backend/visitor'
import { assert, layer } from '@effect/vitest'
import { ConfigProvider, Effect, Layer, Schema } from 'effect'

import { KnowledgebaseApi } from '../src/Api.ts'
import { app } from '../src/App.ts'
import { features } from '../src/Feature.ts'

// What the visitor may reach once every feature is delivered. Written from a
// reviewed database; a change to it is a security review (check C3).
const surface = [
	'column app_public.tasks.completed_at UPDATE',
	'column app_public.tasks.due_date INSERT,UPDATE',
	'column app_public.tasks.status UPDATE',
	'column app_public.tasks.title INSERT,UPDATE',
	// The host creates citext in `public`; its functions only compare text.
	'extension citext 1.6 in public',
	'function auth.current_session_id()',
	'function auth.current_user_id()',
	'function stompbox.feature_versions()',
	'schema app_public',
	'schema auth',
	'schema stompbox',
	'schema public',
	'table app_public.accounts SELECT',
	'table app_public.tasks DELETE,SELECT',
]

// The cartridge writes the test database's URLs as KNOWLEDGEBASE_*.
const settings = ConfigProvider.layer(
	ConfigProvider.fromEnv().pipe(ConfigProvider.nested('KNOWLEDGEBASE')),
)

const live = TestApp.layer(app, { features, surface }).pipe(Layer.provide(settings))

const client = TestApp.client(KnowledgebaseApi)

const userCount = Effect.flatMap(
	Effect.service(OwnerPool),
	(sql) => sql`select count(*)::int as n from auth.users`,
).pipe(
	Effect.flatMap(
		Schema.decodeUnknownEffect(Schema.Tuple([Schema.Struct({ n: Schema.Finite })])),
	),
	Effect.map(([row]) => row.n),
)

layer(live, { excludeTestServices: true })('knowledgebase', (it) => {
	it.effect('a user sees only their own tasks', () =>
		Effect.gen(function* () {
			const alice = yield* client
			const bob = yield* client
			yield* alice.public.register({
				payload: { username: 'alice', password: 'correct horse' },
			})
			yield* bob.public.register({
				payload: { username: 'bob', password: 'battery staple' },
			})

			const task = yield* alice.private.createTask({
				payload: { title: 'a', due_date: null },
			})

			assert.deepStrictEqual(
				(yield* alice.private.listTasks({ query: {} })).map((t) => t.id),
				[task.id],
			)
			assert.deepStrictEqual(yield* bob.private.listTasks({ query: {} }), [])
			const refused = yield* bob.private
				.completeTask({ params: { id: task.id } })
				.pipe(Effect.flip)
			assert.strictEqual(refused._tag, 'TaskNotFound')
			assert.strictEqual((yield* bob.private.me()).username, 'bob')
		}),
	)

	it.effect('a taken username gives 409 and leaves no user behind', () =>
		Effect.gen(function* () {
			const first = yield* client
			yield* first.public.register({
				payload: { username: 'carol', password: 'correct horse' },
			})
			const before = yield* userCount

			// citext: the name is taken whatever its case.
			const second = yield* client
			const refused = yield* second.public
				.register({ payload: { username: 'CAROL', password: 'battery staple' } })
				.pipe(Effect.flip)
			assert.strictEqual(refused._tag, 'UsernameTaken')
			assert.strictEqual(yield* userCount, before)
		}),
	)

	it.effect('signs out, refuses a wrong password, and signs in again', () =>
		Effect.gen(function* () {
			const browser = yield* client
			yield* browser.public.register({
				payload: { username: 'dave', password: 'correct horse' },
			})
			yield* browser.private.signOut()
			const signedOut = yield* browser.private.me().pipe(Effect.flip)
			assert.strictEqual(signedOut._tag, 'Unauthorized')

			for (const [username, password] of [
				['dave', 'wrong password'],
				['nobody', 'correct horse'],
			] satisfies ReadonlyArray<readonly [string, string]>) {
				const refused = yield* browser.public
					.signIn({ payload: { username, password } })
					.pipe(Effect.flip)
				assert.strictEqual(refused._tag, 'InvalidCredentials')
			}

			yield* browser.public.signIn({
				payload: { username: 'dave', password: 'correct horse' },
			})
			assert.strictEqual((yield* browser.private.me()).username, 'dave')
		}),
	)
})
