#!/usr/bin/env bash
# Restores a dump made by deploy/backup.sh into the production database.
# This REPLACES the current data, so it stops the application services first and
# asks for confirmation.
set -Eeuo pipefail

dump="${1:-}"
if [[ -z "$dump" || ! -f "$dump" ]]; then
  echo "Usage: $0 <path to foreman-*.dump>" >&2
  exit 2
fi

cd "$(dirname "$0")/.."
compose=(docker compose -p foreman-production --env-file .env.production -f docker-compose.prod.yml)

read -r -p "Replace the production database with $dump? Type 'restore' to continue: " answer
[[ "$answer" == "restore" ]] || { echo 'Aborted.'; exit 1; }

"${compose[@]}" stop coordinator worker dashboard
"${compose[@]}" exec -T postgres pg_restore -U foreman -d foreman --clean --if-exists --no-owner < "$dump"
"${compose[@]}" up -d
echo "Restored $dump"
