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

git merge --ff-only "$revision"
compose=(docker compose -p foreman-production --env-file .env.production -f docker-compose.prod.yml)
"${compose[@]}" config --quiet
"${compose[@]}" build coordinator worker dashboard
"${compose[@]}" up -d --no-build

curl --fail --silent --show-error --retry 12 --retry-delay 5 --retry-all-errors \
  https://foreman.naman.sbs/api/health >/dev/null
curl --fail --silent --show-error --retry 12 --retry-delay 5 --retry-all-errors \
  --head https://foreman.naman.sbs/ >/dev/null
"${compose[@]}" ps
echo "Deployed $revision to https://foreman.naman.sbs"
