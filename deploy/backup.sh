#!/usr/bin/env bash
# Writes a compressed PostgreSQL dump of the production database and prunes old ones.
# Run it from cron, e.g.:  17 3 * * *  /home/nkundra_be23/Foreman/deploy/backup.sh
# Restore with:            deploy/restore.sh <dump file>
set -Eeuo pipefail

cd "$(dirname "$0")/.."
backups="${FOREMAN_BACKUP_DIR:-$HOME/foreman-backups}"
keep="${FOREMAN_BACKUP_KEEP:-14}"
compose=(docker compose -p foreman-production --env-file .env.production -f docker-compose.prod.yml)

mkdir -p "$backups"
chmod 700 "$backups"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
target="$backups/foreman-$stamp.dump"

# Dump to a temp name so an interrupted run never looks like a good backup.
"${compose[@]}" exec -T postgres pg_dump -U foreman -d foreman --format=custom > "$target.partial"
mv "$target.partial" "$target"

# Keep only the newest $keep dumps.
ls -1t "$backups"/foreman-*.dump 2>/dev/null | tail -n "+$((keep + 1))" | xargs -r rm --
echo "Wrote $target"
