#!/usr/bin/env bash
set -Eeuo pipefail

repository=/home/nkundra_be23/Foreman
revision="${SSH_ORIGINAL_COMMAND:-${1:-}}"

if [[ ! "$revision" =~ ^[0-9a-f]{40}$ ]]; then
  echo 'Expected a 40-character Git commit SHA.' >&2
  exit 2
fi

exec 9>/tmp/foreman-production-deploy.lock
flock -w 600 9

cd "$repository"
if [[ ! -f .env.production ]]; then
  echo 'Production environment file is missing.' >&2
  exit 1
fi
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo 'Production checkout has local changes; deployment stopped.' >&2
  exit 1
fi

git fetch --no-tags origin main
current_main="$(git rev-parse FETCH_HEAD)"
if [[ "$current_main" != "$revision" ]]; then
  echo "Skipping superseded commit $revision; main is $current_main."
  exit 0
fi

previous="$(git rev-parse HEAD)"
compose=(docker compose -p foreman-production --env-file .env.production -f docker-compose.prod.yml)

# Never block a deploy on a failed backup, but make the failure visible.
bash ./deploy/backup.sh || echo 'WARNING: pre-deploy database backup failed.' >&2

# Each step returns 1 on failure; `set -e` does not apply inside an `if` condition.
release() {
  git merge --ff-only "$1" || return 1
  "${compose[@]}" config --quiet || return 1
  "${compose[@]}" build coordinator worker dashboard || return 1
  "${compose[@]}" up -d --no-build || return 1
  curl --fail --silent --show-error --retry 12 --retry-delay 5 --retry-all-errors \
    https://foreman.naman.sbs/api/health >/dev/null || return 1
  curl --fail --silent --show-error --retry 12 --retry-delay 5 --retry-all-errors \
    --head https://foreman.naman.sbs/ >/dev/null || return 1
}

if ! release "$revision"; then
  echo "Deploy of $revision failed; rolling back to $previous." >&2
  # The tree was clean before the merge, so resetting discards nothing of value.
  git reset --hard "$previous"
  "${compose[@]}" build coordinator worker dashboard
  "${compose[@]}" up -d --no-build
  "${compose[@]}" ps
  echo "Rolled back to $previous. Database migrations are additive and were not reverted." >&2
  exit 1
fi

"${compose[@]}" ps
echo "Deployed $revision to https://foreman.naman.sbs"
