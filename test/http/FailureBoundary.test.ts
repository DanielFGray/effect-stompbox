import { BunHttpServer } from '@effect/platform-bun'
import { assert, layer } from '@effect/vitest'
import { Effect, Layer, Option, Schema } from 'effect'
import * as HttpApi from 'effect/http-api/HttpApi'
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder'
import * as HttpApiClient from 'effect/http-api/HttpApiClient'
import * as HttpApiEndpoint from 'effect/http-api/HttpApiEndpoint'
import * as HttpApiGroup from 'effect/http-api/HttpApiGroup'
import * as HttpApiMiddleware from 'effect/http-api/HttpApiMiddleware'
import * as FetchHttpClient from 'effect/http/FetchHttpClient'
import * as HttpRouter from 'effect/http/HttpRouter'
import * as HttpServer from 'effect/http/HttpServer'

import { DatabaseError } from '../../src/db/index.ts'
import {
	boundaryErrors,
	Forbidden,
	InternalError,
	InvalidOperation,
} from '../../src/http/index.ts'
import { DatabaseAnswers, FailureBoundaryLayer } from '../../src/http/server/index.ts'

// An app's own refusal and its boundary tag, as the design shows them.
class SlugTaken extends Schema.TaggedError<
	SlugTaken,
	{ readonly brand: unique symbol }
>()('SlugTaken', { message: Schema.String }, { httpApiStatus: 409 }) {}

class FailureBoundary extends HttpApiMiddleware.Service<FailureBoundary>()(
	'test/FailureBoundary',
	{ error: [...boundaryErrors, SlugTaken] },
) {}

class Api extends HttpApi.make('test').add(
	HttpApiGroup.make('things')
		.add(HttpApiEndpoint.post('claimSlug', '/claim-slug'))
		.add(HttpApiEndpoint.post('denied', '/denied'))
		.add(
			HttpApiEndpoint.post('create', '/create', {
				payload: Schema.Struct({ name: Schema.String }),
			}),
		)
		.add(HttpApiEndpoint.post('boom', '/boom'))
		.middleware(FailureBoundary),
) {}

const toHttpError = DatabaseAnswers.make({
	codes: {},
	constraints: {
		bands_slug_key: new SlugTaken({ message: 'That slug is already in use.' }),
	},
})

const refused = (code: string, constraint: Option.Option<string>) =>
	new DatabaseError({
		message: `[${code}] raw postgres text`,
		report: Option.some({
			code,
			message: 'raw postgres text',
			detail: Option.none(),
			hint: Option.none(),
			constraint,
		}),
		cause: undefined,
	})

const handlers = HttpApiBuilder.group(Api, 'things', (h) =>
	Effect.succeed(
		h
			.handle('claimSlug', () =>
				Effect.fail(refused('23505', Option.some('bands_slug_key'))),
			)
			.handle('denied', () => Effect.fail(refused('42501', Option.none())))
			.handle('create', () => Effect.void)
			.handle('boom', () => Effect.die(new Error('connection string postgres://secret'))),
	),
)

const app = HttpApiBuilder.layer(Api).pipe(
	Layer.provide(handlers),
	Layer.provide(FailureBoundaryLayer.make(FailureBoundary, toHttpError)),
)

// A tag that does not list `Forbidden` cannot take a `toHttpError` that raises it.
class SmallBoundary extends HttpApiMiddleware.Service<SmallBoundary>()('test/Small', {
	error: [InternalError, InvalidOperation, DatabaseError],
}) {}
export const rejected = FailureBoundaryLayer.make(
	SmallBoundary,
	// @ts-expect-error the tag does not list Forbidden
	// @effect-diagnostics-next-line missingEffectError:off
	() => Effect.fail(new Forbidden({ message: 'no', reason: 'access_denied' })),
)

// Loopback on a free port: the generated client calls the real server.
const served = HttpRouter.serve(app).pipe(
	Layer.provideMerge(BunHttpServer.layer({ port: 0, hostname: '127.0.0.1' })),
)

const baseUrl = Effect.map(Effect.service(HttpServer.HttpServer), (server) =>
	HttpServer.formatAddress(server.address).replace(/\/$/, ''),
)

const post = (path: string, body?: unknown) =>
	Effect.gen(function* () {
		const base = yield* baseUrl
		const response = yield* Effect.promise(() =>
			fetch(`${base}${path}`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			}),
		)
		return { status: response.status, text: yield* Effect.promise(() => response.text()) }
	})

layer(served.pipe(Layer.provideMerge(FetchHttpClient.layer)), {
	excludeTestServices: true,
})('FailureBoundary on a real server', (it) => {
	it.effect('answers a unique violation on a listed constraint as SlugTaken, 409', () =>
		Effect.gen(function* () {
			const client = yield* HttpApiClient.make(Api, { baseUrl: yield* baseUrl })
			const error = yield* Effect.flip(client.things.claimSlug())
			assert.instanceOf(error, SlugTaken)
			assert.strictEqual((yield* post('/claim-slug')).status, 409)
		}),
	)

	it.effect('answers a standard code with fixed text and its status', () =>
		Effect.gen(function* () {
			const client = yield* HttpApiClient.make(Api, { baseUrl: yield* baseUrl })
			const error = yield* Effect.flip(client.things.denied())
			assert.instanceOf(error, Forbidden)
			const raw = yield* post('/denied')
			assert.strictEqual(raw.status, 403)
			assert.notInclude(raw.text, 'raw postgres text')
		}),
	)

	it.effect(
		'answers a payload that fails its schema as InvalidOperation, 400, with issues',
		() =>
			Effect.gen(function* () {
				const raw = yield* post('/create', { name: 3 })
				assert.strictEqual(raw.status, 400)
				const body = JSON.parse(raw.text)
				assert.strictEqual(body._tag, 'InvalidOperation')
				assert.strictEqual(body.reason, 'invalid_input')
				assert.strictEqual(body.issues[0].path[0], 'payload')
				assert.deepStrictEqual(body.issues[0].path.slice(1), ['name'])
			}),
	)

	it.effect(
		'answers a defect as InternalError, 500, with a trace id and not its text',
		() =>
			Effect.gen(function* () {
				const client = yield* HttpApiClient.make(Api, { baseUrl: yield* baseUrl })
				const error = yield* Effect.flip(client.things.boom())
				assert.instanceOf(error, InternalError)
				assert.isAbove(error instanceof InternalError ? error.traceId.length : 0, 0)
				const raw = yield* post('/boom')
				assert.strictEqual(raw.status, 500)
				assert.notInclude(raw.text, 'secret')
			}),
	)
})
