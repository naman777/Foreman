import pg, { type Pool as PoolType } from 'pg';
import type { Job, JobStore, Worker, WorkerStore } from './server.js';

const workerColumns = `id, hostname, status, last_heartbeat, cpu_cores, memory_mb,
  labels, current_load, registered_at`;
const jobColumns = `id, name, status, submitted_at, scheduled_at, started_at, completed_at,
  retries, max_retries, timeout_seconds, required_cpu, required_memory, worker_id,
  image_name, command, logs_path, artifact_path, lock_expires_at, priority`;

export class PostgresWorkerStore implements WorkerStore {
  constructor(private readonly pool: PoolType) {}

  async registerWorker(input: {
    hostname: string; cpuCores: number; memoryMB: number;
    labels: Record<string, unknown>; tokenHash: string;
  }): Promise<Worker> {
    const result = await this.pool.query<Worker>(`
      INSERT INTO workers (hostname, cpu_cores, memory_mb, labels, registered_token_hash)
      VALUES ($1, $2, $3, $4::jsonb, $5)
      RETURNING ${workerColumns}`,
    [input.hostname, input.cpuCores, input.memoryMB, JSON.stringify(input.labels), input.tokenHash]);
    const worker = result.rows[0];
    if (!worker) throw new Error('worker insert returned no row');
    return worker;
  }

