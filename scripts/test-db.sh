#!/usr/bin/env bash
# Usage: scripts/test-db.sh <database> <prefix>
#
# Creates a test database in the local ops-dev-pg17 container, with the role
# contract of ADR 0002, and writes its two login URLs to .env as
# <prefix>_OWNER_URL and <prefix>_API_URL. The tests use:
#   scripts/test-db.sh effect_backend_dev_visitor VISITOR
#   scripts/test-db.sh effect_backend_dev_delivery DELIVERY
#
# The shared-cluster provisioner (`ops dev db up`) does the same once the
# server runs the current server-ansible; until then this script stands in for
# it. Running it again drops and recreates the database and the roles.
set -euo pipefail

db=$1
prefix=$2
owner=${db}_owner
visitor=${db}_visitor
api=alchemy_${db}_api
migration=alchemy_${db}_migration
container=ops-dev-pg17
port=$(docker port "$container" 5432/tcp | cut -d: -f2)

api_password=$(openssl rand -hex 24)
migration_password=$(openssl rand -hex 24)

docker exec -i "$container" psql -U postgres -qX -v ON_ERROR_STOP=1 -d postgres <<SQL
drop database if exists $db with (force);
drop role if exists $api;
drop role if exists $migration;
drop role if exists $visitor;
drop role if exists $owner;
create role $owner nologin;
create role $visitor nologin;
create role $api login noinherit password '$api_password';
create role $migration login password '$migration_password';
grant $owner to $migration with inherit true, set true;
alter role $migration set role = '$owner';
grant $visitor to $api with inherit false, set true;
create database $db owner $owner;
revoke all on database $db from public;
grant connect on database $db to $api, $migration;
SQL

docker exec -i "$container" psql -U postgres -qX -v ON_ERROR_STOP=1 -d "$db" <<SQL
alter schema public owner to $owner;
revoke all on schema public from public;
grant usage on schema public to $visitor;
alter default privileges for role $owner revoke execute on functions from public;
SQL

touch .env
grep -v "^${prefix}_\\(OWNER\\|API\\)_URL=" .env > .env.tmp || true
{
	cat .env.tmp
	echo "${prefix}_OWNER_URL=postgres://$migration:$migration_password@127.0.0.1:$port/$db"
	echo "${prefix}_API_URL=postgres://$api:$api_password@127.0.0.1:$port/$db"
} > .env
rm .env.tmp
echo "created $db; wrote ${prefix}_OWNER_URL and ${prefix}_API_URL to .env"
