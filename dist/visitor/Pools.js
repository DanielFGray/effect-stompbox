import { PgClient } from '@effect/sql-pg';
import { Config, Context, Effect, Layer, Option } from 'effect';
import * as Reactivity from 'effect/reactivity/Reactivity';
/**
 * A pool configured by `<prefix>_URL` and the optional `<prefix>_POOL_SIZE`.
 * Declared before the services, whose static layers call it while the classes
 * are defined.
 */
const pool = Effect.fnUntraced(function* (prefix) {
    const url = yield* Config.Redacted(`${prefix}_URL`);
    const size = yield* Config.option(Config.Int(`${prefix}_POOL_SIZE`));
    return yield* PgClient.make({ url, maxConnections: Option.getOrUndefined(size) });
});
/**
 * The API login's pool (ADR 0002). Requests reach the database only through
 * it, inside `Visitor.run`, which switches each transaction to the visitor
 * role. Configured by `AUTH_DATABASE_URL` and the optional
 * `AUTH_DATABASE_POOL_SIZE`.
 */
export class ApiPool extends Context.Service()('@danielfgray/stompbox/visitor/ApiPool') {
    static layer = Layer.effect(this, pool('AUTH_DATABASE')).pipe(Layer.provide(Reactivity.layer));
}
/**
 * The migration login's pool. It runs as the owner role, which owns the
 * tables, so row-level security does not limit it. Code that uses
 * it asks for it by name; nothing provides it as the default `SqlClient`.
 * Configured by `DATABASE_URL` and the optional `DATABASE_POOL_SIZE`. An app
 * that signs in through SQL functions does not need it at runtime.
 */
export class OwnerPool extends Context.Service()('@danielfgray/stompbox/visitor/OwnerPool') {
    static layer = Layer.effect(this, pool('DATABASE')).pipe(Layer.provide(Reactivity.layer));
}
