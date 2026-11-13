-- Password sign-in: Argon2id hashes, the failure count and the lockout
-- (docs/auth/design.md, "The feature passwords"). The host creates pgsodium
-- as a superuser (ADR 0002); the owner cannot.

-- A user with no password has no row.
create table auth_private.passwords (
  user_id uuid primary key references auth.users on delete cascade,
  -- The 128-byte result of crypto_pwhash_str, NUL padding included:
  -- crypto_pwhash_str_verify reads it as a C string.
  hash bytea not null,
  failed_attempts int not null default 0 check (failed_attempts >= 0),
  first_failed_at timestamptz,
  updated_at timestamptz not null default now()
);
alter table auth_private.passwords enable row level security;

-- Stores the hash of `password` and clears the failure count.
create function auth_private.set_password(user_id uuid, password text) returns void
  language sql volatile
  set search_path = pg_catalog, pg_temp
  as $$
    insert into auth_private.passwords (user_id, hash)
    values (set_password.user_id,
            pgsodium.crypto_pwhash_str(convert_to(set_password.password, 'UTF8')))
    on conflict (user_id) do update
    set hash = excluded.hash, failed_attempts = 0, first_failed_at = null,
        updated_at = now()
  $$;

-- True when `password` is the user's password. Raises LOCKD after 3 failed
-- attempts within 5 minutes. A wrong password records the failure and
-- returns false instead of raising, so the record commits.
create function auth_private.check_password(user_id uuid, password text) returns boolean
  language plpgsql volatile
  set search_path = pg_catalog, pg_temp
  as $$
  declare
    v_window constant interval = interval '5 minutes';
    v_row auth_private.passwords;
  begin
    select * into v_row from auth_private.passwords p
    where p.user_id = check_password.user_id
    for update;

    if not found then
      -- One hash, so the reply time does not show whether the user exists.
      perform pgsodium.crypto_pwhash_str(convert_to(coalesce(password, ''), 'UTF8'));
      return false;
    end if;

    if v_row.first_failed_at > now() - v_window and v_row.failed_attempts >= 3 then
      raise exception 'too many failed sign-in attempts' using errcode = 'LOCKD';
    end if;

    if password is not null
      and pgsodium.crypto_pwhash_str_verify(v_row.hash, convert_to(password, 'UTF8')) then
      update auth_private.passwords p
      set failed_attempts = 0, first_failed_at = null
      where p.user_id = check_password.user_id;
      return true;
    end if;

    update auth_private.passwords p
    set failed_attempts = case when p.first_failed_at > now() - v_window
                               then p.failed_attempts + 1 else 1 end,
        first_failed_at = case when p.first_failed_at > now() - v_window
                               then p.first_failed_at else now() end
    where p.user_id = check_password.user_id;
    return false;
  end
  $$;

revoke all on function auth_private.set_password(uuid, text) from public;
revoke all on function auth_private.check_password(uuid, text) from public;
