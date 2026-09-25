export interface RecoveredJob {
  id: string;
  status: 'queued' | 'failed';
  retries: number;
}

export interface MonitorStore {
  markWorkersUnhealthy(): Promise<string[]>;
  markWorkersOffline(): Promise<string[]>;
  recoverJobsForWorkers(ids: string[]): Promise<RecoveredJob[]>;
  recoverStaleJobs(): Promise<RecoveredJob[]>;
  createJobEvent(id: string, type: string, metadata: Record<string, unknown>): Promise<void>;
}

export class Monitor {
  constructor(private readonly store: MonitorStore) {}

  async runOnce(): Promise<void> {
    await this.store.markWorkersUnhealthy();
    const offline = await this.store.markWorkersOffline();
    if (offline.length) {
      await this.emit(await this.store.recoverJobsForWorkers(offline), 'worker_offline');
    }
    await this.emit(await this.store.recoverStaleJobs(), 'lock_expired');
  }

  private async emit(jobs: RecoveredJob[], reason: string): Promise<void> {
    for (const job of jobs) {
      try {
        await this.store.createJobEvent(job.id,
          job.status === 'failed' ? 'auto_failed' : 'auto_recovered',
          { new_status: job.status, retries: job.retries, reason });
      } catch (error) {
        console.error('failed to create recovery event', job.id, error);
      }
    }
  }
}

export function startMonitor(monitor: Monitor): () => void {
  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    void monitor.runOnce().catch((error) => console.error('monitor pass failed', error))
      .finally(() => { running = false; });
  };
  tick();
  const timer = setInterval(tick, 5000);
  return () => clearInterval(timer);
}
