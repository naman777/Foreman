export type WorkerStatus = "online" | "busy" | "offline" | "unhealthy";
export type JobStatus =
  | "queued"
  | "scheduled"
  | "running"
  | "completed"
  | "failed"
  | "retrying"
  | "timed_out"
  | "cancelled";

export interface Worker {
  id: string;
  hostname: string;
  status: WorkerStatus;
  last_heartbeat: string | null;
  cpu_cores: number;
  memory_mb: number;
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
  priority: number;
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
  type: "job_updated" | "worker_registered" | "worker_heartbeat" | string;
  payload: unknown;
}
