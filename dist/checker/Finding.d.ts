import { Effect, Schema } from 'effect';
import type { SqlError } from 'effect/sql/SqlError';
/**
 * error: a security defect. warning: a defect that breaks a function but
 * exposes no data. review: correct in some apps and wrong in others.
 */
export declare const Level: Schema.Literals<readonly ["error", "warning", "review"]>;
export type Level = typeof Level.Type;
declare const Finding_base: Schema.Class<Finding, Schema.Struct<{
    readonly level: Schema.Literals<readonly ["error", "warning", "review"]>;
    readonly check: Schema.String;
    readonly object: Schema.String;
    readonly problem: Schema.String;
    readonly rule: Schema.String;
}>, {
    readonly brand: unique symbol;
}>;
export declare class Finding extends Finding_base {
}
/** What a check is, apart from the query that finds its violations. */
export interface CheckInfo {
    readonly check: string;
    readonly level: Level;
    readonly rule: string;
}
/**
 * Turns the rows of a check's query into findings. Each check is one query
 * that returns one row per violation, with an `object` and a `problem` column,
 * so Postgres answers every privilege question.
 */
export declare const findings: (info: CheckInfo) => (rows: Effect.Effect<ReadonlyArray<unknown>, SqlError>) => Effect.Effect<Finding[], Schema.SchemaError | SqlError, never>;
export {};
