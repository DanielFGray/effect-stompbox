import { Effect } from 'effect';
import { type DatabaseError } from './DatabaseError.ts';
/**
 * Maps the SQLSTATE codes a service reacts to onto its own typed errors. `errors`
 * maps a code to the error to fail with: a Postgres code such as `23505`, or a
 * code an app's SQL function raises, such as `CREDS`. Every other database
 * failure stays a `DatabaseError`, for the handler's answer table.
 *
 * Mapping inside `Visitor.run` is safe: the mapped error still fails the
 * transaction. Recovering is not, because Postgres aborts the transaction on a
 * failed statement; recover outside `Visitor.run`, or inside a savepoint.
 */
export declare const onSqlState: <M>(errors: { readonly [K in keyof M]: (error: DatabaseError) => M[K]; }) => <A, E, R>(self: Effect.Effect<A, E | DatabaseError, R>) => Effect.Effect<A, DatabaseError | M[keyof M] | Exclude<E, DatabaseError>, R>;
