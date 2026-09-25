# Go to Node.js migration

Last updated: 2026-09-25

## Goal

Replace the Go coordinator and worker with Node.js services while retaining the Next.js dashboard, PostgreSQL schema, Redis locking, MinIO artifacts, and externally visible API behavior. The default Compose stack runs TypeScript services only. The Go source, module files, old Dockerfiles, and historical guide were removed after the Node stack passed live checks.

## Historical migration scope and compatibility contract

| Area | Former Go implementation | Required behavior in Node.js |
| --- | --- | --- |
| Coordinator | Go HTTP server and store | Same routes, JSON fields, status codes, authentication, and WebSocket events |
| Scheduler | Go scheduler and SQL store | Resource scoring, Redis `SET NX` lock, atomic PostgreSQL assignment |
| Monitor and recovery | Go monitor and SQL store | Heartbeat health thresholds and recovery of expired job locks |
| Worker | Go worker binary | Registration, heartbeat, polling, Docker limits and timeout, result reporting, artifact upload |
| Data | `migrations`, PostgreSQL, Redis, MinIO | Reuse existing schema and object keys; no data reset |
| Dashboard | `dashboard` (Next.js) | Continue using existing API and WebSocket contract |

The API routes to preserve are `GET /health`, `POST /auth/login`, `POST /workers/register`, `POST /workers/heartbeat`, `GET /workers`, `GET /jobs/next`, `POST /jobs`, `GET /jobs`, `GET /jobs/:id`, `POST /jobs/:id/status`, `GET /jobs/:id/artifacts`, `GET /metrics/summary`, and `GET /ws`. Worker requests use `COORDINATOR_SECRET`; dashboard requests use a 24-hour in-memory login session. The WebSocket event envelope is `{ "type": "...", "payload": ... }`.

## Migration sequence

1. **Contract baseline.** Record routes, request and response shapes, status codes, data model, background intervals, and failure behavior from Go. Add focused compatibility checks.
2. **Node coordinator API and store.** Port authentication, jobs, workers, metrics, artifact URLs, and WebSocket events. Reuse migrations and PostgreSQL rows. Verify each route against the Go response before enabling it for the dashboard.
3. **Scheduler and recovery.** Port resource eligibility and scoring, PostgreSQL transactions and `FOR UPDATE SKIP LOCKED`, Redis job locks, heartbeat monitoring, and expired-lock recovery. Test concurrent coordinator instances and crash recovery.
4. **Node worker.** Port registration, heartbeat, polling, Docker execution with CPU/memory/timeout enforcement, logs, result status, and MinIO upload. Verify a Go worker can talk to the Node coordinator and a Node worker can talk to the Go coordinator during transition.
5. **Deployment switch.** Add Node container builds and Compose services, run job lifecycle and dashboard checks, make Node the default Compose stack, then remove Go source and build paths.

## Progress

| Item | Status | Evidence / next action |
| --- | --- | --- |
| Repository inventory | Done | Identified two Go binaries, six backend areas, existing Next.js dashboard, PostgreSQL, Redis, and MinIO. |
| Migration plan and compatibility boundary | Done | This document and the route list above. |
| Node coordinator foundation | Done | TypeScript health, login, CORS, session authorization, and authenticated WebSocket broadcasts. `npm test` compiles TypeScript and passes 29 tests (2026-09-25). |
| Database-backed coordinator routes | In progress | PostgreSQL worker registration, heartbeat, listing, job submission/list/detail, worker job claim/status, metrics, and artifact URL responses. Claims use `FOR UPDATE SKIP LOCKED`; terminal updates use a transaction. A live job completed against a migrated PostgreSQL database, and its MinIO artifact was downloaded through the API's presigned URL. Broader Go response parity remains to verify. |
| Scheduler and monitor | In progress | Resource scoring, 2-second scheduler loop, Redis 30-second NX lock with database fallback, transactional assignment, startup recovery, 5-second monitor loop, 15/30-second worker health thresholds, and retry/fail recovery SQL. A live expired-lock test requeued a job and it completed with `retries: 1`. Multi-instance assignment and actual worker-crash recovery still need integration checks. |
| Node worker | In progress | TypeScript runtime registers, heartbeats, polls, executes Docker jobs with CPU/memory limits and timeout, captures logs, uploads output tar archives, and reports final status. An anonymous Docker volume holds `/output`; the worker extracts its archive before uploading, so a shared host path is unnecessary. `npm test` passes 12 tests; live success, failure, timeout, and recovery cases have passed. |
| Node container builds and Compose | Done | Plain `docker compose up -d --build` runs the TypeScript coordinator on 8080, three TypeScript workers, and the dashboard on 3000. A PostgreSQL helper applies idempotent schema SQL before coordinator startup. The coordinator has a health check; workers and dashboard wait for it. No Go services remain in Compose. |
| End-to-end parity and deployment | In progress | The running Node stack uses the existing migrated `foreman` database. `scripts/node-smoke.mjs` passes health, login rejection/success, workers, metrics, listing, dashboard HTTP, success, failure, timeout, artifact download, WebSocket updates, and six concurrent jobs. An actual worker-stop test recovered and completed a job with one retry. A second coordinator ran during the concurrency test. The user provided a browser screenshot of the overview showing live metrics and workers. Exhaustive Go response parity remains unverified. |

The live timeout test initially exposed a race: the monitor recovered a job before the worker finished stopping its container and reporting `timed_out`. The Node coordinator now gives running jobs a 30-second completion grace period and accepts terminal reports only from the worker assigned to a still-running job. The retest ended in `timed_out` with `retries: 0`.

## Running the Node stack

Run `npm ci` and `npm test` in both `node/coordinator` and `node/worker`; tests compile TypeScript first. Start the full stack with `docker compose up -d --build`. The migration helper applies the existing SQL schema automatically and preserves data on repeat starts. The dashboard is at `http://localhost:3000` and the API at `http://localhost:8080`. Run `node scripts/node-smoke.mjs` for a live smoke test; it creates test jobs. Set `COORDINATOR_SECRET` for the script when using a non-default secret. The Docker worker needs access to the Docker daemon. `FOREMAN_DATA_DIR` may set where the worker stores temporary logs and extracted artifacts; it does not need to be shared with the Docker daemon. Set `MINIO_PUBLIC_ENDPOINT` to the host and port reachable by dashboard users (default `localhost:9000`) so artifact links work in their browser.

The Node job poll intentionally consumes scheduler-assigned `scheduled` jobs and leaves unassigned `queued` jobs for the scheduler. This corrects a Go path that could bypass resource scoring or leave assigned jobs unclaimed.

## Completion criteria

- Dashboard works with the Node coordinator, including live updates and polling fallback.
- Jobs submit, schedule once, execute, retry or time out, recover after crashes, and expose logs and artifacts with the same JSON contract.
- Multiple coordinator and worker instances do not double-assign jobs.
- Existing migrations and data are usable without a reset.
- Plain Compose builds and runs the Node coordinator and workers; no Go service is configured.
