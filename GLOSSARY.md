# effect-backend

A backend framework for Effect apps on Postgres, where row-level security
decides what each request may read and write.

## Database roles

**Owner role**:
The role that owns the app's database objects. Row-level security does not
apply to it.
_Avoid_: root, admin, superuser

**Visitor role**:
The role whose grants and policies limit what a request may do.
_Avoid_: anon, public role, user role

**API login**:
The login role of the visitor pool. It has no rights of its own until a
transaction switches it to the visitor role.
_Avoid_: authenticator (in new text), auth user

**Migration login**:
The login role that acts as the owner role, for migrations and the worker.
_Avoid_: root login

**Owner pool**:
Connections made as the migration login.
_Avoid_: root pool

**Visitor pool**:
Connections made as the API login.
_Avoid_: auth pool, authenticator pool

## Delivery

**Database host**:
A Postgres server that holds the app's database, from any vendor.
_Avoid_: provider (Alchemy uses that word for its own concept)

**Provisioner**:
A program that creates the app's database and roles on a database host to
match the role contract.

**Role contract**:
The roles, logins and memberships that the framework requires of a database
host.
