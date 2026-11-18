import { Cause, Context, Effect, Schema } from 'effect'
import type { JobHelpers } from 'graphile-worker'

/** A graphile-worker call that failed: loading, starting or stopping the runner, or a Promise task. */
export class WorkerError extends Schema.TaggedError<
	WorkerError,
	{ readonly brand: unique symbol }
>()('WorkerError', {
	message: Schema.String,
	cause: Schema.Defect(),
}) {}

/**
 * The part of graphile's `JobHelpers` that a job and its span read. Typed
 * narrowly so that a test builds it as a literal, without a cast.
 */
export type JobInfo = Pick<JobHelpers, 'abortSignal'> & {
	readonly job: Pick<
		JobHelpers['job'],
		'id' | 'task_identifier' | 'attempts' | 'created_at'
	>
}

/**
 * An Effect task for graphile's task list. The job runs on its payload decoded
 * with `schema`: the SQL or code that queues a job is the payload's only
 * producer, so a payload that does not decode is a bug there, and the job fails
 * with the SchemaError before `job` runs.
 *
 * Graphile owns retry scheduling: a failed job rejects its callback. Graphile
 * aborts a job on shutdown through its abort signal, which interrupts the
 * effect. The job runs in `context`, which the worker captured at start.
 */
export const effectTask =
	<R>(context: Context.Context<R>) =>
	<S extends Schema.Decoder<unknown>, A, E>(
		schema: S,
		job: (payload: S['Type'], helpers: JobInfo) => Effect.Effect<A, E, R>,
	) =>
	(payload: unknown, helpers: JobInfo): Promise<A> =>
		Effect.runPromiseWith(context)(
			traced(
				Schema.decodeUnknownEffect(schema)(payload).pipe(
					Effect.flatMap((decoded) => job(decoded, helpers)),
				),
				helpers,
			),
			{ signal: helpers.abortSignal },
		)

/**
 * A Promise task, the escape for a handler that is not an Effect. It decodes
 * its own payload. Nothing outside the task can stop it, so it reads the abort
 * signal from its own helpers. Its callback settles when the task does: if it
 * rejected on abort while the task ran on, graphile would retry a job whose
 * effects had already happened.
 */
export const promiseTask =
	<R>(context: Context.Context<R>) =>
	<H extends JobInfo>(task: (payload: unknown, helpers: H) => unknown) =>
	(payload: unknown, helpers: H): Promise<unknown> =>
		Effect.runPromiseWith(context)(
			traced(
				Effect.tryPromise({
					try: async () => task(payload, helpers),
					catch: (cause) => new WorkerError({ message: 'The job failed', cause }),
				}),
				helpers,
			),
		)

/**
 * Runs one job in its Worker.job span. This is the worker's failure boundary:
 * a failure is logged here, once, inside the span, so the line carries the
 * trace id. A stop is not a failure, so an interrupt alone is not logged.
 */
const traced = <A, E, R>(job: Effect.Effect<A, E, R>, helpers: JobInfo) =>
	job.pipe(
		Effect.tapCauseIf(
			(cause) => !Cause.hasInterruptsOnly(cause),
			(cause) => Effect.logError('The job failed', cause),
		),
		Effect.withSpan('Worker.job', {
			attributes: {
				'job.task': helpers.job.task_identifier,
				'job.id': helpers.job.id,
				'job.attempt': helpers.job.attempts,
			},
		}),
	)
