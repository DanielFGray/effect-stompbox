import { Effect, FileSystem, Schema } from 'effect'
import { SqlClient } from 'effect/sql/SqlClient'

import { isAppObject } from './Catalog.ts'
import { Finding, findings } from './Finding.ts'
import type { RoleContract } from './Roles.ts'

/**
 * Everything the visitor role can reach, one line per object, sorted: each
 * schema it can use; each table, view, sequence and column with its
 * privileges; each function it can execute; and each extension in a schema it can use, as
 * one line.
 * Objects in a schema the visitor cannot use are left out, because it cannot
 * name them. Lines name no role, so two databases built from different
 * migrations compare line by line.
 */
export const visitorReach = Effect.fn('visitorReach')(function* (roles: RoleContract) {
	const sql = yield* SqlClient
	const v = roles.visitor
	const rows = yield* sql`
    with app_schema as (
      select n.oid, n.nspname from pg_namespace n
      where ${isAppObject(sql, 'pg_namespace', 'n.oid', 'n.nspname')}
        and has_schema_privilege(${v}, n.oid, 'USAGE')
    ),
    rel as (
      select c.oid, c.relkind from pg_class c join app_schema s on s.oid = c.relnamespace
      where c.relkind in ('r', 'p', 'v', 'm', 'f', 'S')
        and ${isAppObject(sql, 'pg_class', 'c.oid', 's.nspname')}
    )
    select format('schema %I', nspname) as line from app_schema
    union all
    select format('%s %s %s', case r.relkind when 'S' then 'sequence' when 'v' then 'view' when 'm' then 'view' else 'table' end,
                  r.oid::regclass, x.privileges)
    from rel r, lateral (
      select string_agg(p, ',' order by p) as privileges
      from unnest(case when r.relkind = 'S' then array['SELECT', 'UPDATE', 'USAGE']
                       else array['DELETE', 'INSERT', 'REFERENCES', 'SELECT', 'TRIGGER', 'TRUNCATE', 'UPDATE'] end) p
      where case when r.relkind = 'S' then has_sequence_privilege(${v}, r.oid, p)
                 else has_table_privilege(${v}, r.oid, p) end
    ) x
    where x.privileges is not null
    union all
    select format('column %s.%I %s', r.oid::regclass, a.attname, x.privileges)
    from rel r join pg_attribute a on a.attrelid = r.oid and a.attnum > 0 and not a.attisdropped,
      lateral (
        select string_agg(p, ',' order by p) as privileges
        from unnest(array['INSERT', 'REFERENCES', 'SELECT', 'UPDATE']) p
        where has_column_privilege(${v}, r.oid, a.attnum, p) and not has_table_privilege(${v}, r.oid, p)
      ) x
    where r.relkind <> 'S' and x.privileges is not null
    union all
    select format('function %s', p.oid::regprocedure)
    from pg_proc p join app_schema s on s.oid = p.pronamespace
    where has_function_privilege(${v}, p.oid, 'EXECUTE')
      and ${isAppObject(sql, 'pg_proc', 'p.oid', 's.nspname')}
    union all
    select format('extension %I %s in %I', x.extname, x.extversion, n.nspname)
    from pg_extension x join pg_namespace n on n.oid = x.extnamespace
    where x.extname <> 'plpgsql' and has_schema_privilege(${v}, n.oid, 'USAGE')
    order by 1`
	const decoded = yield* Schema.decodeUnknownEffect(
		Schema.Array(Schema.Struct({ line: Schema.String })),
	)(rows)
	return decoded.map((row) => row.line)
})

/**
 * C3: the visitor reaches nothing the surface file does not list. The file
 * records an approved state, so it is written from a known-good database,
 * never from the change under review. A line the file lists but the visitor
 * no longer reaches is a review finding: the file is out of date.
 */
export const c3 = (reach: ReadonlyArray<string>, surface: ReadonlyArray<string>) => {
	const approved = new Set(surface)
	const reached = new Set(reach)
	const info = {
		check: 'C3',
		rule: "The visitor's reach has not grown beyond the approved visitor surface file.",
	}
	return [
		...reach
			.filter((line) => !approved.has(line))
			.map(
				(line) =>
					new Finding({
						...info,
						level: 'error',
						object: line,
						problem: 'the visitor reaches this; the surface file does not list it',
					}),
			),
		...surface
			.filter((line) => !reached.has(line))
			.map(
				(line) =>
					new Finding({
						...info,
						level: 'review',
						object: line,
						problem: 'the surface file lists this; the visitor no longer reaches it',
					}),
			),
	]
}

/** Reads a visitor surface file: one line per object; `#` starts a comment. */
export const readSurface = Effect.fn('readSurface')(function* (path: string) {
	const fs = yield* FileSystem.FileSystem
	const text = yield* fs.readFileString(path)
	return text
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line !== '' && !line.startsWith('#'))
})

export const writeSurface = Effect.fn('writeSurface')(function* (
	path: string,
	reach: ReadonlyArray<string>,
) {
	const fs = yield* FileSystem.FileSystem
	yield* fs.writeFileString(path, [surfaceHeader, ...reach, ''].join('\n'))
})

const surfaceHeader = `# Visitor surface: everything the visitor role can reach.
# Written by \`checker write-surface\` from a known-good database. Review each
# change to this file as a change to what anonymous and signed-in users reach.`

/**
 * C4: no default privilege makes new functions executable by PUBLIC, which
 * reaches every role, including the API login. A default grant to the visitor
 * is the convention: functions in the visitor's schemas are callable unless
 * revoked, and C3 shows each new one as a change to the surface file. Postgres grants EXECUTE to PUBLIC on every new function unless
 * a global default-privilege entry for the creating role leaves PUBLIC out;
 * a per-schema entry can only add grants, never remove that one.
 */
export const c4 = Effect.fn('c4')(function* (roles: RoleContract) {
	const sql = yield* SqlClient
	const { owner } = roles
	return yield* findings({
		check: 'C4',
		level: 'error',
		rule: 'No default privilege grants EXECUTE on new functions to PUBLIC.',
	})(sql`
    with creator as (
      select p.proowner as role
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where ${isAppObject(sql, 'pg_proc', 'p.oid', 'n.nspname')}
      union
      select to_regrole(${owner}) where to_regrole(${owner}) is not null
    )
    select format('default privileges for role %s', c.role::regrole) as object,
           'new functions are executable by PUBLIC: no global entry revokes the built-in grant' as problem
    from creator c
    where not exists (select 1 from pg_default_acl d
      where d.defaclrole = c.role and d.defaclnamespace = 0 and d.defaclobjtype = 'f')
    union all
    select format('default privileges for role %s%s', c.role::regrole, coalesce(' in schema ' || quote_ident(n.nspname), '')),
           'new functions are executable by PUBLIC'
    from pg_default_acl d
      join creator c on c.role = d.defaclrole
      left join pg_namespace n on n.oid = d.defaclnamespace,
      aclexplode(d.defaclacl) a
    where d.defaclobjtype = 'f' and a.privilege_type = 'EXECUTE'
      and a.grantee = 0
    order by 1, 2`)
})
