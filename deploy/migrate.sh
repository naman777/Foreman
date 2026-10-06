#!/bin/sh
# Applies every migrations/*.up.sql once, in filename order, and records it in
# schema_migrations. Databases created before tracking existed re-run the
# (idempotent) early migrations a single time.
set -eu
dir="${MIGRATIONS_DIR:-/migrations}"
psql -v ON_ERROR_STOP=1 -q -c "CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())"
for file in "$dir"/*.up.sql; do
  version="$(basename "$file" .up.sql)"
  applied="$(psql -At -v ON_ERROR_STOP=1 -c "SELECT 1 FROM schema_migrations WHERE version = '$version'")"
  if [ -n "$applied" ]; then
    echo "skip $version"
    continue
  fi
  echo "apply $version"
  psql -v ON_ERROR_STOP=1 -1 -f "$file"
  psql -v ON_ERROR_STOP=1 -q -c "INSERT INTO schema_migrations (version) VALUES ('$version')"
done
