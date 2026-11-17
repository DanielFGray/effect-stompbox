import { Effect } from 'effect';
import { type SqlError } from 'effect/sql/SqlError';
import { DatabaseError } from './DatabaseError.ts';
/**
 * Turns a `SqlError` into a `DatabaseError`. `@effect/sql-pg` keeps the
 * protocol fields on the reason's cause, so the report is decoded from there,
 * once; the `SqlError` stays as `cause`. Any other error passes through.
 * This module needs `effect/sql`, so `DatabaseError` lives apart from it and a
 * client bundle can import the class without SQL code.
 */
export declare const toDatabaseError: <A, E, R>(self: Effect.Effect<A, E | SqlError, R>) => Effect.Effect<A, DatabaseError | Exclude<E, SqlError>, R>;
