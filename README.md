# Foreman — Distributed Job Scheduler

> A fault-tolerant distributed task execution engine with resource-aware scheduling, containerized sandboxing, and automatic failure recovery.

---

## What This Is

Foreman is a production-grade job execution platform. Clients submit jobs (Docker images + shell commands) via a REST API; a central **Coordinator** schedules them across a fleet of **Worker agents** using a weighted scoring algorithm. Workers execute jobs inside Docker containers with enforced CPU and memory limits, stream logs back, and upload output artifacts to MinIO. A Next.js dashboard visualises the entire system state in real-time via WebSocket.

---

## Architecture

```
  [curl / dashboard / scripts]
            │
            │ REST  +  WebSocket
            ▼
  ┌──────────────────────────┐
  │       Coordinator        │  ← single Go binary
  │                          │
  │  REST API (chi)          │
  │  Scheduler    (2 s tick) │
  │  Heartbeat monitor (5 s) │
  │  Job recovery  (5 s)     │
  │  WebSocket hub           │
  └────────────┬─────────────┘
               │
       ┌───────┴───────┐
       │  PostgreSQL   │  source of truth — jobs, workers, events
       └───────┬───────┘
               │
       ┌───────┴───────┐
       │    Redis      │  per-job distributed lock (SET NX EX)
       └───────┬───────┘
               │
   ┌───────────┴──────────────┐
   │   Worker Agent (Go)      │  × N  (separate machines / containers)
   │                          │
   │  registers on startup    │
   │  heartbeat every 5 s     │
   │  polls /jobs/next (3 s)  │
   │  runs Docker container   │
   │  uploads artifacts →     │
   │    MinIO                 │
   └──────────────────────────┘
```

### Components

| Component | Responsibility |
|---|---|
| **Coordinator API** | Job submission, worker registration, status updates, artifact URLs |
| **Scheduler** | Matches queued jobs to eligible workers using weighted scoring; Redis NX lock prevents double-assignment |
| **Heartbeat Monitor** | Background goroutine — marks workers `unhealthy` (>15 s silence) then `offline` (>30 s), triggers job recovery |
| **Job Recovery** | Requeues or fails jobs with expired `lock_expires_at`; runs on startup to survive coordinator crashes |
| **Worker Agent** | Registers, heartbeats, polls for work, runs Docker containers, reports results |
| **PostgreSQL** | ACID store for jobs, workers, job events; row-level `FOR UPDATE SKIP LOCKED` for atomic polling |
| **Redis** | `SET NX EX 30` per job prevents two scheduler instances assigning the same job simultaneously |
| **MinIO** | S3-compatible artifact storage; workers upload, coordinator serves presigned download URLs |
| **Dashboard** | Next.js SPA — real-time via WebSocket with 10 s polling fallback |

---

## Quick Start

**Prerequisites:** Docker Desktop, Go 1.23+, Node 18+, pnpm

```bash
git clone https://github.com/namankundra/foreman
cd foreman

# 1. Start infrastructure (Postgres, Redis, MinIO)
docker compose up -d

# 2. Copy env and run migrations
cp .env.example .env
make migrate

# 3. Start coordinator
go run ./cmd/coordinator

# 4. Start a worker (new terminal)
go run ./cmd/worker

# 5. Start dashboard (new terminal)
cd dashboard && pnpm install && pnpm dev
# → http://localhost:3000   (API key: dev-secret-change-in-prod)
```

Submit your first job:
```bash
TOKEN=$(curl -s -X POST localhost:8080/auth/login \
  -H "Content-Type: application/json" \
  -d '{"api_key":"dev-secret-change-in-prod"}' | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")

curl -s -X POST localhost:8080/jobs \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "name":            "hello-world",
    "image_name":      "python:3.11-slim",
    "command":         "python -c \"print(42)\"",
    "required_cpu":    1,
    "required_memory": 128,
    "priority":        3
  }'
```

---

## Data Model

