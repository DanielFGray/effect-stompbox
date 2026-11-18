import { Effect, Redacted } from 'effect';
import { type TaskList } from 'graphile-worker';
import { WorkerError } from './Job.ts';
export type RunnerOptions = {
    readonly connectionString: Redacted.Redacted;
    readonly taskList: TaskList;
    /** Path to a graphile crontab file; the app owns its location. */
    readonly crontabFile: string;
};
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
export declare const runWorker: (options: RunnerOptions) => Effect.Effect<{
    isRunning: Effect.Effect<boolean, never, never>;
}, WorkerError, import("effect/Scope").Scope>;
