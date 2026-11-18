/**
 * SQL condition: the object is an app object, not part of Postgres itself
 * (`pg_*`, `information_schema`) and not created by an extension
 * (`pg_depend.deptype = 'e'`). `catalog` is the system catalog that holds the
 * object; `oid` and `schemaName` are the SQL expressions for its oid and the
 * name of its schema.
 */
export const isAppObject = (sql, catalog, oid, schemaName) => sql `(
  ${sql.literal(schemaName)} !~ '^pg_' and ${sql.literal(schemaName)} <> 'information_schema'
  and not exists (select 1 from pg_depend e
    where e.classid = ${catalog}::regclass and e.objid = ${sql.literal(oid)} and e.deptype = 'e'))`;
