// What the browser and the server share. This module imports only `effect`
// at runtime, so a client bundle can import it without the Postgres driver.
import type { VisitorTransaction } from '@effect-backend/visitor'
import { Context, Schema } from 'effect'
import * as HttpApiError from 'effect/http-api/HttpApiError'
import * as HttpApiMiddleware from 'effect/http-api/HttpApiMiddleware'
import * as HttpApiSecurity from 'effect/http-api/HttpApiSecurity'

/** A live session and the user it belongs to. */
export interface LiveSession {
	readonly sessionId: string
	readonly userId: string
}

/** The signed-in request's session. `SignedIn` provides it. */
export class CurrentSession extends Context.Service<CurrentSession, LiveSession>()(
	'@effect-backend/auth/CurrentSession',
) {}

/**
 * Guards an API group or endpoint: the request must carry a live session in
 * the cookie `__Host-session`, or it gets 401 and the handler does not run.
 * The server's implementation (`SignedInLive` in `@effect-backend/auth/http`)
 * runs the endpoint in one visitor transaction as the signed-in user, and
 * provides `CurrentSession` and `VisitorTransaction` to it.
 */
export class SignedIn extends HttpApiMiddleware.Service<
	SignedIn,
	{ provides: CurrentSession | VisitorTransaction }
>()('@effect-backend/auth/SignedIn', {
	security: {
		// `__Host-`: the browser takes the cookie only when it is `Secure`, has
		// `Path=/` and no `Domain`, so a sibling subdomain cannot set it.
		session: HttpApiSecurity.apiKey({ key: '__Host-session', in: 'cookie' }),
	},
	error: HttpApiError.Unauthorized,
}) {}

/** The user is unknown, has no password, or gave the wrong one. */
export class InvalidCredentials extends Schema.TaggedError<
	InvalidCredentials,
	{ readonly brand: unique symbol }
>()('InvalidCredentials', {}, { httpApiStatus: 401 }) {}

/** Too many failed sign-ins in a short time; the user must wait. */
export class AccountLocked extends Schema.TaggedError<
	AccountLocked,
	{ readonly brand: unique symbol }
>()('AccountLocked', {}, { httpApiStatus: 429 }) {}
