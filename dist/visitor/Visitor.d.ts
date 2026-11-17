import { Context, Effect, Layer, Option, Schema } from 'effect';
import { SqlClient } from 'effect/sql/SqlClient';
import type { SqlError } from 'effect/sql/SqlError';
import { Finding } from '../checker/index.ts';
import type { DatabaseError } from '../db/DatabaseError.ts';
import { Features } from '../delivery/index.ts';
import { ApiPool } from './Pools.ts';
declare const RequestSession_base: Context.ServiceClass<RequestSession, "@danielfgray/stompbox/visitor/RequestSession", Option.Option<string>>;
/**
 * The current request's session id, or none for an anonymous request. The
 * auth implementation provides it per request (ADR 0004); `Visitor.run` reads
 * it and binds it to `my.session_id` for `current_user_id()`.
 */
export declare class RequestSession extends RequestSession_base {
}
declare const VisitorTransaction_base: Context.ServiceClass<VisitorTransaction, "@danielfgray/stompbox/visitor/VisitorTransaction", {
    readonly sql: SqlClient;
}>;
/**
 * The request's transaction, as the visitor role. Only `Visitor.run` provides
 * it, so code that queries as the visitor cannot run outside a request: it
 * does not compile. Request code queries through `visitorDb`, or through
 * `sql` for a statement Kysely cannot build.
 *
 * A service method that queries as the visitor requires it from its caller,
 * the way a handler requires the request: it exists only per request.
 *
 * @effect-leakable-service
 */
export declare class VisitorTransaction extends VisitorTransaction_base {
}
declare const StartupCheckFailed_base: Schema.Class<StartupCheckFailed, Schema.TaggedStruct<"StartupCheckFailed", {
    readonly findings: Schema.$Array<typeof Finding>;
}>, import("effect/Cause").YieldableError & {
    readonly brand: unique symbol;
}>;
/** The database's roles do not meet the role contract; the server does not start. */
export declare class StartupCheckFailed extends StartupCheckFailed_base {
}
declare const NestedVisitorRun_base: Schema.Class<NestedVisitorRun, Schema.TaggedStruct<"NestedVisitorRun", {}>, import("effect/Cause").YieldableError & {
    readonly brand: unique symbol;
}>;
/** A defect: `Visitor.run` was called inside `Visitor.run`. */
export declare class NestedVisitorRun extends NestedVisitorRun_base {
}
declare const Visitor_base: Context.ServiceClass<Visitor, "@danielfgray/stompbox/visitor/Visitor", {
    /**
     * Runs `effect` in one transaction on the API pool, as the visitor role,
     * with the request's session bound to `my.session_id`. `effect` reaches
     * that transaction through `VisitorTransaction`, which only this provides.
     * A nested `sql.withTransaction` inside it is a savepoint.
     *
     * Database failures arrive as `DatabaseError`. Map codes anywhere;
     * recover only outside `run` or inside a nested transaction (savepoint).
     *
     * A fiber forked inside `effect` that queries after `run` returns gets a
     * connection error, never another request's transaction: the Postgres
     * driver refuses statements on a released connection lease. The escape
     * tests in test/Visitor.test.ts hold the driver to that.
     */
    readonly run: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, Exclude<E, SqlError> | DatabaseError, Exclude<R, VisitorTransaction> | RequestSession>;
}>;
/**
 * Runs request code as the visitor role. Building the layer checks the role
 * contract (checks C1 and C2, and that the API pool logs in as the API login)
 * and that no feature in `Features` is behind its latest migration, and fails
 * with `StartupCheckFailed` otherwise.
 */
export declare class Visitor extends Visitor_base {
    static readonly layer: Layer.Layer<Visitor, import("effect/Config").ConfigError | DatabaseError | import("../delivery/DeliveryRefused.ts").DeliveryRefused | import("effect/Cause").NoSuchElementError | import("effect/PlatformError").PlatformError | Schema.SchemaError | SqlError | StartupCheckFailed, ApiPool | Features | import("effect/FileSystem").FileSystem | import("effect/Path").Path>;
}
export {};
