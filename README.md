# Distributed Job Scheduler — Full Project Plan

---

## What This System Is

A production-grade distributed job execution platform where:
- Clients submit jobs (scripts, commands) via REST API
- A central **Coordinator** persists, schedules, and tracks jobs
- Multiple **Worker agents** (on different machines/containers) pull jobs, execute them in Docker sandboxes, and report results
- The Coordinator detects failures, retries jobs, and recovers from worker crashes
- A live dashboard visualizes the entire system state in real-time

**One-line pitch for interviews:**  
> "A fault-tolerant distributed task execution engine with resource-aware scheduling, containerized sandboxing, and automatic failure recovery."

---

## System Design

### High-Level Architecture

```
[Client / curl / dashboard]
          |
          | REST API
          v
  ┌──────────────────┐
  │   Coordinator    │  ← single Go binary
  │                  │
  │  - REST API      │
  │  - Scheduler     │
  │  - Heartbeat     │
  │    Monitor       │
  │  - Job Recovery  │
  │  - WebSocket hub │
  └────────┬─────────┘
           |
     ┌─────┴──────┐
     |  PostgreSQL │  ← source of truth
     └─────┬───── ┘
           |
    ┌──────┴──────┐
    |    Redis     │  ← job queue, locks, pub/sub
    └──────┬───── ┘
           |
   ┌───────┴────────┐
   | Worker polling  │  (HTTP polling, not push)
   └───────┬─────── ┘
           |
  ┌────────┴──────────────────────────┐
  │  Worker Agent (Go daemon)         │
  │                                   │
  │  - registers on startup           │
  │  - polls /jobs/next               │
  │  - spawns Docker container        │
  │  - streams logs to coordinator    │
  │  - uploads artifacts              │
  │  - sends heartbeat every 5s       │
  └───────────────────────────────────┘
```

### Component Responsibilities

| Component | Responsibility |
|---|---|
| **Coordinator API** | Accept job submissions, register workers, expose state |
| **Scheduler** | Match jobs to workers using scoring algorithm |
| **Heartbeat Monitor** | Background goroutine, marks workers unhealthy/offline |
| **Job Recovery Service** | Background goroutine, detects stale jobs, requeues them |
| **Worker Agent** | Polls for jobs, runs Docker containers, reports back |
| **PostgreSQL** | Persistent store for jobs, workers, events |
| **Redis** | Distributed lock for job assignment, queue depth counter |
| **Dashboard** | React SPA, polls or WebSocket for live state |

### Data Model

```sql
-- Workers
CREATE TABLE workers (
  id            UUID PRIMARY KEY,
  hostname      TEXT NOT NULL,
  status        TEXT NOT NULL,          -- online | busy | offline | unhealthy
  last_heartbeat TIMESTAMPTZ,
  cpu_cores     INT,
  memory_mb     INT,
  labels        JSONB DEFAULT '{}',
  current_load  INT DEFAULT 0,
  registered_at TIMESTAMPTZ DEFAULT NOW()
);

-- Jobs
CREATE TABLE jobs (
  id              UUID PRIMARY KEY,
  name            TEXT,
  status          TEXT NOT NULL,        -- queued | scheduled | running | completed | failed | retrying | timed_out | cancelled
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
  lock_expires_at TIMESTAMPTZ,          -- coordinator crash recovery
  priority        INT DEFAULT 5         -- 1 = highest, 10 = lowest
);

-- Job Events (audit trail)
CREATE TABLE job_events (
  id         UUID PRIMARY KEY,
  job_id     UUID REFERENCES jobs(id),
  event_type TEXT NOT NULL,
  timestamp  TIMESTAMPTZ DEFAULT NOW(),
  metadata   JSONB DEFAULT '{}'
);
```

### Scheduler Algorithm

```
Input: job J with (required_cpu, required_memory, labels, priority)

Step 1 — Filter eligible workers:
  worker.status == "online"
  worker.available_memory >= job.required_memory
  worker.available_cpu >= job.required_cpu
  worker.labels ⊇ job.required_labels
  worker.current_load < MAX_PARALLEL_JOBS

Step 2 — Score each eligible worker:
  score = 0.4 * (free_cpu / total_cpu)
        + 0.4 * (free_memory / total_memory)
        - 0.2 * (current_load / MAX_PARALLEL_JOBS)

Step 3 — Assign to highest scoring worker
  Atomic: SET job.worker_id, job.status = "scheduled"
          SET job.lock_expires_at = NOW() + 30s  (crash recovery)
          INCREMENT worker.current_load
```

### Fault Tolerance Design

