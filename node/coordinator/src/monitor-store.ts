import type { Pool } from 'pg';
import type { MonitorStore, RecoveredJob } from './monitor.js';

// A recovered job is requeued while retries remain, unless someone asked to cancel it.
const requeue = '(retries + 1 <= max_retries AND NOT cancel_requested)';
const recoverSet = `retries = retries + 1,
  status = CASE WHEN cancel_requested THEN 'cancelled'
                WHEN retries + 1 <= max_retries THEN 'queued' ELSE 'failed' END,
  worker_id = CASE WHEN ${requeue} THEN NULL ELSE worker_id END,
  scheduled_at = CASE WHEN ${requeue} THEN NULL ELSE scheduled_at END,
  started_at = CASE WHEN ${requeue} THEN NULL ELSE started_at END,
  lock_expires_at = NULL,
  completed_at = CASE WHEN ${requeue} THEN completed_at ELSE NOW() END`;

export class PostgresMonitorStore implements MonitorStore {
  constructor(private readonly pool: Pool) {}

  async markWorkersUnhealthy(): Promise<string[]> {
    const result = await this.pool.query<{ id: string }>(`
      UPDATE workers SET status = 'unhealthy'
      WHERE status = 'online' AND last_heartbeat < NOW() - INTERVAL '15 seconds'
      RETURNING id`);
    return result.rows.map((row) => row.id);
  }

  async markWorkersOffline(): Promise<string[]> {
    const result = await this.pool.query<{ id: string }>(`
      UPDATE workers SET status = 'offline', current_load = 0
      WHERE status IN ('online', 'unhealthy')
        AND last_heartbeat < NOW() - INTERVAL '30 seconds'
      RETURNING id`);
    return result.rows.map((row) => row.id);
  }

  async recoverJobsForWorkers(ids: string[]): Promise<RecoveredJob[]> {
    if (!ids.length) return [];
    const result = await this.pool.query<RecoveredJob>(`
      UPDATE jobs SET ${recoverSet}
      WHERE worker_id = ANY($1::uuid[]) AND status IN ('running', 'scheduled')
      RETURNING id, status, retries`, [ids]);
    return result.rows;
  }

  async recoverStaleJobs(): Promise<RecoveredJob[]> {
    const result = await this.pool.query<RecoveredJob>(`
      UPDATE jobs SET ${recoverSet}
      WHERE status IN ('running', 'scheduled') AND lock_expires_at < NOW()
      RETURNING id, status, retries`);
    return result.rows;
  }

  async createJobEvent(id: string, type: string, metadata: Record<string, unknown>): Promise<void> {
    await this.pool.query(
      'INSERT INTO job_events (job_id, event_type, metadata) VALUES ($1, $2, $3::jsonb)',
      [id, type, JSON.stringify(metadata)],
    );
  }

  async pruneExpired(retention: { jobDays: number; workerHours: number }): Promise<{ jobs: number; workers: number }> {
    const jobs = await this.pool.query(`
      DELETE FROM jobs
      WHERE status IN ('completed', 'failed', 'timed_out', 'cancelled')
        AND completed_at < NOW() - make_interval(days => $1::int)`, [retention.jobDays]);
    const workers = await this.pool.query(`
      DELETE FROM workers w
      WHERE w.status = 'offline' AND w.last_heartbeat < NOW() - make_interval(hours => $1::int)
        AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.worker_id = w.id
                        AND j.status IN ('scheduled', 'running'))`, [retention.workerHours]);
    return { jobs: jobs.rowCount ?? 0, workers: workers.rowCount ?? 0 };
  }
}
