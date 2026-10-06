# Production deployment

Foreman runs on the `instance-operator` Compute Engine VM under `/home/nkundra_be23/Foreman`. The public URL is https://foreman.naman.sbs. The former Operator Compose project is stopped; its containers and volumes are retained for rollback. Foreman uses its own PostgreSQL, Redis, and S3-compatible RustFS volumes. Caddy reuses the existing certificate volumes and has issued a certificate for the Foreman hostname. The old `operator.naman.sbs` DNS name no longer resolves and is not served by the current Caddy configuration.

The application services are the TypeScript coordinator and workers, plus the Next.js dashboard. RustFS supplies S3-compatible artifact storage. Only Caddy publishes host ports 80 and 443. The dashboard calls the limited public demo API through `/api/demo`; artifact download URLs use the same HTTPS origin. Worker and administrative API routes remain private and are not forwarded by the public proxy.

## Environment

From the VM checkout, create the production environment once:

```sh
python3 deploy/create_env.py --domain foreman.naman.sbs --output .env.production
chmod 600 .env.production
```

The generator refuses to overwrite an existing file. Keep `.env.production` private and back it up through the VM's secret storage process. Never commit or print its credentials. The development `.env` is not used for production.

## Continuous deployment

GitHub Actions runs the coordinator and worker TypeScript tests (the coordinator's integration tests execute its SQL against a real PostgreSQL service), dashboard lint and production build, and an end-to-end smoke test of the full Compose stack on pull requests and pushes. A successful push to `main` then deploys that exact commit to the VM, takes a database backup first, and checks the public HTTPS health and dashboard routes. If a check fails, the script resets the checkout to the previous commit and redeploys it automatically; migrations are additive, so the older code keeps working against the newer schema. Deployments run one at a time. The workflow is in `.github/workflows/ci-cd.yml`; its `production` job uses the `FOREMAN_DEPLOY_SSH_KEY` repository secret and the VM host key pinned in `.github/foreman_known_hosts`. The VM's deploy key is restricted to `deploy/ci-deploy.sh`. The script refuses a dirty tracked checkout, a missing `.env.production`, or a commit that is no longer the tip of `main`.

The first deployment setup requires a dedicated SSH key in the GitHub secret, its public key in the VM user's `authorized_keys`, and a clean VM checkout at the latest `main` commit. The VM retains `.env.production` locally; it is never sent to GitHub Actions. Follow runs in the repository's **Actions** tab. The VM checkout's HEAD is the deployed revision after a successful run.

## Manual deploy updates

Transfer reviewed source changes into the VM checkout, then run:

```sh
cd /home/nkundra_be23/Foreman
docker compose -p foreman-production --env-file .env.production -f docker-compose.prod.yml config --quiet
docker compose -p foreman-production --env-file .env.production -f docker-compose.prod.yml build coordinator worker dashboard
docker compose -p foreman-production --env-file .env.production -f docker-compose.prod.yml up -d --no-build
docker compose -p foreman-production --env-file .env.production -f docker-compose.prod.yml ps
```

The migration helper (`deploy/migrate.sh`) applies each `migrations/*.up.sql` file once, in order, and records it in the `schema_migrations` table before the coordinator starts. Add a new numbered pair of files to change the schema; no Compose edit is needed. The worker has Docker socket access to run jobs. This grants the worker broad control of the VM's Docker daemon, so restrict VM access and treat the worker image as trusted code.

## Verify

```sh
curl -fsSI https://foreman.naman.sbs/
curl -fsS https://foreman.naman.sbs/api/health
curl -sSI http://foreman.naman.sbs/
```

The first two calls must succeed with a valid TLS certificate; the HTTP call must return a 308 redirect to HTTPS. Check `docker compose ... ps` for healthy services. To test job creation, success, failure, timeout, artifacts, concurrency, and WebSocket updates, run from the VM checkout:

```sh
docker compose -p foreman-production --env-file .env.production -f docker-compose.prod.yml run --rm -T \
  -v /home/nkundra_be23/Foreman/scripts/node-smoke.mjs:/smoke.mjs:ro \
  -e FOREMAN_API_URL=http://coordinator:8080 \
  -e FOREMAN_DASHBOARD_URL=http://dashboard:3000 \
  -e FOREMAN_MIN_WORKERS=2 \
  worker node /smoke.mjs
```

The smoke test creates real test jobs and artifacts. Review logs with `docker compose -p foreman-production --env-file .env.production -f docker-compose.prod.yml logs --tail 100 coordinator worker dashboard caddy`.

## Backups and restore

`deploy/backup.sh` writes a compressed `pg_dump` of the database to `~/foreman-backups` (override with `FOREMAN_BACKUP_DIR`) and keeps the newest 14 (`FOREMAN_BACKUP_KEEP`). Every deploy runs it first. Schedule it nightly on the VM:

```sh
17 3 * * *  /home/nkundra_be23/Foreman/deploy/backup.sh >> /home/nkundra_be23/foreman-backups/backup.log 2>&1
```

`deploy/restore.sh <dump>` stops the application services, replaces the database after a typed confirmation, and starts them again. Artifacts and logs live in object storage, not in the dump; back up the RustFS volume separately if they matter. Copy dumps off the VM periodically, since a backup on the same disk does not survive losing it.

## Monitoring and retention

The coordinator logs one JSON object per line (`docker compose ... logs coordinator`). `/health` checks PostgreSQL and Redis and returns 503 when either is down, so the container health check reflects real dependency state. `/metrics` serves Prometheus text (`foreman_jobs{status}`, `foreman_workers{status}`, `foreman_http_responses_total{code}`). Caddy only forwards `/api/demo` and `/api/health`, so `/metrics` is reachable from inside the Compose network only; scrape it from a sidecar or add a protected Caddy route.

The monitor deletes finished jobs older than `RETENTION_DAYS` (default 30; set `FOREMAN_RETENTION_DAYS` in `.env.production`, `0` keeps everything) and offline workers silent for 24 hours, and applies a matching expiry rule to the artifact bucket when the storage backend supports lifecycle rules. Workers also delete a job's local files after upload and remove job containers that outlive their timeout by more than a minute, for example after a worker crash.

## Rollback

A failed automatic deploy rolls itself back (see Continuous deployment). To undo a deploy that passed its health checks, push a revert commit to `main`; the pipeline deploys it like any other change.

To fall back to the retained Operator stack instead:

Stop Foreman's public proxy, then restart Operator's retained containers:

```sh
cd /home/nkundra_be23/Foreman
docker compose -p foreman-production --env-file .env.production -f docker-compose.prod.yml stop caddy
docker compose -p operator-production --env-file /opt/operator/.env.production \
  -f /opt/operator/compose.gcp-production.yaml start
```

Do not use `down -v` for either stack. Operator's data was not copied into Foreman; the projects have separate databases. Back up the Foreman PostgreSQL and RustFS volumes before upgrades or VM replacement.
