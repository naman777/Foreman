import { randomUUID } from 'node:crypto';
import { log } from './log.js';
import type { Job, Worker } from './types.js';

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

function matchesSelector(job: Job, worker: Worker): boolean {
  for (const [key, wanted] of Object.entries(job.selector ?? {})) {
    const actual = worker.labels?.[key];
    if (actual === undefined || String(actual) !== String(wanted)) return false;
  }
  return true;
}

export function selectWorker(job: Job, workers: WorkerWithLoad[], maxParallel: number): WorkerWithLoad | null {
  let best: WorkerWithLoad | null = null;
  let bestScore = -1;
  for (const worker of workers) {
    const freeCPU = worker.cpu_cores - worker.used_cpu;
    const freeMemory = worker.memory_mb - worker.used_memory;
    if (worker.status !== 'online' || freeCPU < job.required_cpu ||
        freeMemory < job.required_memory || worker.current_load >= maxParallel ||
        worker.cpu_cores <= 0 || worker.memory_mb <= 0 || !matchesSelector(job, worker)) continue;
    const score = 0.4 * freeCPU / worker.cpu_cores +
      0.4 * freeMemory / worker.memory_mb -
      0.2 * worker.current_load / maxParallel;
    if (score > bestScore) { best = worker; bestScore = score; }
  }
  return best;
}

const batchSize = 50;

export class Scheduler {
  readonly instanceID = randomUUID();
  constructor(private readonly store: SchedulerStore, private readonly locker: JobLocker,
    private readonly maxParallel = 4) {
    if (!Number.isInteger(maxParallel) || maxParallel <= 0) throw new Error('maxParallel must be positive');
  }

  /** Assigns as many queued jobs as capacity allows and returns how many were assigned. */
  async runBatch(): Promise<number> {
    const jobs = await this.store.getQueuedJobs(batchSize);
    if (jobs.length === 0) return 0;
    const workers = await this.store.getEligibleWorkersWithLoad();
    let assigned = 0;
    for (const job of jobs) {
      const worker = selectWorker(job, workers, this.maxParallel);
      if (!worker) continue;
      try {
        if (!await this.locker.lock(job.id, this.instanceID)) continue;
      } catch (error) {
        // The guarded database update remains authoritative if Redis is unavailable.
        log.warn('Redis scheduler lock failed; using database guard', { error });
      }
      if (await this.store.assignJob(job.id, worker.id)) {
        worker.used_cpu += job.required_cpu;
        worker.used_memory += job.required_memory;
        worker.current_load += 1;
        assigned += 1;
      }
    }
    return assigned;
  }
}

export interface SchedulerHandle {
  stop(): void;
  /** Runs a batch now (e.g. a job was just queued) instead of waiting for the next tick. */
  kick(): void;
}

export function startScheduler(scheduler: Scheduler, intervalMs = 1000): SchedulerHandle {
  let running = false;
  let again = false;
  const tick = (): void => {
    if (running) { again = true; return; }
    running = true;
    void scheduler.runBatch()
      .then((assigned) => { again = again || assigned > 0; })
      .catch((error) => log.error('scheduler batch failed', { error }))
      .finally(() => {
        running = false;
        if (again) { again = false; tick(); }
      });
  };
  const timer = setInterval(tick, intervalMs);
  return { stop: () => clearInterval(timer), kick: tick };
}
