-- Demo flag lets the public API filter in SQL instead of scanning recent jobs.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT FALSE;
UPDATE jobs SET is_demo = TRUE
WHERE NOT is_demo AND image_name = 'alpine:3.20' AND name LIKE 'Demo · %';

-- Retry backoff, cancellation and label-based placement.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS run_after TIMESTAMPTZ;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS cancel_requested BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS selector JSONB NOT NULL DEFAULT '{}';

-- Higher priority runs first; the queue index must match that order.
DROP INDEX IF EXISTS idx_jobs_priority;
CREATE INDEX IF NOT EXISTS idx_jobs_queue ON jobs(priority DESC, submitted_at) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS idx_jobs_demo ON jobs(submitted_at DESC) WHERE is_demo;
CREATE INDEX IF NOT EXISTS idx_jobs_completed_at ON jobs(completed_at);

-- Pruning stale workers must not delete job history.
ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_worker_id_fkey;
ALTER TABLE jobs ADD CONSTRAINT jobs_worker_id_fkey
  FOREIGN KEY (worker_id) REFERENCES workers(id) ON DELETE SET NULL;

-- Wake coordinators on every job status change so WebSocket events and the
-- scheduler do not depend on which process handled the HTTP request.
CREATE OR REPLACE FUNCTION foreman_notify_job() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('foreman_jobs', NEW.id::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS jobs_notify ON jobs;
CREATE TRIGGER jobs_notify AFTER INSERT OR UPDATE OF status ON jobs
  FOR EACH ROW EXECUTE FUNCTION foreman_notify_job();
