export const workerColumns = `id, hostname, status, last_heartbeat, cpu_cores, memory_mb,
  labels, current_load, registered_at`;

export const jobColumns = `id, name, status, submitted_at, scheduled_at, started_at, completed_at,
  retries, max_retries, timeout_seconds, required_cpu, required_memory, worker_id,
  image_name, command, logs_path, artifact_path, lock_expires_at, priority,
  is_demo, run_after, cancel_requested, selector`;