```sql
CREATE TABLE workers (
  id                   UUID PRIMARY KEY,
  hostname             TEXT NOT NULL,
  status               TEXT NOT NULL,          -- online | busy | offline | unhealthy
  last_heartbeat       TIMESTAMPTZ,
  cpu_cores            INT,
  memory_mb            INT,
  labels               JSONB DEFAULT '{}',
  current_load         INT DEFAULT 0,
  registered_token_hash TEXT,                  -- SHA-256 of bearer token used at registration
  registered_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE jobs (
  id              UUID PRIMARY KEY,
  name            TEXT,
  status          TEXT NOT NULL,               -- queued | scheduled | running | completed
                                               -- failed | retrying | timed_out | cancelled
  submitted_at    TIMESTAMPTZ DEFAULT NOW(),
  scheduled_at    TIMESTAMPTZ,
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  retries         INT DEFAULT 0,
  max_retries     INT DEFAULT 2,
  timeout_seconds INT DEFAULT 300,
  required_cpu    INT DEFAULT 1,
  required_memory INT DEFAULT 256,
  worker_id       UUID REFERENCES workers(id),
  image_name      TEXT NOT NULL,
  command         TEXT NOT NULL,
  logs_path       TEXT,
  artifact_path   TEXT,
  lock_expires_at TIMESTAMPTZ,                 -- coordinator crash recovery
  priority        INT DEFAULT 5                -- 1 = highest, 10 = lowest
);

CREATE TABLE job_events (
  id         UUID PRIMARY KEY,
  job_id     UUID REFERENCES jobs(id),
  event_type TEXT NOT NULL,
  timestamp  TIMESTAMPTZ DEFAULT NOW(),
  metadata   JSONB DEFAULT '{}'
);
```

---

## Scheduling Algorithm

Every 2 seconds the scheduler fetches up to 10 queued jobs and all online workers, then for each job:

**Step 1 — Filter eligible workers**
```
worker.status == "online"
worker.available_cpu    >= job.required_cpu
worker.available_memory >= job.required_memory
worker.current_load     <  MAX_PARALLEL_JOBS_PER_WORKER
```
`available_cpu` and `available_memory` are computed from `SUM(running+scheduled jobs)` for each worker — not just a counter, so the scheduler reacts to actual resource consumption.

**Step 2 — Score each eligible worker**
```
score = 0.4 × (free_cpu  / total_cpu)
      + 0.4 × (free_mem  / total_mem)
      − 0.2 × (load      / max_parallel)
```
Higher score = more headroom, lower contention. The job goes to the highest scorer.

**Step 3 — Atomic assignment**
```
Redis SET NX EX 30  scheduler:job:<id>
→ if acquired: UPDATE jobs SET status='scheduled', lock_expires_at=NOW()+30s WHERE status='queued'
              UPDATE workers SET current_load = current_load + 1
→ if not acquired: skip (another scheduler instance grabbed it)
```
The `WHERE status='queued'` clause acts as a second guard, so the system stays correct even if Redis is temporarily unavailable.

After each assignment the scheduler mutates its local copy of the worker's resource totals so subsequent jobs in the same 2-second batch see up-to-date headroom without an extra database round-trip.

---

## Fault Tolerance

### Heartbeat detection

```
Every 5 s — Heartbeat Monitor goroutine:
  workers with last_heartbeat < NOW() − 15 s AND status = 'online'
    → status = 'unhealthy'

  workers with last_heartbeat < NOW() − 30 s AND status IN ('online','unhealthy')
    → status = 'offline', current_load = 0
    → RecoverJobsForWorkers(offline_ids)
```

### Job recovery

Both worker-offline and coordinator-restart recovery use the same path:

```
SELECT running/scheduled jobs WHERE lock_expires_at < NOW()
  retries + 1 <= max_retries  →  status = 'queued',  worker_id = NULL
  retries + 1 >  max_retries  →  status = 'failed',  completed_at = NOW()
  emit job_event: type = 'auto_recovered' | 'auto_failed'
```

**Coordinator restart recovery** — the monitor runs immediately on startup (before the first tick) so any job stuck in `scheduled`/`running` with an expired lock is requeued before new workers connect.

**Lock duration** — when a worker reports `running`, `lock_expires_at` is set to `NOW() + timeout_seconds` (not a fixed 30 s). This prevents the monitor from cancelling a legitimately long-running job.

---

## API Reference

### Auth
| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/auth/login` | none | Exchange API key for session token |

### Workers
| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/workers/register` | worker | Register worker, returns UUID |
| `POST` | `/workers/heartbeat` | worker | Update liveness and current load |
| `GET` | `/workers` | dashboard | List all workers |

