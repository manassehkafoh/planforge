#!/usr/bin/env bash
# Recreate the dev database and seed it. Usage: PF_APP_PASSWORD=... server/scripts/reset-dev.sh   (as a privileged DB role)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
"$HERE/setup-db.sh"
${PF_PSQL:-psql -v ON_ERROR_STOP=1 -q} -d "${PF_DB:-planforge}" -f "$HERE/seed-dev.sql"
echo "seeded"
