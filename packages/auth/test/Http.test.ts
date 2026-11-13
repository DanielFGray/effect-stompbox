import { deliver, Features } from '@effect-backend/delivery'
import { ApiPool, OwnerPool, Visitor, VisitorTransaction } from '@effect-backend/visitor'
import { BunServices } from '@effect/platform-bun'
import { assert, layer } from '@effect/vitest'
import {
	Config,
	ConfigProvider,
	Context,
	Deferred,
	Effect,
	Layer,
	Option,
	Schema,
} from 'effect'
import * as Digest from 'effect/crypto/Digest'
import * as SecureRandom from 'effect/crypto/SecureRandom'
import * as HttpApi from 'effect/http-api/HttpApi'
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder'
import * as HttpApiEndpoint from 'effect/http-api/HttpApiEndpoint'
import * as HttpApiGroup from 'effect/http-api/HttpApiGroup'
import * as HttpEffect from 'effect/http/HttpEffect'
import * as HttpRouter from 'effect/http/HttpRouter'
import * as HttpServer from 'effect/http/HttpServer'
import * as HttpServerRequest from 'effect/http/HttpServerRequest'
import * as HttpServerResponse from 'effect/http/HttpServerResponse'
import { SqlClient } from 'effect/sql/SqlClient'
import { isSqlError } from 'effect/sql/SqlError'

import {
	AccountLocked,
	CurrentSession,
	InvalidCredentials,
	SignedIn,
} from '../src/api.ts'
import { SessionCookie, SignedInLive } from '../src/http.ts'
import { auth, Passwords, passwords, Sessions } from '../src/index.ts'

// A small API that uses every part of the HTTP entry points: sign-in sets
// the cookie, `SignedIn` guards the private group, sign-out clears it.
class NoSuchThing extends Schema.TaggedError<
	NoSuchThing,
	{ readonly brand: unique symbol }
>()('NoSuchThing', {}, { httpApiStatus: 404 }) {}

const Me = Schema.Struct({ userId: Schema.String, sqlUserId: Schema.String })

class TestApi extends HttpApi.make('test')
	.add(
		HttpApiGroup.make('public').add(
			HttpApiEndpoint.post('signIn', '/sign-in', {
				payload: Schema.Struct({ userId: Schema.String, password: Schema.String }),
				error: [InvalidCredentials, AccountLocked],
			}),
		),
	)
	.add(
		HttpApiGroup.make('private')
			.add(HttpApiEndpoint.get('me', '/me', { success: Me }))
			.add(HttpApiEndpoint.get('missing', '/missing', { error: NoSuchThing }))
			.add(HttpApiEndpoint.post('signOut', '/sign-out'))
			.middleware(SignedIn),
	) {}

const handlers = Layer.mergeAll(
	HttpApiBuilder.group(TestApi, 'public', (h) =>
		Effect.gen(function* () {
			const passwords = yield* Passwords
			return h.handle('signIn', ({ payload }) =>
				passwords
					.signIn(Option.some(payload.userId), payload.password)
					.pipe(
						Effect.flatMap(SessionCookie.set),
						Effect.catchIf(isSqlError, Effect.die),
					),
			)
		}),
	),
	HttpApiBuilder.group(TestApi, 'private', (h) =>
		Effect.gen(function* () {
			const sessions = yield* Sessions
			return h
				.handle('me', () =>
					Effect.gen(function* () {
						const { userId } = yield* CurrentSession
						const { sql } = yield* VisitorTransaction
						const [row] = yield* sql`select auth.current_user_id() as id`.pipe(
							Effect.flatMap(
								Schema.decodeUnknownEffect(
									Schema.Tuple([Schema.Struct({ id: Schema.String })]),
								),
							),
							Effect.orDie,
						)
						return { userId, sqlUserId: row.id }
					}),
				)
				.handle('missing', () => Effect.fail(new NoSuchThing()))
				.handle('signOut', () =>
					CurrentSession.pipe(
						Effect.flatMap(({ sessionId }) => sessions.revoke(sessionId)),
						Effect.andThen(SessionCookie.clear),
						Effect.catchIf(isSqlError, Effect.die),
					),
				)
		}),
	),
)

const app = HttpApiBuilder.layer(TestApi).pipe(
	Layer.provide(handlers),
	Layer.provide(SignedInLive),
)

/** Sends a web `Request` through the app in process and returns the web `Response`. */
class Client extends Context.Service<Client>()('test/Client', {
	make: Effect.gen(function* () {
		const http = yield* HttpRouter.toHttpEffect(app)
		return {
			send: (request: Request) =>
				Effect.gen(function* () {
					const sent = yield* Deferred.make<HttpServerResponse.HttpServerResponse>()
					yield* HttpEffect.toHandled(http, (_request, response) =>
						Deferred.succeed(sent, response),
					).pipe(
						Effect.provideService(
							HttpServerRequest.HttpServerRequest,
							HttpServerRequest.fromWeb(request),
						),
					)
					return HttpServerResponse.toWeb(yield* Deferred.await(sent))
				}),
		}
	}),
}) {
	static readonly layer = Layer.effect(this, this.make)
}

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

