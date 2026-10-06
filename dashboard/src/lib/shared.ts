// GENERATED from node/shared/types.ts by scripts/sync-shared-types.mjs. Do not edit.
// Single source of truth for the API data model. Do not import this file directly:
// `node scripts/sync-shared-types.mjs` copies it into each package (coordinator, worker,
// dashboard) as a generated `shared.ts`, because every package builds from its own Docker
// context. CI runs the script with --check so the copies cannot drift.

export type WorkerStatus = 'online' | 'busy' | 'offline' | 'unhealthy';

export type JobStatus =
  | 'queued'
  | 'scheduled'
  | 'running'
  | 'completed'
  | 'failed'
  | 'retrying'
  | 'timed_out'
  | 'cancelled';

export interface Worker {
  id: string;
  hostname: string;
  status: WorkerStatus;
  last_heartbeat: string | null;
  cpu_cores: number;
  memory_mb: number;
  labels: Record<string, unknown>;
  current_load: number;
  registered_at: string;
}

export interface Job {
  id: string;
  name: string | null;
  status: JobStatus;
  submitted_at: string;
  scheduled_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  retries: number;
  max_retries: number;
  timeout_seconds: number;
  required_cpu: number;
  required_memory: number;
  worker_id: string | null;
  image_name: string;
  command: string;
  logs_path: string | null;
  artifact_path: string | null;
  lock_expires_at: string | null;
  priority: number;
  is_demo: boolean;
  run_after: string | null;
  cancel_requested: boolean;
  selector: Record<string, unknown>;
}

export interface JobEvent {
  id: string;
  job_id: string;
  event_type: string;
  timestamp: string;
  metadata: Record<string, unknown>;
}

export interface MetricsSummary {
  queued: number;
  scheduled: number;
  running: number;
  completed: number;
  failed: number;
  timed_out: number;
  cancelled: number;
  total: number;
}

export interface WSEvent {
  type: 'job_updated' | 'worker_registered' | 'worker_heartbeat' | string;
  payload: unknown;
}