```
Heartbeat Monitor (runs every 5s):
  SELECT * FROM workers WHERE last_heartbeat < NOW() - 15s AND status = 'online'
  → mark status = 'unhealthy'

  SELECT * FROM workers WHERE last_heartbeat < NOW() - 30s
  → mark status = 'offline'
  → trigger job recovery for jobs assigned to this worker

Job Recovery Service (runs every 10s):
  SELECT * FROM jobs
  WHERE status = 'running'
  AND lock_expires_at < NOW()
  → increment retries
  → if retries < max_retries: status = 'queued', worker_id = NULL
  → else: status = 'failed'
  → emit JobEvent: type = 'auto_recovered'

Coordinator Restart Recovery:
  On startup: run Job Recovery Service immediately
  → any job stuck in 'scheduled'/'running' with expired lock gets requeued
  → system survives coordinator crash without data loss
```

---

## Tech Stack

### Backend — Coordinator & Worker

| Choice | Why |
|---|---|
| **Go** | Goroutines make heartbeat monitor + scheduler + API trivially concurrent. Single binary deployment for both coordinator and worker. Strong standard library. |
| **PostgreSQL** | JSONB for labels/metadata, strong ACID for job state transitions, row-level locking for atomic assignment |
| **Redis** | Distributed lock (`SET NX EX`) for atomic job pickup, prevents double-assignment across workers |
| **Docker SDK (Go)** | `github.com/docker/docker/client` — programmatic container launch, log streaming, resource limits |
| **Chi or Fiber** | Lightweight HTTP router, idiomatic Go |
| **sqlx or pgx** | Postgres driver with struct scanning |
| **golang-migrate** | DB migration management |

### Frontend — Dashboard

| Choice | Why |
|---|---|
| **React + Vite** | Fast, familiar, small bundle |
| **TailwindCSS** | Rapid UI without fighting CSS |
| **TanStack Query** | Auto-polling, cache invalidation |
| **Recharts** | Simple charts for metrics |
| **WebSocket (native)** | Real-time job/worker status updates |

### Infrastructure

| Choice | Why |
|---|---|
| **Docker Compose** | Run coordinator + postgres + redis + 3 worker containers locally for demo |
| **MinIO** | S3-compatible artifact storage, runs locally, one container |
| **Prometheus + Grafana** (optional) | Professional observability story |

---

## Step-by-Step Implementation Plan

---

### Phase 1 — Project Skeleton (Day 1)

**Goal:** Repo structure, DB running, migrations working.

```
/cmd
  /coordinator      ← main.go
  /worker           ← main.go
/internal
  /api              ← HTTP handlers
  /scheduler        ← scheduling logic
  /monitor          ← heartbeat + recovery
  /worker           ← worker execution logic
  /models           ← DB structs
  /store            ← DB queries
/migrations         ← .sql files
/dashboard          ← React app
docker-compose.yml
Makefile
```

**Tasks:**
1. Initialize Go module (`go mod init`)
2. Write `docker-compose.yml` with postgres + redis
3. Write migration files for all 3 tables
4. Set up `golang-migrate` runner
5. Write `Makefile` targets: `make dev`, `make migrate`, `make test`
6. Confirm DB connects and tables exist

**Done when:** `make dev` starts coordinator, connects to postgres, no crashes.

---

### Phase 2 — Coordinator API (Days 2–3)

**Goal:** All REST endpoints working, testable with curl.

**Build in this order:**

1. `POST /workers/register` → insert worker, return worker_id
2. `POST /workers/heartbeat` → update last_heartbeat, cpu/memory load
3. `GET /workers` → list all workers with status
4. `POST /jobs` → insert job with status=queued
5. `GET /jobs` → list jobs with filters (?status=running)
6. `GET /jobs/:id` → single job with event timeline
7. `POST /jobs/:id/status` → worker reports status update
8. `GET /metrics/summary` → counts by status

**Implementation notes:**
- Use `pgx` for all DB queries — write raw SQL, no ORM
- Validate all inputs — return 400 with clear error messages
- Write a `store` package that wraps all DB operations
- Every status transition emits a `JobEvent` row

**Done when:** You can register a worker, submit a job, and manually move it through statuses via curl.

---

### Phase 3 — Heartbeat Monitor (Day 4)

**Goal:** Background goroutine that keeps worker statuses accurate.

```go
// internal/monitor/heartbeat.go

func (m *Monitor) Run(ctx context.Context) {
    ticker := time.NewTicker(5 * time.Second)
    for {
        select {
        case <-ticker.C:
            m.checkWorkerHealth()
            m.recoverStaleJobs()
        case <-ctx.Done():
            return
        }
    }
}
```

