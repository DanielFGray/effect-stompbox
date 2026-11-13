-- Written against version 1 of users and sessions, and never changed.
create schema fx_app;
grant usage on schema fx_app to :DATABASE_VISITOR;

create table fx_app.posts (
  id integer primary key generated always as identity,
  author integer not null default fx_auth.current_user_id() references fx_auth.users,
  body text not null
);
alter table fx_app.posts enable row level security;
create policy own_posts on fx_app.posts using (author = fx_auth.current_user_id());
grant select, insert on fx_app.posts to :DATABASE_VISITOR;
