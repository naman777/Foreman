import { randomUUID } from 'node:crypto';
import type { Job, Worker } from './server.js';

export interface WorkerWithLoad extends Worker {
  used_cpu: number;
  used_memory: number;
}

export interface SchedulerStore {
  getQueuedJobs(limit: number): Promise<Job[]>;
  getEligibleWorkersWithLoad(): Promise<WorkerWithLoad[]>;
  assignJob(jobID: string, workerID: string): Promise<boolean>;
}

export interface JobLocker {
  lock(jobID: string, owner: string): Promise<boolean>;
}

export function selectWorker(job: Job, workers: WorkerWithLoad[], maxParallel: number): WorkerWithLoad | null {
  let best: WorkerWithLoad | null = null;
  let bestScore = -1;
  for (const worker of workers) {
    const freeCPU = worker.cpu_cores - worker.used_cpu;
    const freeMemory = worker.memory_mb - worker.used_memory;
    if (worker.status !== 'online' || freeCPU < job.required_cpu ||
        freeMemory < job.required_memory || worker.current_load >= maxParallel ||
        worker.cpu_cores <= 0 || worker.memory_mb <= 0) continue;
    const score = 0.4 * freeCPU / worker.cpu_cores +
      0.4 * freeMemory / worker.memory_mb -
      0.2 * worker.current_load / maxParallel;
    if (score > bestScore) { best = worker; bestScore = score; }
  }
  return best;
}

export class Scheduler {
  readonly instanceID = randomUUID();
  constructor(private readonly store: SchedulerStore, private readonly locker: JobLocker,
    private readonly maxParallel = 4) {
    if (!Number.isInteger(maxParallel) || maxParallel <= 0) throw new Error('maxParallel must be positive');
  }

  async runBatch(): Promise<void> {
    const jobs = await this.store.getQueuedJobs(10);
    if (jobs.length === 0) return;
    const workers = await this.store.getEligibleWorkersWithLoad();
    for (const job of jobs) {
      const worker = selectWorker(job, workers, this.maxParallel);
      if (!worker) continue;
      try {
        if (!await this.locker.lock(job.id, this.instanceID)) continue;
      } catch (error) {
        // The guarded database update remains authoritative if Redis is unavailable.
        console.warn('Redis scheduler lock failed; using database guard', error);
      }
      if (await this.store.assignJob(job.id, worker.id)) {
        worker.used_cpu += job.required_cpu;
        worker.used_memory += job.required_memory;
        worker.current_load += 1;
      }
    }
  }
}

export function startScheduler(scheduler: Scheduler): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void scheduler.runBatch().catch((error) => console.error('scheduler batch failed', error))
      .finally(() => { running = false; });
  }, 2000);
  return () => clearInterval(timer);
}
