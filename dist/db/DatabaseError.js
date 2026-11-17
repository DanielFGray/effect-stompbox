import { Schema } from 'effect';
/** What Postgres reports about a statement it refused: the protocol error fields. */
export const PostgresReport = Schema.Struct({
    /** The SQLSTATE: a standard code, or a custom one an app's SQL functions raise. */
    code: Schema.String,
    message: Schema.String,
    detail: Schema.OptionFromOptional(Schema.String),
    hint: Schema.OptionFromOptional(Schema.String),
    constraint: Schema.OptionFromOptional(Schema.String),
});
/**
 * A failed database call. `report` is none when the failure did not come from
 * Postgres (a lost connection, a driver error). `message` is for the log only.
 */
export class DatabaseError extends Schema.TaggedError()('DatabaseError', {
    message: Schema.String,
    report: Schema.Option(PostgresReport),
    cause: Schema.Unknown,
}) {
}
/** Refinement for generic error channels, where `Effect.catchTag` cannot narrow the tag. */
export const isDatabaseError = (u) => Schema.is(DatabaseError)(u);
