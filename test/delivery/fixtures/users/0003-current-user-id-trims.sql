-- Same signature, new body: the public SQL API keeps its shape.
create or replace function fx_auth.current_user_id() returns integer
  language sql stable
  as $$ select nullif(trim(current_setting('my.user_id', true)), '')::integer $$;
revoke all on function fx_auth.current_user_id() from public;
grant execute on function fx_auth.current_user_id() to :DATABASE_VISITOR;
