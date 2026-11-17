import { Effect } from 'effect';
import { runnerOn, toDatabaseError } from '../db/index.js';
import { OwnerPool } from './Pools.js';
import { VisitorTransaction } from './Visitor.js';
/**
 * Queries as the visitor, typed by `Tables`. Each method needs
 * `VisitorTransaction`, which only `Visitor.run` provides, so a visitor query
 * outside a request does not compile.
 */
export const visitorDb = () => runnerOn(Effect.map(Effect.service(VisitorTransaction), (t) => t.sql));
/**
 * Queries as the owner, typed by `Tables`. Row-level security does not limit
 * the owner, so only code that asks for `OwnerPool` by name can run these.
 * `withTransaction` runs an effect in one owner transaction; every owner query
 * inside it, from this runner or from another service on `OwnerPool`, joins it.
 * A failure at begin or commit (a deferred constraint) is a `DatabaseError`.
 */
export const ownerDb = () => {
    const db = runnerOn(Effect.service(OwnerPool));
    return {
        ...db,
        withTransaction: (effect) => Effect.flatMap(Effect.service(OwnerPool), (sql) => sql.withTransaction(effect).pipe(toDatabaseError)),
    };
};
