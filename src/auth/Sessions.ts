import { Config, Context, Duration, Effect, Layer, Option, Result, Schema } from 'effect'
import * as Digest from 'effect/crypto/Digest'
import * as SecureRandom from 'effect/crypto/SecureRandom'
import * as Hex from 'effect/encoding/Hex'

import { OwnerPool } from '../visitor/index.ts'
import type { LiveSession } from './api.ts'
import { decodeRows } from './Rows.ts'

/**
 * A new session: the token for the browser, when the session ends unless used
 * (`expiresAt`), and when it ends even if used (`absoluteExpiresAt`).
 */
export interface CreatedSession {
	readonly sessionId: string
	readonly token: string
	readonly expiresAt: Date
	readonly absoluteExpiresAt: Date
}

/**
 * Creates, validates and revokes sessions on the owner pool. The browser holds
 * the token `<session id>.<secret>`; the database holds only the SHA-256 hash
 * of the secret. `validate` is the one way from a token to a session id, and
 * the visitor transaction sets `my.session_id` only from its result.
 */
export class Sessions extends Context.Service<Sessions>()(
	'@danielfgray/stompbox/auth/Sessions',
	{
		make: Effect.gen(function* () {
			const sql = yield* OwnerPool
			const random = yield* SecureRandom.SecureRandom
			const digest = yield* Digest.Digest
			const lifetimes = yield* sessionLifetimes
			const idle = Duration.toSeconds(lifetimes.idle)
			const absolute = Duration.toSeconds(lifetimes.absolute)
			const refresh = Duration.toSeconds(lifetimes.refresh)
			const hash = (secret: Uint8Array) => digest.digest(Digest.sha256, secret)

			const create = Effect.fn('Sessions.create')(function* (userId: string) {
				const secret = yield* random.randomBytes(secretBytes)
				const secretHash = yield* hash(secret)
				const [row] = yield* sql`
        insert into auth_private.sessions (user_id, secret_hash, expires_at, absolute_expires_at)
        values (${userId}, ${secretHash},
                now() + least(${idle}::float8, ${absolute}::float8) * interval '1 second',
                now() + ${absolute}::float8 * interval '1 second')
        returning id, expires_at, absolute_expires_at`.pipe(
					Effect.flatMap(decodeRows(Schema.Tuple([CreatedRow]))),
				)
				return {
					sessionId: row.id,
					token: `${row.id}.${Hex.encode(secret)}`,
					expiresAt: row.expires_at,
					absoluteExpiresAt: row.absolute_expires_at,
				} satisfies CreatedSession
			})

			const validate = Effect.fn('Sessions.validate')(function* (token: string) {
				const parts = parseToken(token)
				if (Option.isNone(parts)) return Option.none<LiveSession>()
				const secretHash = yield* hash(parts.value.secret)
				// One statement, so a concurrent revoke either commits first (no row
				// matches) or after (the session was live when this request began).
				// The expiry only moves forward, and never past the absolute expiry.
				const rows = yield* sql`
        with live as (
          select id, user_id, refreshed_at from auth_private.sessions
          where id = ${parts.value.id} and secret_hash = ${secretHash} and expires_at > now()
        ), refreshed as (
          update auth_private.sessions s
          set refreshed_at = now(),
              expires_at = greatest(s.expires_at,
                least(now() + ${idle}::float8 * interval '1 second', s.absolute_expires_at))
          from live
          where s.id = live.id and s.expires_at > now()
            and live.refreshed_at <= now() - ${refresh}::float8 * interval '1 second'
        )
        select id, user_id from live`.pipe(
					Effect.flatMap(decodeRows(Schema.Array(SessionRow))),
				)
				return Option.map(Option.fromNullishOr(rows[0]), (row): LiveSession => ({
					sessionId: row.id,
					userId: row.user_id,
				}))
			})

			const revoke = Effect.fn('Sessions.revoke')(function* (sessionId: string) {
				yield* sql`delete from auth_private.sessions where id = ${sessionId}`
			})

			const revokeAll = Effect.fn('Sessions.revokeAll')(function* (userId: string) {
				yield* sql`delete from auth_private.sessions where user_id = ${userId}`
			})

			/** Deletes sessions that have ended. The app's worker runs it on a schedule. */
			const deleteExpired =
				sql`delete from auth_private.sessions where expires_at <= now()`.pipe(
					Effect.asVoid,
					Effect.withSpan('Sessions.deleteExpired'),
				)

			return { create, validate, revoke, revokeAll, deleteExpired }
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}

/** The session lifetimes in `Config` cannot work together. */
export class SessionLifetimesInvalid extends Schema.TaggedError<
	SessionLifetimesInvalid,
	{ readonly brand: unique symbol }
>()('SessionLifetimesInvalid', { reason: Schema.String }) {}

/**
 * How long a session lives: `idle` after its last use, `absolute` after its
 * creation, and how often a use moves the idle expiry (`refresh`). A change
 * applies to later refreshes; a session keeps the absolute expiry it was
 * created with.
 */
const sessionLifetimes = Effect.gen(function* () {
	const lifetimes = yield* Config.all({
		idle: Config.Duration('SESSION_IDLE_LIFETIME').pipe(
			Config.withDefault(Duration.days(7)),
		),
		absolute: Config.Duration('SESSION_ABSOLUTE_LIFETIME').pipe(
			Config.withDefault(Duration.days(30)),
		),
		refresh: Config.Duration('SESSION_REFRESH_INTERVAL').pipe(
			Config.withDefault(Duration.hours(1)),
		),
	})
	const notPositive = Object.entries(lifetimes).filter(
		([, d]) => !Duration.isGreaterThan(d, Duration.zero),
	)
	if (notPositive.length > 0)
		return yield* new SessionLifetimesInvalid({
			reason: `not positive: ${notPositive.map(([name]) => name).join(', ')}`,
		})
	if (!Duration.isLessThan(lifetimes.refresh, lifetimes.idle))
		return yield* new SessionLifetimesInvalid({
			reason: 'the refresh interval must be shorter than the idle lifetime',
		})
	return lifetimes
})

const secretBytes = 32

/** Splits `<uuid>.<64 hex digits>` into the session id and the secret bytes. */
const parseToken = (token: string) =>
	Option.flatMap(Option.fromNullishOr(tokenPattern.exec(token)), (match) =>
		Option.flatMap(
			Option.all([Option.fromNullishOr(match[1]), Option.fromNullishOr(match[2])]),
			([id, hex]) =>
				Option.map(Result.getSuccess(Hex.decode(hex)), (secret) => ({ id, secret })),
		),
	)

const tokenPattern =
	/^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([0-9a-f]{64})$/

const SessionRow = Schema.Struct({ id: Schema.String, user_id: Schema.String })

const CreatedRow = Schema.Struct({
	id: Schema.String,
	expires_at: Schema.Date,
	absolute_expires_at: Schema.Date,
})
