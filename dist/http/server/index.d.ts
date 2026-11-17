import { Cause, Effect, Layer, type Schema } from 'effect';
import type * as Context from 'effect/Context';
import { type HttpApiMiddleware } from 'effect/http-api';
import { type DatabaseError } from '../../db/DatabaseError.ts';
import { Conflict, Forbidden, InternalError, InvalidOperation, ServiceUnavailable } from '../index.ts';
/** A tagged error class instance an app answers with, such as `SlugTaken`. */
type Answer = Cause.YieldableError & {
    readonly _tag: string;
};
/** The classes the package's standard codes raise. */
type StandardAnswer = Conflict | Forbidden | InvalidOperation | ServiceUnavailable;
/**
 * The answer table: what each database failure means to a client. `codes` maps
 * a custom SQLSTATE that the app's SQL raises to an answer built from the
 * SQL's own message, which was written for users; `constraints` maps a unique
 * constraint a user can hit to its answer. The package answers the standard
 * codes a client can cause with fixed text. Anything else dies, and the
 * boundary answers 500.
 *
 * The result fails with the exact union of its answers: the `codes` results,
 * the `constraints` values and the standard classes. An expected refusal logs
 * once, at Info (custom code) or Warning (standard code).
 */
export declare const DatabaseAnswers: {
    make: typeof makeAnswers;
};
declare function makeAnswers<const Codes extends Record<string, (message: string) => Answer>, const Constraints extends Record<string, Answer>>(answers: {
    readonly codes: Codes;
    readonly constraints: Constraints;
}): (error: DatabaseError) => Effect.Effect<never, ReturnType<Codes[keyof Codes]> | Constraints[keyof Constraints] | StandardAnswer>;
/**
 * The failure boundary's server half: every failed request answers from here.
 *
 * - A request part that fails its schema answers `InvalidOperation` with its
 *   issues.
 * - A typed `DatabaseError`, from a handler or a middleware (`SignedIn` at
 *   commit), answers through `toHttpError`, the answer table.
 * - A cause with a defect is logged once with the trace id and answers
 *   `InternalError`, never with the defect's text.
 * - Other typed failures pass through for the endpoint to encode.
 *
 * `tag` is the app's boundary tag. It must list `InternalError`,
 * `InvalidOperation`, `DatabaseError` and every class `toHttpError` can raise, so a class the
 * app forgot to declare is a compile error, not a 500.
 */
export declare const FailureBoundaryLayer: {
    make: typeof makeBoundary;
};
declare function makeBoundary<Id, E extends ReadonlyArray<Schema.Top>>(tag: Context.Service<Id, HttpApiMiddleware.HttpApiMiddleware<never, E, never>> & ListsBoundaryErrors<E[number]['Type']>, toHttpError: (error: DatabaseError) => Effect.Effect<never, E[number]['Type']>): Layer.Layer<Id>;
/** No constraint when the tag lists the classes the boundary raises; otherwise a property that names what is missing. */
type ListsBoundaryErrors<Listed> = [
    InternalError | InvalidOperation | DatabaseError
] extends [Listed] ? unknown : {
    readonly tagMustList: 'InternalError, InvalidOperation and DatabaseError';
};
export {};
