import { Config, Effect, Option, Schema } from 'effect';
import { SqlClient } from 'effect/sql/SqlClient';
import * as SqlSchema from 'effect/sql/SqlSchema';
import { isAppObject } from './Catalog.js';
import { findings } from './Finding.js';
/**
 * The role contract of ADR 0002. The provisioner names every role after the
 * database it made, and that database's owner role also owns its `_test` and
 * `_shadow` copies. So the names follow from the owner of the connected
 * database, not from its name: a name ending in `_test` may be the app's own.
 */
export class RoleContract extends Schema.Class('RoleContract')({
    owner: Schema.String,
    visitor: Schema.String,
    api: Schema.String,
}) {
}
/**
 * The roles of the connected database. The visitor role's name follows from
 * the owner's name unless `DATABASE_VISITOR` names it, for a host whose roles
 * use other names.
 */
export const roleContract = Effect.gen(function* () {
    const sql = yield* SqlClient;
    const visitor = yield* Config.option(Config.String('DATABASE_VISITOR'));
    const derived = yield* SqlSchema.findOne({
        Request: Schema.Void,
        Result: RoleContract,
        execute: () => sql `
      select o.rolname as owner,
             regexp_replace(o.rolname, '_owner$', '') || '_visitor' as visitor,
             'alchemy_' || regexp_replace(o.rolname, '_owner$', '') || '_api' as api
      from pg_database d join pg_roles o on o.oid = d.datdba
      where d.datname = current_database()`,
    })(undefined);
    return new RoleContract({
        owner: derived.owner,
        api: derived.api,
        visitor: Option.getOrElse(visitor, () => derived.visitor),
    });
});
/**
 * C1: the API login can switch to the visitor role but does not inherit its
 * rights, cannot reach the owner role, owns nothing, and holds no privilege
 * on an app object except through the visitor role.
 */
export const c1 = Effect.fn('c1')(function* (roles) {
    const sql = yield* SqlClient;
    const { api, visitor, owner } = roles;
    return yield* findings({
        check: 'C1',
        level: 'error',
        rule: 'The API login acts only by switching to the visitor role (ADR 0002).',
    })(sql `
    with r as (select to_regrole(${api}) as api, to_regrole(${visitor}) as visitor, to_regrole(${owner}) as owner)
    select ${api} as object, 'does not exist' as problem from r where api is null
    union all
    select ${api}, problem from r join pg_roles p on p.oid = r.api,
      lateral (values
        (not p.rolcanlogin, 'cannot log in'),
        (p.rolsuper, 'is a superuser'),
        (p.rolbypassrls, 'has BYPASSRLS'),
        (r.visitor is not null and not pg_has_role(r.api, r.visitor, 'SET'), 'cannot switch to the visitor role ' || ${visitor}),
        (r.visitor is not null and pg_has_role(r.api, r.visitor, 'USAGE'), 'inherits the rights of the visitor role ' || ${visitor} || ' without switching'),
        (r.owner is not null and pg_has_role(r.api, r.owner, 'MEMBER'), 'can reach the owner role ' || ${owner})
      ) as v(broken, problem)
    where broken
    union all
    ${ownedBy(sql, api)}
    union all
    select g.object, 'holds ' || g.privilege || ' through ' || g.grantee::regrole::text
    from r, ${appGrants(sql)} as g
    where r.api is not null
      and g.grantee <> 0
      and g.grantee is distinct from r.visitor
      and pg_has_role(r.api, g.grantee, 'USAGE')
    order by 1, 2`);
});
/**
 * C2: the visitor role cannot log in, has no power beyond its grants, owns
 * nothing and is a member of no other role.
 */
export const c2 = Effect.fn('c2')(function* (roles) {
    const sql = yield* SqlClient;
    const { visitor } = roles;
    return yield* findings({
        check: 'C2',
        level: 'error',
        rule: 'The visitor role is a NOLOGIN group that owns nothing and reaches no other role (ADR 0002).',
    })(sql `
    with r as (select to_regrole(${visitor}) as visitor)
    select ${visitor} as object, 'does not exist' as problem from r where visitor is null
    union all
    select ${visitor}, problem from r join pg_roles p on p.oid = r.visitor,
      lateral (values
        (p.rolcanlogin, 'can log in'),
        (p.rolsuper, 'is a superuser'),
        (p.rolbypassrls, 'has BYPASSRLS')
      ) as v(broken, problem)
    where broken
    union all
    select ${visitor}, 'is a member of ' || m.rolname
    from r join pg_roles m on m.oid <> r.visitor and pg_has_role(r.visitor, m.oid, 'MEMBER')
    union all
    ${ownedBy(sql, visitor)}
    order by 1, 2`);
});
/** Objects in this database, and shared objects, that `role` owns. */
const ownedBy = (sql, role) => sql `
  select pg_describe_object(d.classid, d.objid, d.objsubid), 'is owned by ' || ${role}
  from pg_shdepend d
  where d.refclassid = 'pg_authid'::regclass
    and d.refobjid = to_regrole(${role})
    and d.deptype = 'o'
    and d.dbid in (0, (select oid from pg_database where datname = current_database()))`;
/**
 * Every explicit grant on a schema, table, view, sequence or function outside
 * the system schemas and outside extensions: (object, privilege, grantee oid).
 * A grantee of 0 is PUBLIC.
 */
const appGrants = (sql) => sql `(
  select format('schema %s', n.nspname) as object, a.privilege_type as privilege, a.grantee
  from pg_namespace n, aclexplode(n.nspacl) a
  where ${isAppObject(sql, 'pg_namespace', 'n.oid', 'n.nspname')}
  union all
  select format('relation %s', c.oid::regclass), a.privilege_type, a.grantee
  from pg_class c join pg_namespace n on n.oid = c.relnamespace, aclexplode(c.relacl) a
  where ${isAppObject(sql, 'pg_class', 'c.oid', 'n.nspname')}
  union all
  select format('function %s', p.oid::regprocedure), a.privilege_type, a.grantee
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace, aclexplode(p.proacl) a
  where ${isAppObject(sql, 'pg_proc', 'p.oid', 'n.nspname')}
)`;
