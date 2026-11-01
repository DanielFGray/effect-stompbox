import { Passwords, Sessions, UserDirectory } from '@effect-backend/auth'
import { mapSqlState, OwnerDb, VisitorDb } from '@effect-backend/visitor'
import { Context, Effect, Layer, Option } from 'effect'

import { UsernameTaken } from './Api.ts'
import type { OwnerTables, VisitorTables } from './generated/visitor.ts'

/**
 * Accounts are the app's profile rows over `auth.users`. The app owns the
 * username; the auth package owns users, password hashes and sessions.
 */
export class Accounts extends Context.Service<Accounts>()('knowledgebase/Accounts', {
	make: Effect.gen(function* () {
		const owner = yield* OwnerDb.of<OwnerTables>()
		const visitor = yield* VisitorDb.of<VisitorTables>()
		const passwords = yield* Passwords
		const sessions = yield* Sessions

		/** Creates the user, its password and its profile in one transaction, and signs it in. */
		const register = Effect.fn('Accounts.register')(
			function* (username: string, password: string) {
				const userId = yield* passwords.createUser(password)
				const account = yield* owner
					.insertInto('app_public.accounts')
					.values({ id: userId, username })
					.returning(['id', 'username'])
					.pipe(Effect.head, Effect.orDie)
				const session = yield* sessions.create(userId)
				return { account, session }
			},
			owner.withTransaction,
			mapSqlState({ '23505': () => new UsernameTaken() }),
		)

		/**
		 * Checks the password through the auth package, which finds the user with
		 * `AccountDirectory` below, then reads the profile.
		 */
		const signIn = Effect.fn('Accounts.signIn')(function* (
			username: string,
			password: string,
		) {
			const session = yield* passwords.signIn(username, password)
			const account = yield* owner
				.selectFrom('app_public.accounts')
				.select(['id', 'username'])
				.where('id', '=', session.userId)
				.pipe(Effect.head, Effect.orDie)
			return { account, session }
		})

		/** The signed-in user's own row; the `select_own` policy hides every other. */
		const me = visitor
			.selectFrom('app_public.accounts')
			.select(['id', 'username'])
			.pipe(Effect.head, Effect.orDie)

		return { register, signIn, me }
	}),
}) {
	static readonly layer = Layer.effect(this, this.make)
}

/**
 * How password sign-in finds a user: by username, in the app's own table.
 * The auth package calls it, then checks the password against the user's
 * hash, so an unknown username and a wrong password take the same time and
 * give the same error.
 */
export const AccountDirectory = Layer.effect(
	UserDirectory,
	Effect.gen(function* () {
		const owner = yield* OwnerDb.of<OwnerTables>()
		return {
			find: (username: string) =>
				owner
					.selectFrom('app_public.accounts')
					.select('id')
					.where('username', '=', username)
					.pipe(
						Effect.head,
						Effect.catchNoSuchElement,
						Effect.map(Option.map((row) => row.id)),
					),
		}
	}),
)
