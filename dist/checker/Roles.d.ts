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
 * database it made, and that database's owner role also owns its `_test` and
 * `_shadow` copies. So the names follow from the owner of the connected
 * database, not from its name: a name ending in `_test` may be the app's own.
 */
export declare class RoleContract extends RoleContract_base {
}
declare const RoleMissing_base: Schema.Class<RoleMissing, Schema.TaggedStruct<"RoleMissing", {
    readonly role: Schema.String;
    readonly source: Schema.String;
    readonly message: Schema.String;
}>, import("effect/Cause").YieldableError & {
    readonly brand: unique symbol;
}>;
/**
 * The visitor role is named but absent from this database, so the host did
 * not provision the contract. Raised before any check runs: Postgres rejects a
 * privilege question about an unknown role name with an error, not a false.
 */
export declare class RoleMissing extends RoleMissing_base {
}
/**
 * The roles of the connected database. The visitor role's name follows from
 * the owner's name unless `DATABASE_VISITOR` names it, for a host whose roles
 * use other names. Fails with `RoleMissing` when the visitor role does not
 * exist. The API login is not checked here: C1 reports its absence.
 */
export declare const roleContract: Effect.Effect<RoleContract, Config.ConfigError | import("effect/Cause").NoSuchElementError | RoleMissing | Schema.SchemaError | import("effect/sql/SqlError").SqlError, SqlClient>;
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
