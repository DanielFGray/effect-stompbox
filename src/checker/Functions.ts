import { Effect } from 'effect'
import { SqlClient } from 'effect/sql/SqlClient'

import { isAppObject } from './Catalog.ts'
import { findings } from './Finding.ts'
import type { RoleContract } from './Roles.ts'

/**
 * C7: a SECURITY DEFINER function runs with its owner's rights, so every name
 * in its body must resolve to the object the author meant. That holds when
 * the function sets `search_path`, the visitor can create objects in no
 * schema on that path, and the visitor cannot put a temporary table in front
 * of it. Postgres searches `pg_temp` first for tables unless the path names it
 * last, so a visitor with TEMP on the database could shadow a table the body
 * names without a schema.
 */
export const c7 = Effect.fn('c7')(function* (roles: RoleContract) {
	const sql = yield* SqlClient
	const v = roles.visitor
	return yield* findings({
		check: 'C7',
		level: 'error',
		rule: 'A SECURITY DEFINER function sets a search_path the visitor cannot change.',
	})(sql`
    with f as (
      select p.oid,
             (select substring(c from '^search_path=(.*)$') from unnest(p.proconfig) c
              where c like 'search_path=%') as path
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where p.prosecdef and ${isAppObject(sql, 'pg_proc', 'p.oid', 'n.nspname')}
    ),
    entry as (
      select f.oid, btrim(e.name, ' "') as name, e.position, count(*) over (partition by f.oid) as entries
      from f, regexp_split_to_table(f.path, ',') with ordinality as e(name, position)
      where f.path is not null
    )
    select format('function %s', f.oid::regprocedure) as object,
           'does not set search_path' as problem
    from f where f.path is null
    union all
    select format('function %s', e.oid::regprocedure),
           format('the visitor can create objects in schema %I on its search_path', e.name)
    from entry e
    where to_regnamespace(quote_ident(e.name)) is not null
      and has_schema_privilege(${v}, to_regnamespace(quote_ident(e.name)), 'CREATE')
    union all
    select format('function %s', f.oid::regprocedure),
           'its search_path does not end with pg_temp, and the visitor can create temporary tables'
    from f
    where f.path is not null
      and has_database_privilege(${v}, current_database(), 'TEMP')
      and not exists (select 1 from entry e
        where e.oid = f.oid and e.name = 'pg_temp' and e.position = e.entries)
    order by 1, 2`)
})
