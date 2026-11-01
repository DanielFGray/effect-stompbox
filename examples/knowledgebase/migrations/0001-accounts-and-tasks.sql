-- The app's profile table: the username lives here, not in the auth package.
-- Its id is the user's id in auth.users, so one row per user.
create extension if not exists citext;

create schema app_public;
grant usage on schema app_public to :DATABASE_VISITOR;

create table app_public.accounts (
  id uuid primary key references auth.users on delete cascade,
  username citext not null unique,
  created_at timestamptz not null default now()
);
alter table app_public.accounts enable row level security;
create policy select_own on app_public.accounts
  for select using (id = auth.current_user_id());
grant select on app_public.accounts to :DATABASE_VISITOR;

-- account_id defaults to the signed-in user, so app code never passes it, and
-- the policy refuses a row for any other user.
create table app_public.tasks (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null default auth.current_user_id()
    references app_public.accounts on delete cascade,
  title text not null,
  status text not null default 'open' check (status in ('open', 'completed')),
  due_date date,
  completed_at timestamptz,
  created_at timestamptz not null default now()
);
create index tasks_account_status on app_public.tasks (account_id, status);
alter table app_public.tasks enable row level security;
create policy own_tasks on app_public.tasks
  using (account_id = auth.current_user_id())
  with check (account_id = auth.current_user_id());
grant select, delete on app_public.tasks to :DATABASE_VISITOR;
grant insert (title, due_date), update (title, due_date, status, completed_at)
  on app_public.tasks to :DATABASE_VISITOR;
