import {
	c1,
	c2,
	c3,
	c4,
	c5,
	c6,
	c7,
	c8,
	Finding,
	roleContract,
	visitorReach,
} from '@effect-backend/checker'
import { deliver, type Feature } from '@effect-backend/delivery'
import { OwnerPool } from '@effect-backend/visitor'
import { BunServices } from '@effect/platform-bun'
import { Context, Deferred, Effect, Layer, Ref, Schema, type Scope } from 'effect'
import * as Digest from 'effect/crypto/Digest'
import type * as HttpApi from 'effect/http-api/HttpApi'
import * as HttpApiClient from 'effect/http-api/HttpApiClient'
import type * as HttpApiGroup from 'effect/http-api/HttpApiGroup'
import type * as Cookies from 'effect/http/Cookies'
import * as HttpClient from 'effect/http/HttpClient'
import * as HttpClientRequest from 'effect/http/HttpClientRequest'
import type * as HttpClientResponse from 'effect/http/HttpClientResponse'
import * as HttpEffect from 'effect/http/HttpEffect'
import * as HttpRouter from 'effect/http/HttpRouter'
import * as HttpServer from 'effect/http/HttpServer'
import * as HttpServerRequest from 'effect/http/HttpServerRequest'
import { isRespondable, toResponse } from 'effect/http/HttpServerRespondable'
import * as HttpServerResponse from 'effect/http/HttpServerResponse'
import { SqlClient } from 'effect/sql/SqlClient'

/**
 * An app running in process on a test database. `TestApp.layer` builds it;
 * `TestApp.client` gives a typed client that acts as one browser.
 */
export class TestApp extends Context.Service<
	TestApp,
	{
		/**
		 * Sends one request to the app in process and returns its response. An
		 * error or defect in the app becomes a response, as a server would send.
		 */
		readonly send: (
			request: HttpClientRequest.HttpClientRequest,
		) => Effect.Effect<HttpClientResponse.HttpClientResponse>
	}
>()('@effect-backend/testing/TestApp') {
	/**
	 * Resets the test database, delivers `features`, runs the checker, then
	 * builds `app` (an `HttpApiBuilder.layer` with its handlers and database
	 * layers) behind an in-process router.
	 *
	 * - Reset refuses a database whose name does not end in `_test`
	 *   (`NotATestDatabase`), then drops every schema the owner role owns
	 *   except `public`. Extensions the host created stay.
	 * - The checks are C1 to C8, with `surface` as the visitor surface the
	 *   app approves for C3 (one line per object, as `visitorReach` prints
	 *   it). Any error fails the layer with `TestDatabaseUnsafe`.
	 *
	 * The layer also provides the owner pool, for tests that read what a
	 * request left in the database.
	 */
	static layer<A, E, R>(
		app: Layer.Layer<A, E, R>,
		options: {
			readonly features: ReadonlyArray<Feature>
			readonly surface: ReadonlyArray<string>
		},
	) {
		// `Layer.provide` builds its argument first: the database is reset and
		// checked before the app's startup check reads it.
		const prepared = Layer.effectDiscard(
			Effect.flatMap(Effect.service(OwnerPool), (owner) =>
				prepare(options).pipe(Effect.provideService(SqlClient, owner)),
			),
		)
		const served = app.pipe(
			Layer.provide(HttpServer.layerServices),
			Layer.provideMerge(HttpRouter.layer),
		)
		return Layer.effect(
			TestApp,
			Effect.map(Effect.service(HttpRouter.HttpRouter), (router) => ({
				send: sender(
					// The router types its errors as `unknown`. The API builder has already
					// turned handler errors into responses, so what is left answers as
					// itself (a missing route is a 404) or is a defect.
					Effect.catch(router.asHttpEffect(), (error) =>
						isRespondable(error) ? toResponse(error) : Effect.die(error),
					),
				),
			})),
		).pipe(
			Layer.provide(served),
			Layer.provide(prepared),
			Layer.provideMerge(OwnerPool.layer),
			Layer.provide(Layer.mergeAll(BunServices.layer, Digest.layerWebCrypto)),
		)
	}

	/**
	 * A typed client for `api` with its own cookie jar, so each call gives
	 * one browser. Requests go to the app in process; nothing listens on a
	 * port. A defect in the app reaches the client as a 500 response.
	 */
	static client<ApiId extends string, Groups extends HttpApiGroup.Constraint>(
		api: HttpApi.HttpApi<ApiId, Groups>,
	) {
		return Effect.gen(function* () {
			const { send } = yield* TestApp
			const jar = yield* Ref.make<ReadonlyArray<Cookies.Cookie>>([])
			// The base URL goes on before the jar: the jar matches cookies against
			// the request URL, and `makeWith`'s own `baseUrl` is applied after it,
			// so the jar would see a relative path and send nothing. https, so
			// the jar sends the app's `Secure` cookies back.
			const transport = HttpClient.make(send).pipe(
				HttpClient.mapRequest(HttpClientRequest.prependUrl('https://localhost')),
				HttpClient.withCookiesRef(jar),
			)
			return yield* HttpApiClient.makeWith(api, { httpClient: transport })
		})
	}
}

