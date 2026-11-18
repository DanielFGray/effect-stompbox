import { Cause, Context, Effect, Schema } from 'effect';
import type { JobHelpers } from 'graphile-worker';
declare const WorkerError_base: Schema.Class<WorkerError, Schema.TaggedStruct<"WorkerError", {
    readonly message: Schema.String;
    readonly cause: Schema.Defect;
}>, Cause.YieldableError & {
    readonly brand: unique symbol;
}>;
/** A graphile-worker call that failed: loading, starting or stopping the runner, or a Promise task. */
export declare class WorkerError extends WorkerError_base {
}
/**
 * The part of graphile's `JobHelpers` that a job and its span read. Typed
 * narrowly so that a test builds it as a literal, without a cast.
 */
export type JobInfo = Pick<JobHelpers, 'abortSignal'> & {
    readonly job: Pick<JobHelpers['job'], 'id' | 'task_identifier' | 'attempts' | 'created_at'>;
};
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
export declare const effectTask: <R>(context: Context.Context<R>) => <S extends Schema.Decoder<unknown>, A, E>(schema: S, job: (payload: S['Type'], helpers: JobInfo) => Effect.Effect<A, E, R>) => (payload: unknown, helpers: JobInfo) => Promise<A>;
/**
 * A Promise task, the escape for a handler that is not an Effect. It decodes
 * its own payload. Nothing outside the task can stop it, so it reads the abort
 * signal from its own helpers. Its callback settles when the task does: if it
 * rejected on abort while the task ran on, graphile would retry a job whose
 * effects had already happened.
 */
export declare const promiseTask: <R>(context: Context.Context<R>) => <H extends JobInfo>(task: (payload: unknown, helpers: H) => unknown) => (payload: unknown, helpers: H) => Promise<unknown>;
export {};
