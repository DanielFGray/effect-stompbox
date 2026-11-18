import { Effect, Option, Record, Redacted, Ref } from 'effect';
import { Logger, run } from 'graphile-worker';
import { WorkerError } from './Job.js';
/**
 * Starts the graphile-worker runner inside this process and stops it when the
 * scope closes. Returns once the runner runs; a runner that cannot start fails
 * with WorkerError, so the caller decides whether that stops the server or only
 * logs (fork it for the second).
 *
 * `isRunning` is false once the runner stops by itself. Close the scope before
 * the database pools: stopping waits for the running jobs.
 *
 * The Effect runtime owns SIGINT and SIGTERM (`noHandleSignals`). Graphile
 * logs go through Effect's logger; its debug lines are dropped, as its own
 * logger drops them, because one prints the pool options with the connection
 * string. Only graphile's scope (worker, task and job ids) annotates a line:
 * its per-line metadata holds the whole job row, whose payload can carry tokens.
 */
export const runWorker = Effect.fnUntraced(function* (options) {
    const running = yield* Ref.make(false);
    const context = yield* Effect.context();
    const logger = new Logger((scope) => (level, message) => Option.match(Record.get(graphileLevels, level), {
        onNone: () => undefined,
        onSome: (log) => Effect.runSyncWith(context)(log(message).pipe(Effect.annotateLogs(scope))),
    }));
    const runner = yield* Effect.acquireRelease(Effect.tryPromise({
        try: () => run({
            connectionString: Redacted.value(options.connectionString),
            taskList: options.taskList,
            logger,
            crontabFile: options.crontabFile,
            noHandleSignals: true,
            // With the default delay (-1), graphile does not wait for the row
            // update that marks a job done or failed, and a graceful shutdown
            // can end the pool before it is sent. The job then stays locked
            // and runs again when the lock expires (4 hours), so a sent
            // email is sent twice. With a batch delay, the shutdown waits for
            // the pending updates; 0 sends each one on the next tick.
            preset: { worker: { completeJobBatchDelay: 0, failJobBatchDelay: 0 } },
        }),
        catch: (cause) => new WorkerError({ message: 'Could not start the worker', cause }),
    }), (started) => stop(started, running));
    yield* Ref.set(running, true);
    // Forked after the release above, so on shutdown it is interrupted before
    // `stop` settles the runner's promise, and does not log a planned stop.
    yield* Effect.forkScoped(Effect.tryPromise({
        try: () => runner.promise,
        catch: (cause) => new WorkerError({ message: 'The worker stopped with an error', cause }),
    }).pipe(Effect.matchEffect({
        onFailure: (error) => Effect.logError(error.message, error.cause),
        onSuccess: () => Effect.logError('The worker stopped'),
    }), Effect.andThen(Ref.set(running, false))));
    return { isRunning: Ref.get(running) };
});
/** `runner.stop()` rejects on a runner that already stopped itself, so that one is skipped. */
const stop = Effect.fnUntraced(function* (runner, running) {
    if (!(yield* Ref.get(running)))
        return;
    yield* Effect.tryPromise({
        try: () => runner.stop(),
        catch: (cause) => new WorkerError({ message: 'Could not stop the worker', cause }),
    }).pipe(Effect.catch((error) => Effect.logError(error.message, error.cause)));
    yield* Ref.set(running, false);
});
/** Graphile's log levels, as Effect log calls. */
const graphileLevels = {
    error: Effect.logError,
    warning: Effect.logWarning,
    info: Effect.logInfo,
};
