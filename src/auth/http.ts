import { Effect, Layer, Option, Redacted } from 'effect'
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder'
import * as HttpApiError from 'effect/http-api/HttpApiError'
import type * as Cookies from 'effect/http/Cookies'
import * as HttpEffect from 'effect/http/HttpEffect'
import * as HttpServerResponse from 'effect/http/HttpServerResponse'
import { isSqlError } from 'effect/sql/SqlError'

// The server's half of `SignedIn`, and the session cookie. Server only.
import { RequestSession, Visitor } from '../visitor/index.ts'
import { CurrentSession, SignedIn } from './api.ts'
import { type CreatedSession, Sessions } from './Sessions.ts'

/**
 * Implements `SignedIn`: validates the session cookie, then runs the
 * endpoint (payload decoding, handler and response encoding) in one
 * `Visitor.run` as the session's user. A typed error from the handler rolls
 * the transaction back and reaches the client with its own status.
 */
export const SignedInLive = Layer.effect(
	SignedIn,
	Effect.gen(function* () {
		const sessions = yield* Sessions
		const visitor = yield* Visitor
		return SignedIn.of({
			session: (httpEffect, { credential }) =>
				sessions.validate(Redacted.value(credential)).pipe(
					Effect.flatMap((found) =>
						Effect.fromOption(found, () => new HttpApiError.Unauthorized({})),
					),
					Effect.flatMap((session) =>
						visitor
							.run(httpEffect.pipe(Effect.provideService(CurrentSession, session)))
							.pipe(
								Effect.provideService(RequestSession, Option.some(session.sessionId)),
							),
					),
					// Only a database error at validate, begin or commit is a defect.
					// The handler's own errors pass through untouched: the API builder
					// turns them into responses after this middleware returns.
					Effect.catchIf(isSqlError, Effect.die),
				),
		})
	}),
)

/**
 * Sets and clears the session cookie from a handler. The name and the
 * attributes come from `SignedIn`'s security scheme, so the cookie the
 * server sets is the one `SignedIn` reads.
 */
export const SessionCookie = {
	/**
	 * Sets the cookie to a new session's token. It expires with the session's
	 * absolute expiry, which `validate` never moves, so no later request
	 * needs to set it again.
	 */
	set: (session: CreatedSession) =>
		HttpApiBuilder.securitySetCookie(SignedIn.security.session, session.token, {
			...attributes,
			expires: session.absoluteExpiresAt,
		}),

	/** Tells the browser to delete the cookie. Same name, path and flags, or the browser keeps it. */
	clear: HttpEffect.appendPreResponseHandler((_request, response) =>
		HttpServerResponse.expireCookie(
			response,
			SignedIn.security.session.key,
			attributes,
		).pipe(Effect.orDie),
	),
}

/** `__Host-` requires `Secure`, `Path=/` and no `Domain`. */
const attributes = {
	path: '/',
	secure: true,
	httpOnly: true,
	sameSite: 'lax',
} satisfies NonNullable<Cookies.Cookie['options']>
