-- Users and sessions, and the session bridge that policies call
-- (docs/adr/0004-session-bridge.md, docs/auth/design.md).

create schema auth;
revoke all on schema auth from public;
grant usage on schema auth to :DATABASE_VISITOR;

create schema auth_private;
revoke all on schema auth_private from public;

-- Identity only. Each app keeps its profile columns in its own table, with a
-- foreign key to auth.users(id).
create table auth.users (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now()
);
alter table auth.users enable row level security;

-- The server creates, validates and revokes sessions on the owner pool. It
-- stores only the SHA-256 hash of each session's secret.
create table auth_private.sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users on delete cascade,
  secret_hash bytea not null check (octet_length(secret_hash) = 32),
  created_at timestamptz not null default now(),
  refreshed_at timestamptz not null default now(),
  expires_at timestamptz not null,
  absolute_expires_at timestamptz not null,
  check (created_at <= refreshed_at),
  check (refreshed_at < expires_at),
  check (expires_at <= absolute_expires_at)
);
alter table auth_private.sessions enable row level security;
create index sessions_user_id on auth_private.sessions (user_id);

-- The session named by my.session_id, when it is live. Only the server sets
-- my.session_id, after it validates the session token.
create function auth.current_session_id() returns uuid
  language sql stable security definer
  set search_path = pg_catalog, pg_temp
  as $$
    select s.id from auth_private.sessions s
    where s.id = nullif(current_setting('my.session_id', true), '')::uuid
      and s.expires_at > now()
  $$;

-- The user of the live session, or null.
create function auth.current_user_id() returns uuid
  language sql stable security definer
  set search_path = pg_catalog, pg_temp
  as $$
    select s.user_id from auth_private.sessions s
    where s.id = nullif(current_setting('my.session_id', true), '')::uuid
      and s.expires_at > now()
  $$;

revoke all on function auth.current_session_id() from public;
revoke all on function auth.current_user_id() from public;
grant execute on function auth.current_session_id() to :DATABASE_VISITOR;
grant execute on function auth.current_user_id() to :DATABASE_VISITOR;