**Tasks:**
1. Write `checkWorkerHealth()` — query workers, update status based on last_heartbeat age
2. Write `recoverStaleJobs()` — query running jobs with expired locks, requeue or fail them
3. Start monitor as a goroutine in `coordinator/main.go`
4. Test by starting a worker, killing it, watching status change in DB

**Done when:** Kill a worker process → coordinator marks it unhealthy within 15s, offline within 30s, and requeues its running jobs.

---

### Phase 4 — Worker Agent (Days 5–6)

**Goal:** A Go daemon that registers, heartbeats, and polls for jobs.

**Worker startup flow:**
```go
func main() {
    id := loadOrGenerateWorkerID()   // persist to ~/.worker_id
    registerWithCoordinator(id)
    
    go heartbeatLoop(id)             // goroutine: POST /workers/heartbeat every 5s
    go pollForJobs(id)               // goroutine: GET /jobs/next?worker_id=... every 3s
    
    waitForShutdown()
}
```

**`GET /jobs/next` logic on coordinator side:**
```
1. Find oldest queued job this worker can handle
2. Atomically: SET status=scheduled, worker_id=id, lock_expires_at=NOW()+30s
3. Return job or 204 No Content
```

**Worker execution (no Docker yet):**
1. Receive job assignment
2. Run `exec.Command(job.Command)` with timeout
3. Capture stdout/stderr
4. POST results back to coordinator

**Done when:** Worker picks up a job, runs a shell command, reports completion. Verified in DB.

---

### Phase 5 — Docker Sandboxing (Days 7–8)

**Goal:** Replace raw exec with containerized execution.

**Using Docker Go SDK:**
```go
func (e *Executor) Run(job models.Job) (ExecResult, error) {
    ctx, cancel := context.WithTimeout(context.Background(), 
        time.Duration(job.TimeoutSeconds)*time.Second)
    defer cancel()

    resp, err := e.docker.ContainerCreate(ctx, &container.Config{
        Image: job.ImageName,
        Cmd:   strings.Split(job.Command, " "),
    }, &container.HostConfig{
        Resources: container.Resources{
            Memory:   int64(job.RequiredMemory) * 1024 * 1024,
            NanoCPUs: int64(job.RequiredCPU) * 1e9,
        },
        AutoRemove: true,
    }, nil, nil, "")
    
    // start, wait, collect logs, return
}
```

**Tasks:**
1. Add Docker SDK dependency
2. Write `Executor` struct with `Run()` method
3. Handle timeout → kill container
4. Collect stdout/stderr → write to file → set logs_path on job
5. Handle image pull if not present
6. Test with `python:3.11-slim` running a hello world script

**Done when:** Job with `image_name: python:3.11-slim`, `command: python -c "print('hello')"` runs in Docker, logs captured, job marked completed.

---

### Phase 6 — Scheduler Module (Day 9)

**Goal:** Replace manual assignment with automatic weighted scheduling.

```go
// internal/scheduler/scheduler.go

type Scheduler struct {
    store  *store.Store
    locker *redis.Client
}

func (s *Scheduler) Run(ctx context.Context) {
    ticker := time.NewTicker(2 * time.Second)
    for range ticker.C {
        s.scheduleNextBatch()
    }
}

func (s *Scheduler) scheduleNextBatch() {
    jobs := s.store.GetQueuedJobs(limit=10, orderByPriority=true)
    workers := s.store.GetEligibleWorkers()
    
    for _, job := range jobs {
        best := s.selectWorker(job, workers)
        if best == nil { continue }
        s.assignJob(job, best)   // atomic with Redis lock
    }
}

func (s *Scheduler) score(w Worker, j Job) float64 {
    freeCPU := float64(w.CPUCores - w.CurrentLoad)
    freeMem := float64(w.MemoryMB - w.UsedMemoryMB)
    return 0.4*(freeCPU/float64(w.CPUCores)) +
           0.4*(freeMem/float64(w.MemoryMB)) -
           0.2*(float64(w.CurrentLoad)/MAX_PARALLEL)
}
```

**Tasks:**
1. Write scheduler module with `Run()` loop
2. Implement `selectWorker()` with scoring
3. Use Redis `SET NX EX` for atomic job lock before assignment (prevents race between two scheduler instances)
4. Start scheduler as goroutine in coordinator
5. Remove the manual `/jobs/next` polling endpoint (or keep it as fallback)

