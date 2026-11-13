create schema fx_auth;
grant usage on schema fx_auth to :DATABASE_VISITOR;

create table fx_auth.users (
  id integer primary key generated always as identity,
  name text not null
);

create function fx_auth.current_user_id() returns integer
  language sql stable
  as $$ select nullif(current_setting('my.user_id', true), '')::integer $$;
revoke all on function fx_auth.current_user_id() from public;
grant execute on function fx_auth.current_user_id() to :DATABASE_VISITOR;
