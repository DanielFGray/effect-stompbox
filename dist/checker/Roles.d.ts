import { Config, Effect, Schema } from 'effect';
import { SqlClient } from 'effect/sql/SqlClient';
declare const RoleContract_base: Schema.Class<RoleContract, Schema.Struct<{
    readonly owner: Schema.String;
    readonly visitor: Schema.String;
    readonly api: Schema.String;
}>, {
    readonly brand: unique symbol;
}>;
/**
 * The role contract of ADR 0002. The provisioner names every role after the
 * database, so the names follow from `current_database()`.
 */
export declare class RoleContract extends RoleContract_base {
}
/**
 * The roles of the connected database. The visitor role's name follows from
 * the database name unless `DATABASE_VISITOR` names it, for a host whose roles
 * use other names.
 */
export declare const roleContract: Effect.Effect<RoleContract, Config.ConfigError | import("effect/Cause").NoSuchElementError | Schema.SchemaError | import("effect/sql/SqlError").SqlError, SqlClient>;
/**
 * C1: the API login can switch to the visitor role but does not inherit its
 * rights, cannot reach the owner role, owns nothing, and holds no privilege
 * on an app object except through the visitor role.
 */
export declare const c1: (roles: RoleContract) => Effect.Effect<import("./Finding.ts").Finding[], Schema.SchemaError | import("effect/sql/SqlError").SqlError, SqlClient>;
/**
 * C2: the visitor role cannot log in, has no power beyond its grants, owns
 * nothing and is a member of no other role.
 */
export declare const c2: (roles: RoleContract) => Effect.Effect<import("./Finding.ts").Finding[], Schema.SchemaError | import("effect/sql/SqlError").SqlError, SqlClient>;
export {};
