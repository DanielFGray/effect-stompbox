import { Effect, FileSystem, Schema } from 'effect';
import { SqlClient } from 'effect/sql/SqlClient';
import { Finding } from './Finding.ts';
import type { RoleContract } from './Roles.ts';
/**
 * Everything the visitor role can reach, one line per object, sorted: each
 * schema it can use; each table, view, sequence and column with its
 * privileges; each function it can execute; and each extension in a schema it can use, as
 * one line.
 * Objects in a schema the visitor cannot use are left out, because it cannot
 * name them. Lines name no role, so two databases built from different
 * migrations compare line by line.
 */
export declare const visitorReach: (roles: RoleContract) => Effect.Effect<string[], Schema.SchemaError | import("effect/sql/SqlError").SqlError, SqlClient>;
/**
 * C3: the visitor reaches nothing the surface file does not list. The file
 * records an approved state, so it is written from a known-good database,
 * never from the change under review. A line the file lists but the visitor
 * no longer reaches is a review finding: the file is out of date.
 */
export declare const c3: (reach: ReadonlyArray<string>, surface: ReadonlyArray<string>) => Finding[];
/** Reads a visitor surface file: one line per object; `#` starts a comment. */
export declare const readSurface: (path: string) => Effect.Effect<string[], import("effect/PlatformError").PlatformError, FileSystem.FileSystem>;
export declare const writeSurface: (path: string, reach: readonly string[]) => Effect.Effect<void, import("effect/PlatformError").PlatformError, FileSystem.FileSystem>;
/**
 * C4: no default privilege makes new functions executable by PUBLIC, which
 * reaches every role, including the API login. A default grant to the visitor
 * is the convention: functions in the visitor's schemas are callable unless
 * revoked, and C3 shows each new one as a change to the surface file. Postgres grants EXECUTE to PUBLIC on every new function unless
 * a global default-privilege entry for the creating role leaves PUBLIC out;
 * a per-schema entry can only add grants, never remove that one.
 */
export declare const c4: (roles: RoleContract) => Effect.Effect<Finding[], Schema.SchemaError | import("effect/sql/SqlError").SqlError, SqlClient>;
