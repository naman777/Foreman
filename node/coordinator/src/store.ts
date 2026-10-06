import pg, { type Pool as PoolType } from 'pg';
import { jobColumns, workerColumns } from './columns.js';
import { log } from './log.js';
import type { CancelState, Job, JobStore, Worker, WorkerStore } from './types.js';

// Failures and timeouts both consume a retry; the job waits 5s, 10s, 20s... (max 5m).
const retryable = `$2 IN ('failed', 'timed_out') AND retries < max_retries`;
const backoff = `NOW() + (LEAST(300, 5 * POWER(2, retries)) * INTERVAL '1 second')`;

export class PostgresWorkerStore implements WorkerStore {
  constructor(private readonly pool: PoolType) {}

  async registerWorker(input: {
    workerID?: string | null; hostname: string; cpuCores: number; memoryMB: number;
    labels: Record<string, unknown>; tokenHash: string;
  }): Promise<Worker> {
    // A worker that restarts with its saved ID takes over its old row instead of adding a new one.
    const result = await this.pool.query<Worker>(`
      INSERT INTO workers (id, hostname, cpu_cores, memory_mb, labels, registered_token_hash, last_heartbeat)
      VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, $5::jsonb, $6, NOW())
      ON CONFLICT (id) DO UPDATE SET hostname = EXCLUDED.hostname, cpu_cores = EXCLUDED.cpu_cores,
        memory_mb = EXCLUDED.memory_mb, labels = EXCLUDED.labels,
        registered_token_hash = EXCLUDED.registered_token_hash,
        status = 'online', current_load = 0, last_heartbeat = NOW()
      RETURNING ${workerColumns}`,
    [input.workerID ?? null, input.hostname, input.cpuCores, input.memoryMB,
      JSON.stringify(input.labels), input.tokenHash]);
    const worker = result.rows[0];
    if (!worker) throw new Error('worker insert returned no row');
    return worker;
  }

  async updateHeartbeat(workerID: string, currentLoad: number): Promise<boolean> {
    // A heartbeat proves the worker is alive, so it also revives unhealthy/offline workers.
    const result = await this.pool.query(`
      UPDATE workers SET last_heartbeat = NOW(), current_load = $2,
        status = CASE WHEN status IN ('unhealthy', 'offline') THEN 'online' ELSE status END
      WHERE id = $1`,
    [workerID, currentLoad]);
    return (result.rowCount ?? 0) > 0;
  }

  async verifyToken(workerID: string, tokenHash: string): Promise<boolean> {
    const result = await this.pool.query(
      'SELECT 1 FROM workers WHERE id = $1 AND registered_token_hash = $2', [workerID, tokenHash]);
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
    selector?: Record<string, unknown>; isDemo?: boolean;
  }): Promise<Job> {
    const result = await this.pool.query<Job>(`
      INSERT INTO jobs (name, image_name, command, required_cpu, required_memory,
        max_retries, timeout_seconds, priority, selector, is_demo)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
      RETURNING ${jobColumns}`,
    [input.name, input.imageName, input.command, input.requiredCPU,
      input.requiredMemory, input.maxRetries, input.timeoutSeconds, input.priority,
      JSON.stringify(input.selector ?? {}), input.isDemo ?? false]);
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
    status: string; workerID: string | null; limit: number; offset: number; demo?: boolean;
  }): Promise<Job[]> {
    const clauses: string[] = [];
    const values: unknown[] = [];
    if (filters.status) { values.push(filters.status); clauses.push(`status = $${values.length}`); }
    if (filters.workerID) { values.push(filters.workerID); clauses.push(`worker_id = $${values.length}`); }
    if (filters.demo) clauses.push('is_demo');
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
          status = CASE WHEN ${retryable} THEN 'queued' ELSE $2 END,
          retries = CASE WHEN ${retryable} THEN retries + 1 ELSE retries END,
          run_after = CASE WHEN ${retryable} THEN ${backoff} ELSE run_after END,
          worker_id = CASE WHEN ${retryable} THEN NULL ELSE worker_id END,
          scheduled_at = CASE WHEN ${retryable} THEN NULL ELSE scheduled_at END,
          started_at = CASE WHEN ${retryable} THEN NULL ELSE started_at END,
          completed_at = CASE WHEN ${retryable} THEN NULL ELSE NOW() END,
          lock_expires_at = NULL,
          logs_path = COALESCE($3, logs_path),
          artifact_path = CASE WHEN ${retryable} THEN NULL ELSE COALESCE($4, artifact_path) END
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

  async cancelJob(id: string): Promise<{ job: Job; state: CancelState } | null> {
    const client = await this.pool.connect();
    let committed = false;
    try {
      await client.query('BEGIN');
      const current = await client.query<{ status: string; worker_id: string | null }>(
        'SELECT status, worker_id FROM jobs WHERE id = $1 FOR UPDATE', [id]);
      const row = current.rows[0];
      if (!row) return null;
      let state: CancelState = 'finished';
      if (row.status === 'queued' || row.status === 'scheduled') {
        await client.query(`
          UPDATE jobs SET status = 'cancelled', completed_at = NOW(), lock_expires_at = NULL,
            cancel_requested = TRUE WHERE id = $1`, [id]);
        if (row.status === 'scheduled' && row.worker_id) {
          await client.query(
            'UPDATE workers SET current_load = GREATEST(0, current_load - 1) WHERE id = $1',
            [row.worker_id]);
        }
        state = 'cancelled';
      } else if (row.status === 'running') {
        await client.query('UPDATE jobs SET cancel_requested = TRUE WHERE id = $1', [id]);
        state = 'requested';
      }
      const job = await client.query<Job>(`SELECT ${jobColumns} FROM jobs WHERE id = $1`, [id]);
      await client.query('COMMIT');
      committed = true;
      const value = job.rows[0];
      return value ? { job: value, state } : null;
    } finally {
      if (!committed) await client.query('ROLLBACK');
      client.release();
    }
  }

  async getCancelRequests(workerID: string): Promise<string[]> {
    const result = await this.pool.query<{ id: string }>(
      `SELECT id FROM jobs WHERE worker_id = $1 AND status = 'running' AND cancel_requested`,
      [workerID]);
    return result.rows.map((row) => row.id);
  }
}

export function createPool(databaseURL: string): PoolType {
  if (!databaseURL) throw new Error('DATABASE_URL is required');
  const pool = new pg.Pool({ connectionString: databaseURL });
  pool.on('error', (error) => log.error('PostgreSQL idle client error', { error }));
  return pool;
}
