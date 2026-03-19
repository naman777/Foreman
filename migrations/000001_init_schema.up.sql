CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE workers (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hostname       TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'online',  -- online | busy | offline | unhealthy
  last_heartbeat TIMESTAMPTZ,
  cpu_cores      INT  NOT NULL DEFAULT 1,
  memory_mb      INT  NOT NULL DEFAULT 512,
  labels         JSONB NOT NULL DEFAULT '{}',
  current_load   INT  NOT NULL DEFAULT 0,
  registered_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT workers_status_check CHECK (status IN ('online', 'busy', 'offline', 'unhealthy'))
);

CREATE TABLE jobs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT,
  status          TEXT NOT NULL DEFAULT 'queued',
  submitted_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  scheduled_at    TIMESTAMPTZ,
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  retries         INT NOT NULL DEFAULT 0,
  max_retries     INT NOT NULL DEFAULT 2,
  timeout_seconds INT NOT NULL DEFAULT 300,
  required_cpu    INT NOT NULL DEFAULT 1,
  required_memory INT NOT NULL DEFAULT 256,
  worker_id       UUID REFERENCES workers(id),
  image_name      TEXT NOT NULL,
  command         TEXT NOT NULL,
  logs_path       TEXT,
  artifact_path   TEXT,
  lock_expires_at TIMESTAMPTZ,
  priority        INT NOT NULL DEFAULT 5,
  CONSTRAINT jobs_status_check CHECK (
    status IN ('queued', 'scheduled', 'running', 'completed', 'failed', 'retrying', 'timed_out', 'cancelled')
  ),
  CONSTRAINT jobs_priority_check CHECK (priority BETWEEN 1 AND 10)
);

CREATE TABLE job_events (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id     UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  timestamp  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata   JSONB NOT NULL DEFAULT '{}'
);

CREATE INDEX idx_jobs_status     ON jobs(status);
CREATE INDEX idx_jobs_priority   ON jobs(priority, submitted_at) WHERE status = 'queued';
CREATE INDEX idx_jobs_worker_id  ON jobs(worker_id);
CREATE INDEX idx_job_events_job  ON job_events(job_id, timestamp);
CREATE INDEX idx_workers_status  ON workers(status);