### Jobs
| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/jobs` | dashboard | Submit job (status = queued) |
| `GET` | `/jobs` | dashboard | List jobs (`?status=running&limit=50`) |
| `GET` | `/jobs/:id` | dashboard | Job detail + event timeline |
| `POST` | `/jobs/:id/status` | worker | Report status transition + logs/artifacts |
| `GET` | `/jobs/:id/artifacts` | dashboard | Presigned MinIO download URL (1 h TTL) |
| `GET` | `/jobs/next` | worker | Atomic claim of next queued job |

### Metrics & realtime
| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/metrics/summary` | dashboard | Job counts by status |
| `GET` | `/ws` | dashboard | WebSocket — `job_updated`, `worker_heartbeat`, `worker_registered` events |

---

## Benchmark Results

Run the suite yourself with `python scripts/benchmark.py --full --jobs 20`.

### Throughput (20 jobs, ~2 s each)

| Workers | Wall time | Throughput | Speedup | Efficiency |
|---|---|---|---|---|
| 1 | ~42 s | ~29 jobs/min | 1.00× | 100% |
| 2 | ~22 s | ~55 jobs/min | 1.91× | 95% |
| 4 | ~12 s | ~100 jobs/min | 3.50× | 87% |

*Sub-linear scaling is expected: scheduler tick latency (2 s) and Docker image-pull overhead dominate at low job counts.*

### Failure recovery

| Metric | Result |
|---|---|
| Time to detect offline worker | ≤ 30 s |
| Orphaned jobs requeued | 100% (within one monitor tick) |
| Jobs eventually completed | 100% (given ≥1 healthy worker remains) |

---

## Auth Model

Pre-shared token auth — documented honestly:

- **Workers** send `Authorization: Bearer <COORDINATOR_SECRET>` on every request. The raw token is never stored; a SHA-256 hash goes into `registered_token_hash`.
- **Dashboard** exchanges the same secret via `POST /auth/login` for a random 24-hour session UUID. All subsequent requests use that UUID as a bearer token.
- **WebSocket** receives the session token as `?token=` query parameter (browser WebSocket API does not support custom headers).

This is intentionally simple. Production hardening would add per-worker key rotation and OAuth/OIDC for the dashboard.

---

## Project Structure

```
/cmd
  /coordinator    main.go — wires store, scheduler, monitor, HTTP server
  /worker         main.go — register, heartbeat, poll, execute, upload
/internal
  /api            router, handlers, WebSocket hub, auth middleware
  /scheduler      weighted scoring, Redis NX locking, 2 s tick loop
  /monitor        heartbeat detection, job recovery, 5 s tick loop
  /store          raw SQL via pgx/v5 — workers, jobs, events, scheduler, monitor
  /models         shared Go structs (Worker, Job, JobEvent)
  /worker         Docker executor, MinIO uploader, coordinator HTTP client
/migrations       golang-migrate SQL files (up + down)
/dashboard        Next.js 15 — TypeScript, Tailwind, TanStack Query, Recharts
/scripts          benchmark.py — throughput, recovery, resource-limit experiments
docker-compose.yml  postgres, redis, minio (+ app profiles)
Makefile
```

---

## Known Tradeoffs

| Tradeoff | Decision | Why |
|---|---|---|
| Single coordinator | No HA | Adds ordering guarantee; SPOF acceptable for a portfolio project. Redis lock + `WHERE status='queued'` guard would extend naturally to multiple instances. |
| Worker polling (3 s) | Push would be lower-latency | Polling is simpler to implement and reason about; 3 s lag is acceptable. |
| Pre-shared token auth | Not OAuth | One secret to configure. The `registered_token_hash` column and session-token indirection show awareness of the pattern. |
| Coordinator stores `logs_path` as a local filesystem path | Not served over HTTP | Sufficient for single-machine dev; Phase 7 artifacts via MinIO is the production path. |
| In-memory session store | Sessions lost on coordinator restart | Documented; acceptable for the dashboard use case. |

---

## Future Work

- **HA Coordinator** — run multiple instances; the Redis lock + DB guard is already multi-instance-safe
- **Push scheduling** — coordinator pushes jobs via existing WebSocket instead of workers polling
- **Per-worker API keys** — rotate without restarting everything
- **Prometheus + Grafana** — `GET /metrics` in Prometheus exposition format is a one-day add
- **Job DAGs** — `depends_on: [job_id]` field, scheduler checks all dependencies completed before queuing
- **Streaming logs** — tail logs in real-time on the job detail page via WebSocket
