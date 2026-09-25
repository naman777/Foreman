import type { Pool } from 'pg';
import type { MonitorStore, RecoveredJob } from './monitor.js';

const recoverSet = `retries = retries + 1,
  status = CASE WHEN retries + 1 <= max_retries THEN 'queued' ELSE 'failed' END,
  worker_id = CASE WHEN retries + 1 <= max_retries THEN NULL ELSE worker_id END,
  scheduled_at = CASE WHEN retries + 1 <= max_retries THEN NULL ELSE scheduled_at END,
  started_at = CASE WHEN retries + 1 <= max_retries THEN NULL ELSE started_at END,
  lock_expires_at = NULL,
  completed_at = CASE WHEN retries + 1 > max_retries THEN NOW() ELSE completed_at END`;

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
}
