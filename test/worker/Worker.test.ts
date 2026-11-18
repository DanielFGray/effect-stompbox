import { assert, describe, it } from '@effect/vitest'
import { Deferred, Effect, Exit, Logger, Redacted, Ref, Schema, Scope } from 'effect'

import {
	effectTask,
	type JobInfo,
	promiseTask,
	runWorker,
	WorkerError,
} from '../../src/worker/index.ts'

const jobInfo = (abortSignal: AbortSignal = new AbortController().signal): JobInfo => ({
	job: { id: '1', task_identifier: 'send_email', attempts: 1, created_at: new Date(0) },
	abortSignal,
})

const Payload = Schema.Struct({ to: Schema.String })

/**
 * Runs `body` with a logger that records `[level, message]` of every line. A
 * task runs in the context its test captured, so the test must capture it
 * inside `body`.
 */
const withLogs = <A, E>(body: Effect.Effect<A, E>) =>
	Effect.gen(function* () {
		const lines: Array<readonly [string, unknown]> = []
		const logger = Logger.layer([
			Logger.make((options) => {
				lines.push([options.logLevel, options.message])
			}),
		])
		const result = yield* body.pipe(Effect.provide(logger))
		return { result, lines }
	})

describe('effectTask', () => {
	it.effect('runs the job on the decoded payload', () =>
		Effect.gen(function* () {
			const context = yield* Effect.context<never>()
			const task = effectTask(context)(Payload, (payload) => Effect.succeed(payload.to))
			const result = yield* Effect.promise(() => task({ to: 'a@example.com' }, jobInfo()))
			assert.strictEqual(result, 'a@example.com')
		}),
	)

	it.effect('rejects a payload that does not decode, without running the job', () =>
		withLogs(
			Effect.gen(function* () {
				const context = yield* Effect.context<never>()
				const ran = yield* Ref.make(false)
				const task = effectTask(context)(Payload, () => Ref.set(ran, true))
				const rejection = yield* Effect.promise(() =>
					task({ to: 1 }, jobInfo()).then(
						() => undefined,
						(cause: unknown) => cause,
					),
				)
				assert.isTrue(Schema.isSchemaError(rejection))
				assert.isFalse(yield* Ref.get(ran))
			}),
		).pipe(
			Effect.map(({ lines }) => {
				assert.deepStrictEqual(lines, [['Error', ['The job failed']]])
			}),
		),
	)

	it.effect('interrupts the job when graphile aborts it, and logs no failure', () =>
		withLogs(
			Effect.gen(function* () {
				const context = yield* Effect.context<never>()
				const started = yield* Deferred.make<void>()
				const interrupted = yield* Ref.make(false)
				const task = effectTask(context)(Payload, () =>
					Deferred.succeed(started, undefined).pipe(
						Effect.andThen(Effect.never),
						Effect.onInterrupt(() => Ref.set(interrupted, true)),
					),
				)
				// Effect.abortSignal aborts when its scope closes, which is how this test aborts the job.
				const scope = yield* Scope.make()
				const signal = yield* Effect.abortSignal.pipe(
					Effect.provideService(Scope.Scope, scope),
				)
				const running = task({ to: 'a' }, jobInfo(signal)).then(
					() => 'resolved',
					() => 'rejected',
				)
				yield* Deferred.await(started)
				yield* Scope.close(scope, Exit.void)
				assert.strictEqual(yield* Effect.promise(() => running), 'rejected')
				assert.isTrue(yield* Ref.get(interrupted))
			}),
		).pipe(
			Effect.map(({ lines }) => {
				assert.deepStrictEqual(lines, [])
			}),
		),
	)
})

describe('promiseTask', () => {
	it.effect('rejects its callback and logs one "The job failed" line', () =>
		withLogs(
			Effect.gen(function* () {
				const context = yield* Effect.context<never>()
				const failing = promiseTask(context)(async () => {
					throw new Error('boom')
				})
				return yield* Effect.promise(() =>
					failing({}, jobInfo()).then(
						() => 'resolved',
						() => 'rejected',
					),
				)
			}),
		).pipe(
			Effect.map(({ result, lines }) => {
				assert.strictEqual(result, 'rejected')
				assert.deepStrictEqual(lines, [['Error', ['The job failed']]])
			}),
		),
	)
})

describe('runWorker', () => {
	it.effect('fails with WorkerError when the runner cannot start', () =>
		Effect.gen(function* () {
			const error = yield* runWorker({
				connectionString: Redacted.make(
					'postgres://worker:worker@127.0.0.1:1/unavailable',
				),
				taskList: {},
				crontabFile: '/nonexistent/crontab',
			}).pipe(Effect.scoped, Effect.flip)
			assert.instanceOf(error, WorkerError)
			assert.strictEqual(error.message, 'Could not start the worker')
		}),
	)
})
