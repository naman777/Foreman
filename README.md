# Foreman

Foreman is a distributed job scheduler built with a TypeScript coordinator, TypeScript Docker workers, a Next.js dashboard, PostgreSQL, Redis, and S3-compatible artifact storage.

The public production site is [foreman.naman.sbs](https://foreman.naman.sbs). Recruiters can explore the dashboard and run guided jobs in **Try it live** without an account. The production deployment and HTTPS runbook are in [docs/PRODUCTION_DEPLOYMENT.md](docs/PRODUCTION_DEPLOYMENT.md).

## Start

Requirements: Docker Desktop with a running Linux engine.

```bash
docker compose up -d --build
```

Compose starts PostgreSQL, Redis, MinIO, applies the SQL schema, then starts one coordinator, three workers, and the dashboard. Existing database volumes are retained. Open the dashboard at http://localhost:3000. The API listens at http://localhost:8080.

The dashboard and guided job demos need no sign-in. The public API accepts five fixed job scenarios and limits submissions; it does not accept visitor-provided images or commands. The coordinator still uses `COORDINATOR_SECRET` privately for workers and administrative API calls; set a different value in `.env` before sharing the service.

```bash
docker compose ps
docker compose logs -f coordinator worker dashboard
docker compose down
```

`docker compose down` stops containers and preserves PostgreSQL, Redis, and MinIO volumes. Set `API_PORT` or `DASHBOARD_PORT` in `.env` to change the host ports. Set `MINIO_PUBLIC_ENDPOINT` to the host and port users can reach for artifact downloads.

## Test

```bash
npm --prefix node/coordinator ci
npm --prefix node/worker ci
npm --prefix node/coordinator test
npm --prefix node/worker test
node scripts/node-smoke.mjs
```

The smoke test creates jobs and checks login, worker listing, scheduling, success, failure, timeout, artifact download, WebSocket updates, and concurrent execution. It uses the local development secret by default; set `COORDINATOR_SECRET` when your deployment uses another secret.

## Services

| Service | Source | Role |
| --- | --- | --- |
| Coordinator | `node/coordinator` | REST API, scheduler, monitor, WebSocket, artifact URLs |
| Worker | `node/worker` | Registers, heartbeats, executes Docker jobs, uploads output |
| Dashboard | `dashboard` | Next.js UI |
| PostgreSQL | `migrations` | Jobs, workers, events |
| Redis | Compose service | Scheduler locks |
| MinIO | Compose service | Job artifacts |

Workers use the Docker socket to launch job containers. Job output written to `/output` is uploaded as a tar artifact. The dashboard receives updates over WebSocket and uses polling as a fallback.

## Development

Run `make up`, `make test`, or `make smoke` if GNU Make is installed. The coordinator and worker packages have their own TypeScript builds and tests. See [migration progress](docs/NODE_MIGRATION.md) for validation history.

The application source and Compose services use TypeScript. The migration history is recorded in [docs/NODE_MIGRATION.md](docs/NODE_MIGRATION.md).
