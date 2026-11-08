#!/usr/bin/env bash
# Create database, apply schema + migrations, create the least-privilege application role.
# Usage: PF_DB=planforge PF_APP_PASSWORD=... server/scripts/setup-db.sh   (run as a role that may CREATE DATABASE/ROLE)
set -euo pipefail
DB="${PF_DB:-planforge}"; PW="${PF_APP_PASSWORD:?set PF_APP_PASSWORD}"
HERE="$(cd "$(dirname "$0")/../.." && pwd)"
PSQL="${PF_PSQL:-psql -v ON_ERROR_STOP=1 -q}"
$PSQL -d postgres -c "DROP DATABASE IF EXISTS ${DB}" -c "CREATE DATABASE ${DB}"
$PSQL -d "$DB" -f "$HERE/db/schema.sql"
$PSQL -d "$DB" -f "$HERE/db/migrations/002_scheduling_rules.sql"
$PSQL -d postgres -c "DO \$\$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='pf_app') THEN CREATE ROLE pf_app LOGIN PASSWORD '${PW}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS; ELSE ALTER ROLE pf_app PASSWORD '${PW}'; END IF; END \$\$"
$PSQL -d "$DB" <<SQL
GRANT CONNECT ON DATABASE ${DB} TO pf_app;
GRANT USAGE ON SCHEMA pf TO pf_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pf TO pf_app;
-- append-only tables: no UPDATE / DELETE for the application role
REVOKE UPDATE, DELETE ON pf.audit_event, pf.plan_op, pf.baseline_task FROM pf_app;
-- tenants and users are provisioned by the identity pipeline / seed, not by the request path
REVOKE INSERT, UPDATE, DELETE ON pf.tenant FROM pf_app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA pf TO pf_app;
ALTER ROLE pf_app SET search_path = pf, public;
SQL
echo "database ${DB} ready"
