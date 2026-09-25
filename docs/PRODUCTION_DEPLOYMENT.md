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

## Deploy updates

Transfer reviewed source changes into the VM checkout, then run:

```sh
cd /home/nkundra_be23/Foreman
docker compose -p foreman-production --env-file .env.production -f docker-compose.prod.yml config --quiet
docker compose -p foreman-production --env-file .env.production -f docker-compose.prod.yml build coordinator worker dashboard
docker compose -p foreman-production --env-file .env.production -f docker-compose.prod.yml up -d --no-build
docker compose -p foreman-production --env-file .env.production -f docker-compose.prod.yml ps
```

The migration helper applies idempotent SQL schema files before the coordinator starts. The worker has Docker socket access to run jobs. This grants the worker broad control of the VM's Docker daemon, so restrict VM access and treat the worker image as trusted code.

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

## Rollback

Stop Foreman's public proxy, then restart Operator's retained containers:

```sh
cd /home/nkundra_be23/Foreman
docker compose -p foreman-production --env-file .env.production -f docker-compose.prod.yml stop caddy
docker compose -p operator-production --env-file /opt/operator/.env.production \
  -f /opt/operator/compose.gcp-production.yaml start
```

Do not use `down -v` for either stack. Operator's data was not copied into Foreman; the projects have separate databases. Back up the Foreman PostgreSQL and RustFS volumes before upgrades or VM replacement.