// `HttpServer.layerServices` holds a stub file system, so it goes to the
// client only; the feature runner reads migrations through BunServices.
const live = Client.layer.pipe(
	Layer.provide(HttpServer.layerServices),
	Layer.provideMerge(Layer.mergeAll(Visitor.layer, Passwords.layer)),
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

const url = (path: string) => `http://localhost${path}`

const send = (path: string, init?: RequestInit) =>
	Effect.flatMap(Effect.service(Client), (c) => c.send(new Request(url(path), init)))

const withCookie = (cookie: string, method = 'GET') => ({
	method,
	headers: { cookie },
})

const signIn = (userId: string, password: string) =>
	send('/sign-in', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ userId, password }),
	})

/** The `name=value` part of the one `Set-Cookie` header. */
const cookiePair = (response: Response) =>
	response.headers.getSetCookie().map((c) => c.split(';')[0] ?? '')

/** The attributes of the one `Set-Cookie` header, lower-cased, without the value. */
const cookieAttributes = (response: Response) =>
	response.headers
		.getSetCookie()
		.flatMap((c) => c.split(';').slice(1))
		.map((a) => a.trim().toLowerCase())

const user = (password: string) =>
	Effect.flatMap(Effect.service(Passwords), (p) => p.createUser(password))

layer(live, { excludeTestServices: true })('SignedIn and SessionCookie', (it) => {
	it.effect('sign-in sets a __Host- cookie that ends with the absolute expiry', () =>
		Effect.gen(function* () {
			const id = yield* user('correct horse')
			const response = yield* signIn(id, 'correct horse')
			assert.strictEqual(response.status, 204)
			const [pair] = cookiePair(response)
			assert.match(pair ?? '', /^__Host-session=[0-9a-f-]{36}\.[0-9a-f]{64}$/)
			const attributes = cookieAttributes(response)
			for (const expected of ['path=/', 'secure', 'httponly', 'samesite=lax'])
				assert.include(attributes, expected)
			assert.notOk(attributes.some((a) => a.startsWith('domain=')))

			const expires = attributes.find((a) => a.startsWith('expires='))
			const sessionId = (pair ?? '').slice(
				'__Host-session='.length,
				'__Host-session='.length + 36,
			)
			const [row] = yield* Effect.flatMap(Effect.service(OwnerPool), (sql) =>
				sql`select absolute_expires_at from auth_private.sessions where id = ${sessionId}`.pipe(
					Effect.flatMap(
						Schema.decodeUnknownEffect(
							Schema.Tuple([Schema.Struct({ absolute_expires_at: Schema.Date })]),
						),
					),
				),
			)
			// Cookie dates have whole seconds.
			assert.strictEqual(
				new Date(expires?.slice('expires='.length) ?? '').getTime(),
				Math.floor(row.absolute_expires_at.getTime() / 1000) * 1000,
			)
		}),
	)

	it.effect('a wrong password gives 401 and sets no cookie', () =>
		Effect.gen(function* () {
			const id = yield* user('correct horse')
			const response = yield* signIn(id, 'wrong')
			assert.strictEqual(response.status, 401)
			assert.deepStrictEqual(response.headers.getSetCookie(), [])
		}),
	)

	it.effect('runs a private handler as the signed-in user', () =>
		Effect.gen(function* () {
			const id = yield* user('correct horse')
			const [cookie] = cookiePair(yield* signIn(id, 'correct horse'))
			const response = yield* send('/me', withCookie(cookie ?? ''))
			assert.strictEqual(response.status, 200)
			assert.deepStrictEqual(yield* Effect.promise(() => response.json()), {
				userId: id,
				sqlUserId: id,
			})
		}),
	)

	it.effect('refuses a missing, malformed, wrong or ended session with 401', () =>
		Effect.gen(function* () {
			const id = yield* user('correct horse')
			const [cookie] = cookiePair(yield* signIn(id, 'correct horse'))
			const sessionId = (cookie ?? '').slice(
				'__Host-session='.length,
				'__Host-session='.length + 36,
			)
			const wrongSecret = `__Host-session=${sessionId}.${'0'.repeat(64)}`
			assert.strictEqual((yield* send('/me')).status, 401)
			for (const bad of ['__Host-session=nonsense', wrongSecret, 'session=x'])
				assert.strictEqual((yield* send('/me', withCookie(bad))).status, 401)

			yield* Effect.flatMap(Effect.service(Sessions), (s) => s.revokeAll(id))
			assert.strictEqual((yield* send('/me', withCookie(cookie ?? ''))).status, 401)
		}),
	)

	it.effect('a typed handler error keeps its status through SignedIn', () =>
		Effect.gen(function* () {
			const id = yield* user('correct horse')
			const [cookie] = cookiePair(yield* signIn(id, 'correct horse'))
			const response = yield* send('/missing', withCookie(cookie ?? ''))
			assert.strictEqual(response.status, 404)
		}),
	)

	it.effect(
		'sign-out revokes the session and clears the cookie with the same attributes',
		() =>
			Effect.gen(function* () {
				const id = yield* user('correct horse')
				const [cookie] = cookiePair(yield* signIn(id, 'correct horse'))
				const response = yield* send('/sign-out', withCookie(cookie ?? '', 'POST'))
				assert.strictEqual(response.status, 204)
				assert.deepStrictEqual(cookiePair(response), ['__Host-session='])
				const attributes = cookieAttributes(response)
				for (const expected of ['path=/', 'secure', 'httponly', 'samesite=lax'])
					assert.include(attributes, expected)
				assert.ok(attributes.some((a) => a === 'max-age=0' || a.startsWith('expires=')))
				assert.strictEqual((yield* send('/me', withCookie(cookie ?? ''))).status, 401)
			}),
	)
})
