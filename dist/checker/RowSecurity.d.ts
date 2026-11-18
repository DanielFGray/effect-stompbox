import { Effect } from 'effect';
import { SqlClient } from 'effect/sql/SqlClient';
import type { RoleContract } from './Roles.ts';
/**
 * C5: every table the visitor can read or write has row-level security
 * enabled, and the visitor holds no privilege that row-level security does
 * not limit (TRUNCATE, REFERENCES, TRIGGER). A column grant counts as access
 * to the table. Tables in a schema the visitor cannot use are out of reach.
 */
export declare const c5: (roles: RoleContract) => Effect.Effect<import("./Finding.ts").Finding[], import("effect/Schema").SchemaError | import("effect/sql/SqlError").SqlError, SqlClient>;
/**
 * C6: policies on a table with row-level security disabled do nothing, which
 * is an error. A table the visitor can reach, with row-level security on but
 * no policy that applies to the visitor, shows the visitor no rows; that is
 * usually a policy written for the wrong role, so it is for review. A table
 * the visitor cannot reach may deny every row on purpose, and is not reported.
 */
export declare const c6: (roles: RoleContract) => Effect.Effect<import("./Finding.ts").Finding[], import("effect/Schema").SchemaError | import("effect/sql/SqlError").SqlError, SqlClient>;
/**
 * C8: a view runs its query with its owner's rights unless it is created
 * with `security_invoker`, so row-level security on the tables it reads
 * applies to the owner, not to the visitor. A materialized view stores its
 * rows and never applies row-level security. Either one that the visitor can
 * read shows rows the visitor's policies would hide.
 */
export declare const c8: (roles: RoleContract) => Effect.Effect<import("./Finding.ts").Finding[], import("effect/Schema").SchemaError | import("effect/sql/SqlError").SqlError, SqlClient>;
