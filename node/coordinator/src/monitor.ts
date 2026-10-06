import { log } from './log.js';

export interface RecoveredJob {
  id: string;
  status: 'queued' | 'failed' | 'cancelled';
  retries: number;
}

export interface MonitorStore {
  markWorkersUnhealthy(): Promise<string[]>;
  markWorkersOffline(): Promise<string[]>;
  recoverJobsForWorkers(ids: string[]): Promise<RecoveredJob[]>;
  recoverStaleJobs(): Promise<RecoveredJob[]>;
  createJobEvent(id: string, type: string, metadata: Record<string, unknown>): Promise<void>;
  pruneExpired?(retention: { jobDays: number; workerHours: number }): Promise<{ jobs: number; workers: number }>;
}

export interface MonitorOptions {
  /** Terminal jobs older than this are deleted hourly. 0 disables pruning. */
  retentionDays?: number;
  /** Offline workers silent for this long are deleted (their job history is kept). */
  staleWorkerHours?: number;
  now?: () => number;
}

const eventTypes = { failed: 'auto_failed', cancelled: 'auto_cancelled', queued: 'auto_recovered' } as const;
const pruneEveryMs = 60 * 60 * 1000;

export class Monitor {
  private lastPrune = Number.NEGATIVE_INFINITY;
  private readonly retentionDays: number;
  private readonly staleWorkerHours: number;
  private readonly now: () => number;

  constructor(private readonly store: MonitorStore, options: MonitorOptions = {}) {
    this.retentionDays = options.retentionDays ?? 30;
    this.staleWorkerHours = options.staleWorkerHours ?? 24;
    this.now = options.now ?? Date.now;
  }

  async runOnce(): Promise<void> {
    await this.store.markWorkersUnhealthy();
    const offline = await this.store.markWorkersOffline();
    if (offline.length) {
      await this.emit(await this.store.recoverJobsForWorkers(offline), 'worker_offline');
    }
    await this.emit(await this.store.recoverStaleJobs(), 'lock_expired');
    await this.prune();
  }

  private async prune(): Promise<void> {
    if (!this.store.pruneExpired || this.retentionDays <= 0) return;
    const current = this.now();
    if (current - this.lastPrune < pruneEveryMs) return;
    this.lastPrune = current;
    const removed = await this.store.pruneExpired({
      jobDays: this.retentionDays, workerHours: this.staleWorkerHours });
    if (removed.jobs || removed.workers) log.info('pruned expired rows', removed);
  }

  private async emit(jobs: RecoveredJob[], reason: string): Promise<void> {
    for (const job of jobs) {
      try {
        await this.store.createJobEvent(job.id, eventTypes[job.status],
          { new_status: job.status, retries: job.retries, reason });
      } catch (error) {
        log.error('failed to create recovery event', { jobID: job.id, error });
      }
    }
  }
}

export function startMonitor(monitor: Monitor): () => void {
  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    void monitor.runOnce().catch((error) => log.error('monitor pass failed', { error }))
      .finally(() => { running = false; });
  };
  tick();
  const timer = setInterval(tick, 5000);
  return () => clearInterval(timer);
}
