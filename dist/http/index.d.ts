import { Schema } from 'effect';
import { DatabaseError } from '../db/DatabaseError.ts';
/** One rejected request value. `path` starts with the request part (`payload`, `params`, `query`, `headers`). */
export declare const InputIssue: Schema.Struct<{
    readonly path: Schema.$Array<Schema.Union<readonly [Schema.String, Schema.Int]>>;
    readonly message: Schema.String;
}>;
declare const InternalError_base: Schema.Class<InternalError, Schema.TaggedStruct<"InternalError", {
    readonly message: Schema.String;
    readonly traceId: Schema.String;
}>, import("effect/Cause").YieldableError & {
    readonly brand: unique symbol;
}>;
/** A defect. The body carries a fixed message and the trace id that finds the logged cause. */
export declare class InternalError extends InternalError_base {
}
declare const InvalidOperation_base: Schema.Class<InvalidOperation, Schema.TaggedStruct<"InvalidOperation", {
    readonly message: Schema.String;
    readonly reason: Schema.Literals<readonly ["invalid_input"]>;
    readonly issues: Schema.$Array<Schema.Struct<{
        readonly path: Schema.$Array<Schema.Union<readonly [Schema.String, Schema.Int]>>;
        readonly message: Schema.String;
    }>>;
}>, import("effect/Cause").YieldableError & {
    readonly brand: unique symbol;
}>;
/** A request the server cannot accept as sent; `issues` names each value the request schema rejected. */
export declare class InvalidOperation extends InvalidOperation_base {
}
declare const Unauthorized_base: Schema.Class<Unauthorized, Schema.TaggedStruct<"Unauthorized", {
    readonly message: Schema.String;
}>, import("effect/Cause").YieldableError & {
    readonly brand: unique symbol;
}>;
/** A request with no live session. */
export declare class Unauthorized extends Unauthorized_base {
}
declare const Forbidden_base: Schema.Class<Forbidden, Schema.TaggedStruct<"Forbidden", {
    readonly message: Schema.String;
    readonly reason: Schema.Literals<readonly ["access_denied"]>;
}>, import("effect/Cause").YieldableError & {
    readonly brand: unique symbol;
}>;
/** A request the signed-in user may not make. */
export declare class Forbidden extends Forbidden_base {
}
declare const NotFound_base: Schema.Class<NotFound, Schema.TaggedStruct<"NotFound", {
    readonly message: Schema.String;
}>, import("effect/Cause").YieldableError & {
    readonly brand: unique symbol;
}>;
export declare class NotFound extends NotFound_base {
}
declare const Conflict_base: Schema.Class<Conflict, Schema.TaggedStruct<"Conflict", {
    readonly message: Schema.String;
    readonly reason: Schema.Literals<readonly ["already_exists", "related_data"]>;
}>, import("effect/Cause").YieldableError & {
    readonly brand: unique symbol;
}>;
/** The request conflicts with data that exists now. */
export declare class Conflict extends Conflict_base {
}
declare const ServiceUnavailable_base: Schema.Class<ServiceUnavailable, Schema.TaggedStruct<"ServiceUnavailable", {
    readonly message: Schema.String;
    readonly reason: Schema.Literals<readonly ["busy", "timed_out", "misconfigured"]>;
}>, import("effect/Cause").YieldableError & {
    readonly brand: unique symbol;
}>;
/**
 * The server could not finish the request now: a conflict with a concurrent
 * transaction (`busy`), a statement timeout (`timed_out`), or a fault in the
 * server's settings (`misconfigured`). The client may send the request again.
 */
export declare class ServiceUnavailable extends ServiceUnavailable_base {
}
/** The classes the boundary and the standard database answers raise. An app's boundary tag lists these and its own classes. */
export declare const boundaryErrors: readonly [typeof InternalError, typeof InvalidOperation, typeof Unauthorized, typeof Forbidden, typeof NotFound, typeof Conflict, typeof ServiceUnavailable, typeof DatabaseError];
export {};
