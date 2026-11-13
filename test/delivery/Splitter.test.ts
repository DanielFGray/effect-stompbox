import { assert, describe, it } from '@effect/vitest'
import { Result } from 'effect'

import { prepareSql } from '../../src/delivery/Splitter.ts'

const roles = new Map([
	[':DATABASE_VISITOR', '"db_visitor"'],
	[':DATABASE_OWNER', '"db_owner"'],
])

const statements = (text: string) =>
	Result.map(prepareSql(text, roles), (p) => p.statements)

const refusal = (text: string) =>
	Result.match(prepareSql(text, roles), {
		onSuccess: () => undefined,
		onFailure: (e) => ({ reason: e.reason, line: e.line }),
	})

describe('prepareSql', () => {
	it('splits at semicolons in code only', () => {
		assert.deepStrictEqual(
			statements(`
create function f() returns text language sql as $$ select 'a;b' $$;
create function g() returns text language plpgsql as $body$
begin
  return $x$;$x$; -- the inner tag ends nothing
end
$body$;
select E'it\\'s;', 'it''s;', "semi;colon", 1::int;
/* a /* nested; */ comment; */ select 2;
-- only a comment;
`),
			Result.succeed([
				"create function f() returns text language sql as $$ select 'a;b' $$",
				'create function g() returns text language plpgsql as $body$\nbegin\n  return $x$;$x$; -- the inner tag ends nothing\nend\n$body$',
				`select E'it\\'s;', 'it''s;', "semi;colon", 1::int`,
				'/* a /* nested; */ comment; */ select 2',
			]),
		)
	})

	it('treats $ after an identifier and $1 as code, not a body', () => {
		assert.deepStrictEqual(
			statements('select a$b$ from t; prepare p as select $1;'),
			Result.succeed(['select a$b$ from t', 'prepare p as select $1']),
		)
	})

	it('fills placeholders in code, leaves casts and comments', () => {
		assert.deepStrictEqual(
			Result.map(
				prepareSql(
					'grant select on t to :DATABASE_VISITOR; -- :DATABASE_VISITOR\nselect x::DATABASE_OWNER;',
					roles,
				),
				(p) => p.text,
			),
			Result.succeed(
				'grant select on t to "db_visitor"; -- :DATABASE_VISITOR\nselect x::DATABASE_OWNER;',
			),
		)
	})

	it('refuses a placeholder inside quoted text, and an unknown one', () => {
		assert.deepStrictEqual(
			refusal("select 1;\ndo $$ begin execute 'grant x to :DATABASE_VISITOR'; end $$;"),
			{
				reason:
					'placeholder :DATABASE_VISITOR inside quoted text; read the role name from a function instead',
				line: 2,
			},
		)
		assert.deepStrictEqual(refusal('grant x to :DATABASE_ADMIN;'), {
			reason: 'unknown placeholder :DATABASE_ADMIN',
			line: 1,
		})
	})

	it('refuses SQL outside the subset, with the statement line', () => {
		const cases = [
			['\\set ON_ERROR_STOP on', 'psql meta-command'],
			['copy t from stdin', 'COPY through the client'],
			['begin', 'transaction control; the runner owns the transaction'],
			['COMMIT', 'transaction control; the runner owns the transaction'],
			[
				'create index concurrently i on t (a)',
				'CONCURRENTLY cannot run in a transaction',
			],
			['vacuum t', 'cannot run in a transaction'],
			[
				'drop function f() cascade',
				'CASCADE would silently drop dependent objects, such as an app policy',
			],
			[
				'alter table t drop column c cascade',
				'CASCADE would silently drop dependent objects, such as an app policy',
			],
		] as const
		for (const [sql, reason] of cases)
			assert.deepStrictEqual(refusal(`select 1;\n\n${sql};`), { reason, line: 3 }, sql)
	})

	it('accepts foreign key cascades and words inside bodies', () => {
		assert.deepStrictEqual(
			statements(
				'create table t (u int references u on delete cascade on update cascade);\ndo $$ begin perform 1; commit; end $$;',
			),
			Result.succeed([
				'create table t (u int references u on delete cascade on update cascade)',
				'do $$ begin perform 1; commit; end $$',
			]),
		)
	})

	it('refuses unterminated quoting', () => {
		assert.deepStrictEqual(refusal("select 1;\nselect 'abc"), {
			reason: 'unterminated string',
			line: 2,
		})
		assert.deepStrictEqual(refusal('select $f$ abc'), {
			reason: 'unterminated $f$ body',
			line: 1,
		})
		assert.deepStrictEqual(refusal('/* a /* b */'), {
			reason: 'unterminated comment',
			line: 1,
		})
	})
})
