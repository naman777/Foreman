import type { Pool } from 'pg';
import { jobColumns } from './columns.js';
import type { SchedulerStore, WorkerWithLoad } from './scheduler.js';
import type { Job } from './types.js';

export class PostgresSchedulerStore implements SchedulerStore {
  constructor(private readonly pool: Pool) {}

  async getQueuedJobs(limit: number): Promise<Job[]> {
    // Higher priority first; jobs in retry backoff are skipped until run_after passes.
    const result = await this.pool.query<Job>(`
      SELECT ${jobColumns} FROM jobs
      WHERE status = 'queued' AND (run_after IS NULL OR run_after <= NOW())
      ORDER BY priority DESC, submitted_at ASC LIMIT $1`, [limit]);
    return result.rows;
  }

  async getEligibleWorkersWithLoad(): Promise<WorkerWithLoad[]> {
    const result = await this.pool.query<WorkerWithLoad>(`
      SELECT w.id, w.hostname, w.status, w.last_heartbeat, w.cpu_cores, w.memory_mb,
        w.labels, w.current_load, w.registered_at,
        COALESCE(SUM(j.required_cpu), 0)::int AS used_cpu,
        COALESCE(SUM(j.required_memory), 0)::int AS used_memory
      FROM workers w
      LEFT JOIN jobs j ON j.worker_id = w.id AND j.status IN ('running', 'scheduled')
      WHERE w.status = 'online'
      GROUP BY w.id ORDER BY w.current_load ASC`);
    return result.rows;
  }

  async assignJob(jobID: string, workerID: string): Promise<boolean> {
    const client = await this.pool.connect();
    let committed = false;
    try {
      await client.query('BEGIN');
      const result = await client.query(`
        UPDATE jobs SET status = 'scheduled', worker_id = $2, scheduled_at = NOW(),
          lock_expires_at = NOW() + INTERVAL '30 seconds'
        WHERE id = $1 AND status = 'queued'`, [jobID, workerID]);
      if (!result.rowCount) return false;
      await client.query('UPDATE workers SET current_load = current_load + 1 WHERE id = $1', [workerID]);
      await client.query('COMMIT');
      committed = true;
      return true;
    } finally {
      if (!committed) await client.query('ROLLBACK');
      client.release();
    }
  }
}