**Done when:** Submit 5 jobs with different resource requirements across 3 workers → verify they distribute based on scoring, not randomly.

---

### Phase 7 — Artifact Storage (Day 10)

**Goal:** Job outputs persist and are downloadable.

**Tasks:**
1. Add MinIO to `docker-compose.yml`
2. Write `ArtifactStore` interface with `Upload(jobID, filePath)` and `GetURL(jobID)`
3. After container finishes, worker uploads output directory to MinIO
4. Coordinator stores artifact URL in jobs table
5. Add `GET /jobs/:id/artifacts` endpoint that returns presigned URL

**Done when:** Python job writes `output.json`, worker uploads it, dashboard can download it.

---

### Phase 8 — Dashboard (Days 11–13)

**Goal:** Working React dashboard with real-time updates.

**Pages to build in order:**

1. **Overview page** — job counts by status (queued/running/completed/failed), active workers count, simple bar chart of throughput
2. **Workers page** — table with status badge, CPU/memory bar, last heartbeat time
3. **Jobs page** — filterable table by status, worker, date
4. **Job detail page** — command, assigned worker, duration, log viewer, artifact download, event timeline

**Real-time updates:**
- Open WebSocket on dashboard load
- Coordinator broadcasts job/worker status changes to all connected clients
- TanStack Query polls `/metrics/summary` every 10s as fallback

**Done when:** You can watch a job go from queued → scheduled → running → completed in real-time on the dashboard.

---

### Phase 9 — Auth & Worker Trust (Day 14)

**Goal:** Minimal but honest trust model.

**Tasks:**
1. Add `COORDINATOR_SECRET` env var
2. Workers must send `Authorization: Bearer <secret>` on register + heartbeat
3. Middleware validates token, returns 401 otherwise
4. Dashboard login: simple API key check, return session token (store in memory, not DB)
5. Add `registered_token_hash` to workers table

**Done when:** Worker without token gets rejected. Document this honestly as "pre-shared token auth."

---

### Phase 10 — Benchmarking (Day 15)

**Goal:** Real numbers for the README.

**Write a benchmark script (`scripts/benchmark.py`):**
```python
# Submit N jobs, measure wall clock time to completion
# Run with 1, 2, 4 workers
# Record: total time, throughput (jobs/min), avg latency, failure recovery rate
```

**Experiments to run:**
1. Submit 20 identical jobs with 1 worker → record time
2. Same batch with 2 workers → record time
3. Same batch with 4 workers → record time
4. Submit 10 jobs, kill a worker mid-run → verify recovery rate
5. Submit jobs exceeding memory limit → verify rejection

**Target numbers to achieve:**
- "4 workers completed batch 3.1x faster than 1 worker"
- "Auto-recovery requeued 100% of orphaned jobs within 30 seconds"

---

### Phase 11 — README & Polish (Day 16)

**README sections:**
1. What this is (2 sentences)
2. Architecture diagram (draw with Excalidraw, export as PNG)
3. Key technical decisions with justifications
4. Scheduling algorithm explanation
5. Fault tolerance walkthrough
6. Local setup (3 commands: `git clone`, `docker compose up`, done)
7. Benchmark results with chart
8. Known tradeoffs and future work

**Tradeoffs to honestly document:**
- Coordinator is still a SPOF (single coordinator, not HA)
- Worker polling adds latency vs push — accepted for simplicity
- Pre-shared token auth, not OAuth

---

## What You Can Claim on Your Resume

```
Distributed Job Scheduler                                    Go, PostgreSQL, Redis, Docker
- Built a fault-tolerant job execution platform supporting N concurrent worker nodes
- Implemented resource-aware scheduler using weighted scoring across CPU/memory/load metrics
- Designed containerized sandboxing with Docker SDK enforcing memory, CPU, and timeout limits
- Built heartbeat-based failure detection with automatic job recovery and exponential backoff retry
- Coordinator crash recovery via persistent job locks — system survives restarts without data loss
- Benchmarked 3.1x throughput improvement with 4 workers vs 1; 100% orphaned job recovery rate
```

---

## Timeline Summary

| Day | Milestone |
|---|---|
| 1 | Skeleton, DB, migrations |
| 2–3 | Coordinator REST API |
| 4 | Heartbeat monitor + recovery |
| 5–6 | Worker agent (shell exec) |
| 7–8 | Docker sandboxing |
| 9 | Scheduler module |
| 10 | Artifact storage (MinIO) |
| 11–13 | Dashboard |
| 14 | Auth + worker trust |
| 15 | Benchmarks |
| 16 | README + polish |

**Total: ~16 focused days of work.**
