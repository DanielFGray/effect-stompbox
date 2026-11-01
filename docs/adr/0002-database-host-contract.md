---
status: proposed
---

# The project declares its roles; the database host creates them

An app connects to Postgres through two connection strings and one role name.
The project does not create roles or databases. It declares the roles it
needs, and a separate provisioner creates them on the database host. Any
Postgres host that can run that provisioner can serve the app, so moving to
another vendor means running the provisioner there and changing the connection
strings.

This matches every app surveyed: no app creates its roles in SQL. The platform
(`ops dev db` and server-ansible) creates them from `cartridge.json`
(`docs/matrix/README.md`, row 4).

## The role contract

The names follow server-ansible's convention
(`server-ansible/tools/alchemy/src/PostgresDatabase.ts:63-66`,
`src/Cartridge.ts:201-202`):

| Role            | Name                     | Login | Member of            | Purpose                                                                                         |
| --------------- | ------------------------ | ----- | -------------------- | ----------------------------------------------------------------------------------------------- |
| Owner           | `<db>_owner`             | no    |                      | Owns the database and every object in it. Bypasses RLS as owner.                                |
| Visitor         | `<db>_visitor`           | no    |                      | Holds the grants that app SQL uses. RLS applies.                                                |
| Migration login | `alchemy_<db>_migration` | yes   | owner, inherits      | Runs migrations, the worker, and session checks (`docs/auth/design.md`).                        |
| API login       | `alchemy_<db>_api`       | yes   | visitor, `NOINHERIT` | The visitor pool. Has no rights until a transaction runs `set_config('role', <visitor>, true)`. |

The app receives:

- `DATABASE_URL`: the migration login (the owner pool);
- `AUTH_DATABASE_URL`: the API login (the visitor pool);
- `DATABASE_VISITOR`: the visitor role name.

The project checks the contract at startup and in its tests: the API login
does not inherit, is a member of the visitor role, and has no `BYPASSRLS`; the
visitor role does not own any object. A host that breaks the contract fails
the check instead of serving requests without RLS.

## Provisioners

- **server-ansible**: its Alchemy resource `Postgres.Database` already creates
  this contract, with logins issued by OpenBao
  (`server-ansible/tools/alchemy/src/PostgresProvisioning.ts`). It runs in
  production and in `ops dev db`.
- **Plain SQL**: one idempotent script that a role with `CREATEROLE` runs. It
  serves local development without server-ansible, CI, and hosts where the
  operator has SQL access only.
- **Alchemy**: Alchemy v2 is built on Effect v4. A provisioner could be an
  Alchemy resource that the app's own stack declares. Extracting it from
  server-ansible needs the role setup separated from the OpenBao login
  issuance.

## To verify before acceptance

These are assumptions about managed hosts, not tested:

- Neon, RDS and Supabase let a non-superuser role create roles and grant
  membership as above.
- Each host offers the extensions the auth SQL needs. The feature
  `passwords` needs `pgsodium`, which is not a trusted extension, so the host
  creates it as a superuser; most managed hosts do not offer it. pgsodium
  grants usage on its schema to `PUBLIC`, so the host also revokes that and
  grants usage to the owner role only; otherwise the visitor can call it
  (check C3). Apps add
  others (`citext`, `pg_hashids`, `vector`) that some hosts do not offer.
- The host keeps bound parameters out of the server log at every
  `log_statement` level: `log_parameter_max_length` and
  `log_parameter_max_length_on_error` are 0, set where an app login cannot
  change them (server-ansible sets them on the server's command line).
  Password sign-in sends the password as a bound parameter.
- Extensions: server-ansible creates them as a superuser, so that untrusted
  extensions work (`PostgresProvisioning.ts:248`). Managed hosts give no
  superuser, so the provisioner can create only the extensions the host
  allows.
- `graphile-migrate commit` needs a third URL with rights to create the
  shadow database (`ROOT_DATABASE_URL`, written by `ops dev db`). This is a
  development-only need, and the role contract does not cover it yet.
- Rotated passwords: OpenBao issues logins with a time to live. Nomad restarts
  the task when a value changes, so the app reads the URL once at startup.
  Another host's rotation may need the pool to reconnect with a new password.
