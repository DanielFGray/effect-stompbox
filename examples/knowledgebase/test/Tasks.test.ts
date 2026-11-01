import { TestApp } from '@effect-backend/testing'
import { assert, layer } from '@effect/vitest'
import { Effect } from 'effect'

import { KnowledgebaseApi } from '../src/Api.ts'
import { app } from '../src/App.ts'

// TestApp delivers the features into the test database, starts the app in
// process, and gives each `client` call its own cookie jar, so each client is
// one browser.
layer(TestApp.layer(KnowledgebaseApi, app))('tasks', (it) => {
	it.effect('a user sees only their own tasks', () =>
		Effect.gen(function* () {
			const alice = yield* TestApp.client
			const bob = yield* TestApp.client
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
				(yield* bob.private.listTasks({ query: {} })).map((t) => t.id),
				[],
			)
			const refused = yield* bob.private
				.completeTask({ params: { id: task.id } })
				.pipe(Effect.flip)
			assert.strictEqual(refused._tag, 'TaskNotFound')
		}),
	)
})
