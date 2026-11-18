import { PgClient } from '@effect/sql-pg';
import { Config, Context, Layer } from 'effect';
declare const ApiPool_base: Context.ServiceClass<ApiPool, "@danielfgray/stompbox/visitor/ApiPool", PgClient.PgClient>;
/**
 * The API login's pool (ADR 0002). Requests reach the database only through
 * it, inside `Visitor.run`, which switches each transaction to the visitor
 * role. Configured by `AUTH_DATABASE_URL` and the optional
 * `AUTH_DATABASE_POOL_SIZE`.
 */
export declare class ApiPool extends ApiPool_base {
    static readonly layer: Layer.Layer<ApiPool, Config.ConfigError | import("effect/sql/SqlError").SqlError, never>;
}
declare const OwnerPool_base: Context.ServiceClass<OwnerPool, "@danielfgray/stompbox/visitor/OwnerPool", PgClient.PgClient>;
/**
 * The migration login's pool. It runs as the owner role, which owns the
 * tables, so row-level security does not limit it. Code that uses
 * it asks for it by name; nothing provides it as the default `SqlClient`.
 * Configured by `DATABASE_URL` and the optional `DATABASE_POOL_SIZE`. An app
 * that signs in through SQL functions does not need it at runtime.
 */
export declare class OwnerPool extends OwnerPool_base {
    static readonly layer: Layer.Layer<OwnerPool, Config.ConfigError | import("effect/sql/SqlError").SqlError, never>;
}
export {};
