import { Effect } from 'effect';
import { SqlClient } from 'effect/sql/SqlClient';
import type { RoleContract } from './Roles.ts';
/**
 * C7: a SECURITY DEFINER function runs with its owner's rights, so every name
 * in its body must resolve to the object the author meant. That holds when
 * the function sets `search_path`, the visitor can create objects in no
 * schema on that path, and the visitor cannot put a temporary table in front
 * of it. Postgres searches `pg_temp` first for tables unless the path names it
 * last, so a visitor with TEMP on the database could shadow a table the body
 * names without a schema.
 */
export declare const c7: (roles: RoleContract) => Effect.Effect<import("./Finding.ts").Finding[], import("effect/Schema").SchemaError | import("effect/sql/SqlError").SqlError, SqlClient>;