  async updateHeartbeat(workerID: string, currentLoad: number): Promise<boolean> {
    const result = await this.pool.query(
      'UPDATE workers SET last_heartbeat = NOW(), current_load = $2 WHERE id = $1',
      [workerID, currentLoad],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async listWorkers(): Promise<Worker[]> {
    const result = await this.pool.query<Worker>(
      `SELECT ${workerColumns} FROM workers ORDER BY registered_at DESC`,
    );
    return result.rows;
  }
}

export class PostgresJobStore implements JobStore {
  constructor(private readonly pool: PoolType) {}

  async createJob(input: {
    name: string | null; imageName: string; command: string; requiredCPU: number;
    requiredMemory: number; maxRetries: number; timeoutSeconds: number; priority: number;
  }): Promise<Job> {
    const result = await this.pool.query<Job>(`
      INSERT INTO jobs (name, image_name, command, required_cpu, required_memory,
        max_retries, timeout_seconds, priority)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING ${jobColumns}`,
    [input.name, input.imageName, input.command, input.requiredCPU,
      input.requiredMemory, input.maxRetries, input.timeoutSeconds, input.priority]);
    const job = result.rows[0];
    if (!job) throw new Error('job insert returned no row');
    return job;
  }

  async createJobEvent(jobID: string, type: string, metadata: Record<string, unknown>): Promise<void> {
    await this.pool.query(
      'INSERT INTO job_events (job_id, event_type, metadata) VALUES ($1, $2, $3::jsonb)',
      [jobID, type, JSON.stringify(metadata)],
    );
  }

  async listJobs(filters: {
    status: string; workerID: string | null; limit: number; offset: number;
  }): Promise<Job[]> {
    const clauses: string[] = [];
    const values: unknown[] = [];
    if (filters.status) { values.push(filters.status); clauses.push(`status = $${values.length}`); }
    if (filters.workerID) { values.push(filters.workerID); clauses.push(`worker_id = $${values.length}`); }
    values.push(filters.limit, filters.offset);
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const result = await this.pool.query<Job>(
      `SELECT ${jobColumns} FROM jobs ${where} ORDER BY submitted_at DESC
       LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    );
    return result.rows;
  }

  async getJob(id: string): Promise<Job | null> {
    const result = await this.pool.query<Job>(
      `SELECT ${jobColumns} FROM jobs WHERE id = $1`, [id],
    );
    return result.rows[0] ?? null;
  }

  async getJobEvents(id: string): Promise<unknown[]> {
    const result = await this.pool.query(
      'SELECT id, job_id, event_type, timestamp, metadata FROM job_events WHERE job_id = $1 ORDER BY timestamp ASC',
      [id],
    );
    return result.rows;
  }

  async getMetricsSummary(): Promise<Record<string, number>> {
    const summary: Record<string, number> = {
      queued: 0, scheduled: 0, running: 0, completed: 0,
      failed: 0, timed_out: 0, cancelled: 0, total: 0,
    };
    const result = await this.pool.query<{ status: string; count: string }>(
      'SELECT status, COUNT(*) FROM jobs GROUP BY status',
    );
    for (const row of result.rows) {
      const count = Number(row.count);
      if (Object.hasOwn(summary, row.status)) summary[row.status] = count;
      summary.total = (summary.total ?? 0) + count;
    }
    return summary;
  }

  async getNextJob(workerID: string): Promise<Job | null> {
    const client = await this.pool.connect();
    let committed = false;
    try {
      await client.query('BEGIN');
      // Scheduler-assigned jobs must be consumed by their designated worker.
      const assigned = await client.query<Job>(`
        SELECT ${jobColumns} FROM jobs
        WHERE status = 'scheduled' AND worker_id = $1
        ORDER BY scheduled_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED`, [workerID]);
      if (assigned.rows[0]) {
        const claimed = await client.query<Job>(`
          UPDATE jobs SET status = 'running', started_at = NOW(),
            lock_expires_at = NOW() + ((timeout_seconds + 30) * INTERVAL '1 second')
          WHERE id = $1 RETURNING ${jobColumns}`, [assigned.rows[0].id]);
        await client.query('COMMIT');
        committed = true;
        return claimed.rows[0] ?? null;
      }
      return null;
    } finally {
      if (!committed) await client.query('ROLLBACK');
      client.release();
    }
  }

  async updateJobStatus(input: {
    jobID: string; status: string; workerID: string | null;
    logsPath: string | null; artifactPath: string | null;
  }): Promise<Job | null> {
    if (input.status === 'scheduled') {
      const result = await this.pool.query<Job>(`
        UPDATE jobs SET status = $2, worker_id = $3, scheduled_at = NOW(),
          lock_expires_at = NOW() + INTERVAL '30 seconds'
        WHERE id = $1 RETURNING ${jobColumns}`,
      [input.jobID, input.status, input.workerID]);
      return result.rows[0] ?? null;
    }
    if (input.status === 'running') {
      const result = await this.pool.query<Job>(`
        UPDATE jobs SET status = $2, started_at = NOW(),
          lock_expires_at = NOW() + ((timeout_seconds + 30) * INTERVAL '1 second')
        WHERE id = $1 AND status = 'running' AND worker_id = $3
        RETURNING ${jobColumns}`, [input.jobID, input.status, input.workerID]);
      return result.rows[0] ?? null;
    }

    const client = await this.pool.connect();
    let committed = false;
    try {
      await client.query('BEGIN');
      const result = await client.query<Job>(`
        UPDATE jobs SET
          status = CASE WHEN $2 = 'failed' AND retries < max_retries THEN 'queued' ELSE $2 END,
          retries = CASE WHEN $2 = 'failed' AND retries < max_retries THEN retries + 1 ELSE retries END,
          worker_id = CASE WHEN $2 = 'failed' AND retries < max_retries THEN NULL ELSE worker_id END,
          scheduled_at = CASE WHEN $2 = 'failed' AND retries < max_retries THEN NULL ELSE scheduled_at END,
          started_at = CASE WHEN $2 = 'failed' AND retries < max_retries THEN NULL ELSE started_at END,
          completed_at = CASE WHEN $2 = 'failed' AND retries < max_retries THEN NULL ELSE NOW() END,
          lock_expires_at = NULL,
          logs_path = COALESCE($3, logs_path),
          artifact_path = CASE WHEN $2 = 'failed' AND retries < max_retries THEN NULL ELSE COALESCE($4, artifact_path) END
        WHERE id = $1 AND status = 'running' AND worker_id = $5
        RETURNING ${jobColumns}`,
      [input.jobID, input.status, input.logsPath, input.artifactPath, input.workerID]);
      const job = result.rows[0];
      if (!job) return null;
      if (input.workerID) {
        await client.query(
          'UPDATE workers SET current_load = GREATEST(0, current_load - 1) WHERE id = $1',
          [input.workerID],
        );
      }
      await client.query('COMMIT');
      committed = true;
      return job;
    } finally {
      if (!committed) await client.query('ROLLBACK');
      client.release();
    }
  }
}

export function createPool(databaseURL: string): PoolType {
  if (!databaseURL) throw new Error('DATABASE_URL is required');
  const pool = new pg.Pool({ connectionString: databaseURL });
  pool.on('error', (error) => console.error('PostgreSQL idle client error', error));
  return pool;
}
