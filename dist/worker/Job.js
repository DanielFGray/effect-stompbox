import { Cause, Context, Effect, Schema } from 'effect';
/** A graphile-worker call that failed: loading, starting or stopping the runner, or a Promise task. */
export class WorkerError extends Schema.TaggedError()('WorkerError', {
    message: Schema.String,
    cause: Schema.Defect(),
}) {
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
export const effectTask = (context) => (schema, job) => (payload, helpers) => Effect.runPromiseWith(context)(traced(Schema.decodeUnknownEffect(schema)(payload).pipe(Effect.flatMap((decoded) => job(decoded, helpers))), helpers), { signal: helpers.abortSignal });
/**
 * A Promise task, the escape for a handler that is not an Effect. It decodes
 * its own payload. Nothing outside the task can stop it, so it reads the abort
 * signal from its own helpers. Its callback settles when the task does: if it
 * rejected on abort while the task ran on, graphile would retry a job whose
 * effects had already happened.
 */
export const promiseTask = (context) => (task) => (payload, helpers) => Effect.runPromiseWith(context)(traced(Effect.tryPromise({
    try: async () => task(payload, helpers),
    catch: (cause) => new WorkerError({ message: 'The job failed', cause }),
}), helpers));
/**
 * Runs one job in its Worker.job span. This is the worker's failure boundary:
 * a failure is logged here, once, inside the span, so the line carries the
 * trace id. A stop is not a failure, so an interrupt alone is not logged.
 */
const traced = (job, helpers) => job.pipe(Effect.tapCauseIf((cause) => !Cause.hasInterruptsOnly(cause), (cause) => Effect.logError('The job failed', cause)), Effect.withSpan('Worker.job', {
    attributes: {
        'job.task': helpers.job.task_identifier,
        'job.id': helpers.job.id,
        'job.attempt': helpers.job.attempts,
    },
}));
