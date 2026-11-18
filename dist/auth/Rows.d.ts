import { Effect, Schema } from 'effect';
/**
 * Decodes the rows of the package's own SQL. The SQL and the Schema are
 * written together, so a mismatch is a bug: it dies instead of joining the
 * error channel of every caller.
 */
export declare const decodeRows: <S extends Schema.Top>(rows: S) => (raw: unknown) => Effect.Effect<S["Type"], never, S["DecodingServices"]>;
