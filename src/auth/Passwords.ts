import { Context, Effect, Layer, Option, Schema } from 'effect'

import { mapSqlState } from '../db/index.ts'
import { OwnerPool } from '../visitor/index.ts'
import { AccountLocked, InvalidCredentials } from './api.ts'
import { decodeRows } from './Rows.ts'
import { Sessions } from './Sessions.ts'

/**
 * Password sign-in over the feature `passwords`, on the owner pool. SQL
 * hashes and checks the password and counts failures; this service creates
 * the session. The password is always a bound parameter, never SQL text.
 */
export class Passwords extends Context.Service<Passwords>()(
	'@danielfgray/stompbox/auth/Passwords',
	{
		make: Effect.gen(function* () {
			const sql = yield* OwnerPool
			const sessions = yield* Sessions

			const set = Effect.fn('Passwords.set')(function* (
				userId: string,
				password: string,
			) {
				yield* sql`select auth_private.set_password(${userId}, ${password})`
			})

			/**
			 * Inserts a user with this password and returns its id. Run it in the
			 * caller's owner transaction with the app's profile insert.
			 */
			const createUser = Effect.fn('Passwords.createUser')(function* (password: string) {
				const [{ id }] =
					yield* sql`insert into auth.users default values returning id`.pipe(
						Effect.flatMap(decodeRows(Schema.Tuple([IdRow]))),
					)
				yield* set(id, password)
				return id
			})

			/**
			 * Checks the password and creates a session. `userId` is none when no
			 * user has the name the user typed. Do not run it inside a transaction
			 * that rolls back on `InvalidCredentials`: the rollback would remove the
			 * failure record, and the lockout would never start.
			 */
			const signIn = Effect.fn('Passwords.signIn')(function* (
				userId: Option.Option<string>,
				password: string,
			) {
				const id = Option.getOrNull(userId)
				const [{ ok }] =
					yield* sql`select auth_private.check_password(${id}, ${password}) as ok`.pipe(
						Effect.flatMap(decodeRows(Schema.Tuple([CheckRow]))),
						mapSqlState({ LOCKD: () => new AccountLocked() }),
					)
				return yield* Option.match(
					Option.filter(userId, () => ok),
					{
						onNone: () => Effect.fail(new InvalidCredentials()),
						onSome: sessions.create,
					},
				)
			})

			return { createUser, set, signIn }
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}

const IdRow = Schema.Struct({ id: Schema.String })
const CheckRow = Schema.Struct({ ok: Schema.Boolean })
