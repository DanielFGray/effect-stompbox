import { InvalidCredentials, Passwords, Sessions } from '@effect-backend/auth'
import { mapSqlState, OwnerPool, ownerDb, visitorDb } from '@effect-backend/visitor'
import { Context, Effect, Layer, Option } from 'effect'

import { Account, UsernameTaken } from './Api.ts'
import type { OwnerTables, VisitorTables } from './generated/visitor.ts'

const owner = ownerDb<OwnerTables>()
const visitor = visitorDb<VisitorTables>()

/**
 * Accounts are the app's profile rows over `auth.users`. The app owns the
 * username; the auth package owns users, password hashes and sessions.
 */
export class Accounts extends Context.Service<Accounts>()('knowledgebase/Accounts', {
	make: Effect.gen(function* () {
		const passwords = yield* Passwords
		const sessions = yield* Sessions
		// Owner queries take the pool here, so no caller needs `OwnerPool`.
		const pool = yield* OwnerPool

		/**
		 * Creates the user, its password, its profile and a session in one owner
		 * transaction, so a taken username leaves no user behind.
		 */
		const register = Effect.fn('Accounts.register')(
			function* (username: string, password: string) {
				const userId = yield* passwords.createUser(password)
				const account = yield* owner.one(Account, (k) =>
					k
						.insertInto('app_public.accounts')
						.values({ id: userId, username })
						.returning(['id', 'username']),
				)
				const session = yield* sessions.create(userId)
				return { account, session }
			},
			owner.withTransaction,
			mapSqlState({ '23505': () => new UsernameTaken() }),
			Effect.provideService(OwnerPool, pool),
		)

		/**
		 * Finds the user by username in the app's own table, then lets the auth
		 * package check the password. An unknown username costs the same hash
		 * and gives the same error as a wrong password. Not in a transaction:
		 * a failed attempt must commit, or the lockout never starts.
		 */
		const signIn = Effect.fn('Accounts.signIn')(
			function* (username: string, password: string) {
				const account = yield* owner.maybe(Account, (k) =>
					k
						.selectFrom('app_public.accounts')
						.select(['id', 'username'])
						.where('username', '=', username),
				)
				const session = yield* passwords.signIn(
					Option.map(account, (a) => a.id),
					password,
				)
				return {
					account: yield* Effect.fromOption(account, () => new InvalidCredentials()),
					session,
				}
			},
			mapSqlState({}),
			Effect.provideService(OwnerPool, pool),
		)

		/** The signed-in user's own row; the `select_own` policy hides every other. */
		const me = visitor
			.one(Account, (k) => k.selectFrom('app_public.accounts').select(['id', 'username']))
			.pipe(mapSqlState({}))

		return { register, signIn, me }
	}),
}) {
	static readonly layer = Layer.effect(this, this.make)
}
