import type { SqlClient } from 'effect/sql/SqlClient';
/**
 * SQL condition: the object is an app object, not part of Postgres itself
 * (`pg_*`, `information_schema`) and not created by an extension
 * (`pg_depend.deptype = 'e'`). `catalog` is the system catalog that holds the
 * object; `oid` and `schemaName` are the SQL expressions for its oid and the
 * name of its schema.
 */
export declare const isAppObject: (sql: SqlClient, catalog: 'pg_namespace' | 'pg_class' | 'pg_proc', oid: string, schemaName: string) => import("effect/sql/Statement").Statement<import("effect/sql/SqlConnection").Row>;
