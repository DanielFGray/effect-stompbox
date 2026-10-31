alter table fx_auth.sessions
  add column expires_at timestamptz not null default now() + interval '30 days';
