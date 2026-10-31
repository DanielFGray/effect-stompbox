import { Effect } from 'effect'
import { SqlClient } from 'effect/sql/SqlClient'

import { isAppObject } from './Catalog.ts'
import { findings } from './Finding.ts'
import type { RoleContract } from './Roles.ts'

/**
 * C5: every table the visitor can read or write has row-level security
 * enabled, and the visitor holds no privilege that row-level security does
 * not limit (TRUNCATE, REFERENCES, TRIGGER). A column grant counts as access
 * to the table. Tables in a schema the visitor cannot use are out of reach.
 */
export const c5 = Effect.fn('c5')(function* (roles: RoleContract) {
	const sql = yield* SqlClient
	const v = roles.visitor
	return yield* findings({
		check: 'C5',
		level: 'error',
		rule: 'Row-level security limits every table the visitor can reach.',
	})(sql`
    with t as (
      select c.oid, c.relrowsecurity
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where c.relkind in ('r', 'p')
        and ${isAppObject(sql, 'pg_class', 'c.oid', 'n.nspname')}
        and has_schema_privilege(${v}, n.oid, 'USAGE')
    )
    select format('table %s', t.oid::regclass) as object,
           'the visitor holds ' || string_agg(p, ', ' order by p) || ' and row-level security is disabled' as problem
    from t, unnest(array['DELETE', 'INSERT', 'SELECT', 'UPDATE']) p
    where not t.relrowsecurity
      and case when p = 'DELETE' then has_table_privilege(${v}, t.oid, p)
               else has_any_column_privilege(${v}, t.oid, p) end
    group by t.oid
    union all
    select format('table %s', t.oid::regclass),
           'the visitor holds ' || p || ', which row-level security does not limit'
    from t, unnest(array['REFERENCES', 'TRIGGER', 'TRUNCATE']) p
    where case when p = 'REFERENCES' then has_any_column_privilege(${v}, t.oid, p)
               else has_table_privilege(${v}, t.oid, p) end
    order by 1, 2`)
})

/**
 * C6: policies on a table with row-level security disabled do nothing, which
 * is an error. A table the visitor can reach, with row-level security on but
 * no policy that applies to the visitor, shows the visitor no rows; that is
 * usually a policy written for the wrong role, so it is for review. A table
 * the visitor cannot reach may deny every row on purpose, and is not reported.
 */
export const c6 = Effect.fn('c6')(function* (roles: RoleContract) {
	const sql = yield* SqlClient
	const v = roles.visitor
	const [errors, reviews] = yield* Effect.all([
		findings({
			check: 'C6',
			level: 'error',
			rule: 'A table with policies has row-level security enabled.',
		})(sql`
      select format('table %s', c.oid::regclass) as object,
             'has policies, but row-level security is disabled, so they do nothing' as problem
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where c.relkind in ('r', 'p') and ${isAppObject(sql, 'pg_class', 'c.oid', 'n.nspname')}
        and not c.relrowsecurity
        and exists (select 1 from pg_policy p where p.polrelid = c.oid)
      order by 1`),
		findings({
			check: 'C6',
			level: 'review',
			rule: 'A table the visitor can reach has a policy that applies to the visitor.',
		})(sql`
      select format('table %s', c.oid::regclass) as object,
             'the visitor can reach it, but no policy applies to the visitor, so it sees no rows' as problem
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where c.relkind in ('r', 'p') and ${isAppObject(sql, 'pg_class', 'c.oid', 'n.nspname')}
        and c.relrowsecurity
        and has_schema_privilege(${v}, n.oid, 'USAGE')
        and (has_table_privilege(${v}, c.oid, 'DELETE')
          or has_any_column_privilege(${v}, c.oid, 'SELECT, INSERT, UPDATE'))
        and not exists (
          select 1 from pg_policy p, unnest(p.polroles) r
          where p.polrelid = c.oid and (r = 0 or pg_has_role(${v}, r, 'USAGE')))
      order by 1`),
	])
	return [...errors, ...reviews]
})

/**
 * C8: a view runs its query with its owner's rights unless it is created
 * with `security_invoker`, so row-level security on the tables it reads
 * applies to the owner, not to the visitor. A materialized view stores its
 * rows and never applies row-level security. Either one that the visitor can
 * read shows rows the visitor's policies would hide.
 */
export const c8 = Effect.fn('c8')(function* (roles: RoleContract) {
	const sql = yield* SqlClient
	const v = roles.visitor
	return yield* findings({
		check: 'C8',
		level: 'error',
		rule: 'A view the visitor can read runs as the visitor (security_invoker).',
	})(sql`
    select format('view %s', c.oid::regclass) as object,
           case c.relkind
             when 'm' then 'is a materialized view the visitor can read; it ignores row-level security'
             else 'the visitor can read it, and it reads its tables as its owner (no security_invoker)'
           end as problem
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where c.relkind in ('v', 'm')
      and ${isAppObject(sql, 'pg_class', 'c.oid', 'n.nspname')}
      and has_schema_privilege(${v}, n.oid, 'USAGE')
      and has_any_column_privilege(${v}, c.oid, 'SELECT')
      and (c.relkind = 'm' or not exists (
        select 1 from unnest(c.reloptions) o where o ~* '^security_invoker=(true|on|yes|1)$'))
    order by 1`)
})
