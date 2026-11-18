import { Effect, Option } from 'effect';
import { isDatabaseError } from './DatabaseError.js';
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
export const onSqlState = (errors) => {
    // A Map, so a code never matches a property inherited from Object.prototype.
    const byCode = new Map(Object.entries(errors));
    return (self) => Effect.catchIf(self, isDatabaseError, (error) => Effect.fail(Option.flatMap(error.report, ({ code }) => Option.fromNullishOr(byCode.get(code))).pipe(Option.match({
        onNone: () => error,
        onSome: (toError) => toError(error),
    }))));
};
