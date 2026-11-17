import { Schema } from 'effect';
/** What Postgres reports about a statement it refused: the protocol error fields. */
export declare const PostgresReport: Schema.Struct<{
    /** The SQLSTATE: a standard code, or a custom one an app's SQL functions raise. */
    readonly code: Schema.String;
    readonly message: Schema.String;
    readonly detail: Schema.OptionFromOptional<Schema.String>;
    readonly hint: Schema.OptionFromOptional<Schema.String>;
    readonly constraint: Schema.OptionFromOptional<Schema.String>;
}>;
export type PostgresReport = typeof PostgresReport.Type;
declare const DatabaseError_base: Schema.Class<DatabaseError, Schema.TaggedStruct<"DatabaseError", {
    readonly message: Schema.String;
    readonly report: Schema.Option<Schema.Struct<{
        /** The SQLSTATE: a standard code, or a custom one an app's SQL functions raise. */
        readonly code: Schema.String;
        readonly message: Schema.String;
        readonly detail: Schema.OptionFromOptional<Schema.String>;
        readonly hint: Schema.OptionFromOptional<Schema.String>;
        readonly constraint: Schema.OptionFromOptional<Schema.String>;
    }>>;
    readonly cause: Schema.Unknown;
}>, import("effect/Cause").YieldableError & {
    readonly brand: unique symbol;
}>;
/**
 * A failed database call. `report` is none when the failure did not come from
 * Postgres (a lost connection, a driver error). `message` is for the log only.
 */
export declare class DatabaseError extends DatabaseError_base {
}
/** Refinement for generic error channels, where `Effect.catchTag` cannot narrow the tag. */
export declare const isDatabaseError: (u: unknown) => u is DatabaseError;
export {};
