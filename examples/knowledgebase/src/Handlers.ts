import { CurrentSession, Sessions } from '@danielfgray/stompbox/auth'
import { SessionCookie } from '@danielfgray/stompbox/auth/http'
import { Effect, Layer, Option } from 'effect'
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder'

import { Accounts } from './Accounts.ts'
import { KnowledgebaseApi } from './Api.ts'
import { Tasks } from './Tasks.ts'

const Public = HttpApiBuilder.group(KnowledgebaseApi, 'public', (handlers) =>
	Effect.gen(function* () {
		const accounts = yield* Accounts
		return (
			handlers
				.handle('register', ({ payload }) =>
					accounts.register(payload.username, payload.password).pipe(
						Effect.tap(({ session }) => SessionCookie.set(session)),
						Effect.map(({ account }) => account),
					),
				)
				// A sign-in always makes a new session, never reuses the one the
				// browser sent (session fixation).
				.handle('signIn', ({ payload }) =>
					accounts.signIn(payload.username, payload.password).pipe(
						Effect.tap(({ session }) => SessionCookie.set(session)),
						Effect.map(({ account }) => account),
					),
				)
		)
	}),
)

// SignedIn runs every handler of this group in one visitor transaction, as
// the signed-in user.
const Private = HttpApiBuilder.group(KnowledgebaseApi, 'private', (handlers) =>
	Effect.gen(function* () {
		const accounts = yield* Accounts
		const sessions = yield* Sessions
		const tasks = yield* Tasks
		return handlers
			.handle('signOut', () =>
				CurrentSession.pipe(
					Effect.flatMap(({ sessionId }) => sessions.revoke(sessionId)),
					Effect.andThen(SessionCookie.clear),
				),
			)
			.handle('me', () => accounts.me)
			.handle('listTasks', ({ query }) => tasks.list(Option.fromNullishOr(query.status)))
			.handle('createTask', ({ payload }) =>
				tasks.create(payload.title, payload.due_date),
			)
			.handle('completeTask', ({ params }) => tasks.complete(params.id))
	}),
)

export const handlers = Layer.mergeAll(Public, Private).pipe(
	Layer.provide(Layer.mergeAll(Accounts.layer, Tasks.layer)),
)
