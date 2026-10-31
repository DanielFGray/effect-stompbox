create table fx_auth.sessions (
  id uuid primary key default gen_random_uuid(),
  user_id integer not null references fx_auth.users on delete cascade
);