/**
 * Answers each client request with `http`, the way a server does: an error
 * or defect becomes a response, and pre-response handlers (cookies) run.
 */
const sender =
	(
		http: Effect.Effect<
			HttpServerResponse.HttpServerResponse,
			never,
			HttpServerRequest.HttpServerRequest | Scope.Scope
		>,
	) =>
	(request: HttpClientRequest.HttpClientRequest) =>
		Effect.gen(function* () {
			const sent = yield* Deferred.make<HttpServerResponse.HttpServerResponse>()
			yield* HttpEffect.toHandled(http, (_request, response) =>
				Deferred.succeed(sent, response),
			).pipe(
				Effect.provideService(
					HttpServerRequest.HttpServerRequest,
					HttpServerRequest.fromClientRequest(request),
				),
			)
			return HttpServerResponse.toClientResponse(yield* Deferred.await(sent), {
				request,
			})
		})

/** The test database's name does not end in `_test`, so `TestApp` does not reset it. */
export class NotATestDatabase extends Schema.TaggedError<
	NotATestDatabase,
	{ readonly brand: unique symbol }
>()('NotATestDatabase', { database: Schema.String }) {}

/** The checker found errors in the delivered database. */
export class TestDatabaseUnsafe extends Schema.TaggedError<
	TestDatabaseUnsafe,
	{ readonly brand: unique symbol }
>()('TestDatabaseUnsafe', { findings: Schema.Array(Finding) }) {}

/** Resets, delivers and checks, on the owner pool given as `SqlClient`. */
const prepare = Effect.fnUntraced(function* (options: {
	readonly features: ReadonlyArray<Feature>
	readonly surface: ReadonlyArray<string>
}) {
	const sql = yield* SqlClient
	const [{ database }] = yield* sql`select current_database() as database`.pipe(
		Effect.flatMap(Schema.decodeUnknownEffect(Schema.Tuple([DatabaseRow]))),
		Effect.orDie,
	)
	if (!database.endsWith('_test')) return yield* new NotATestDatabase({ database })

	const roles = yield* roleContract
	const drops = yield* sql`
    select format('drop schema %I cascade', n.nspname) as statement
    from pg_namespace n join pg_roles r on r.oid = n.nspowner
    where r.rolname = ${roles.owner} and n.nspname <> 'public'`.pipe(
		Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(StatementRow))),
		Effect.orDie,
	)
	yield* Effect.forEach(drops, ({ statement }) => sql.unsafe(statement), {
		discard: true,
	})
	yield* deliver(options.features)

	const reach = yield* visitorReach(roles)
	const findings = [
		...(yield* c1(roles)),
		...(yield* c2(roles)),
		...c3(reach, options.surface),
		...(yield* c4(roles)),
		...(yield* c5(roles)),
		...(yield* c6(roles)),
		...(yield* c7(roles)),
		...(yield* c8(roles)),
	].filter((f) => f.level === 'error')
	if (findings.length > 0) return yield* new TestDatabaseUnsafe({ findings })
})

const DatabaseRow = Schema.Struct({ database: Schema.String })
const StatementRow = Schema.Struct({ statement: Schema.String })
