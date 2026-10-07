import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { CoordinatorError, type CoordinatorClient, type Job } from './client.js';
import type { DockerExecutor, ExecutionResult } from './executor.js';
import { log } from './log.js';
import type { ArtifactUploader } from './uploader.js';

type Client = Pick<CoordinatorClient, 'register' | 'heartbeat' | 'pollJob' | 'reportStatus'>;
type Executor = Pick<DockerExecutor, 'run' | 'cancel' | 'cleanup'>;
type Uploader = Pick<ArtifactUploader, 'uploadArtifacts' | 'uploadLogs'>;

export interface WorkerOptions {
  hostname?: string;
  cpuCores?: number;
  memoryMB?: number;
  maxParallel?: number;
  /** Remember the worker ID on disk so a restart re-attaches to the same coordinator row. */
  persistWorkerID?: boolean;
  workerIDFile?: string;
  labels?: Record<string, string>;
  /** How long each job poll may be held open by the coordinator. */
  pollWaitSeconds?: number;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Parses "region=eu,gpu=true" into labels. */
export function parseLabels(value: string | undefined): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const pair of (value ?? '').split(',')) {
    const [key, ...rest] = pair.split('=');
    if (key?.trim() && rest.length) labels[key.trim()] = rest.join('=').trim();
  }
  return labels;
}

export class WorkerRuntime {
  private workerID = '';
  private active = new Set<Promise<void>>();
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private pollTimer: NodeJS.Timeout | undefined;
  private polling = false;
  private stopping = false;
  private readonly options: Required<WorkerOptions>;

  constructor(private readonly client: Client, private readonly executor: Executor,
    private readonly uploader: Uploader | null, options: WorkerOptions = {}) {
    this.options = {
      hostname: options.hostname ?? hostname(),
      cpuCores: options.cpuCores ?? 2,
      memoryMB: options.memoryMB ?? 1024,
      maxParallel: options.maxParallel ?? 4,
      persistWorkerID: options.persistWorkerID ?? true,
      workerIDFile: options.workerIDFile ?? join(homedir(), '.foreman', 'worker_id'),
      labels: options.labels ?? {},
      pollWaitSeconds: options.pollWaitSeconds ?? 10,
    };
    if (!Number.isInteger(this.options.maxParallel) || this.options.maxParallel <= 0) {
      throw new Error('maxParallel must be a positive integer');
    }
  }

  get currentLoad(): number { return this.active.size; }

  private async savedWorkerID(): Promise<string | undefined> {
    if (!this.options.persistWorkerID) return undefined;
    try {
      const saved = (await readFile(this.options.workerIDFile, 'utf8')).trim();
      return uuid.test(saved) ? saved : undefined;
    } catch { return undefined; }
  }

  async start(): Promise<void> {
    const worker = await this.client.register(
      this.options.hostname, this.options.cpuCores, this.options.memoryMB,
      { workerID: await this.savedWorkerID(), labels: this.options.labels });
    this.workerID = worker.id;
    if (this.options.persistWorkerID) {
      await mkdir(dirname(this.options.workerIDFile), { recursive: true, mode: 0o700 });
      await writeFile(this.options.workerIDFile, this.workerID, { mode: 0o600 });
    }
    this.heartbeatTimer = setInterval(() => {
      void this.heartbeat().catch((error) => log.warn('heartbeat failed', { error }));
    }, 5000);
    this.pollTimer = setInterval(() => {
      void this.pollOnce().catch((error) => log.warn('job poll failed', { error }));
    }, 3000);
  }

  /** The coordinator rejected our token (e.g. it was rotated): register again to get a new one. */
  private async recoverCredentials<T>(work: () => Promise<T>): Promise<T> {
    try { return await work(); }
    catch (error) {
      if (!(error instanceof CoordinatorError) || error.status !== 401) throw error;
      log.warn('worker token rejected; registering again');
      await this.client.register(this.options.hostname, this.options.cpuCores, this.options.memoryMB,
        { workerID: this.workerID, labels: this.options.labels });
      throw error;
    }
  }

  async heartbeat(): Promise<void> {
    if (this.workerID && !this.stopping) {
      const cancelJobs = await this.recoverCredentials(
        () => this.client.heartbeat(this.workerID, this.currentLoad));
      for (const jobID of cancelJobs ?? []) {
        void this.executor.cancel(jobID).catch((error) => log.warn('cancel failed', { jobID, error }));
      }
    }
  }

  async pollOnce(): Promise<void> {
    if (!this.workerID || this.stopping || this.polling || this.currentLoad >= this.options.maxParallel) return;
    this.polling = true;
    try {
      const job = await this.recoverCredentials(
        () => this.client.pollJob(this.workerID, this.options.pollWaitSeconds));
      if (!job || this.stopping) return;
      const task = this.runJob(job);
      this.active.add(task);
      void task.finally(() => this.active.delete(task)).catch((error) =>
        log.error('unexpected job error', { jobID: job.id, error }));
    } finally { this.polling = false; }
  }

  private async runJob(job: Job): Promise<void> {
    try {
      await this.client.reportStatus({ jobID: job.id, status: 'running', workerID: this.workerID });
    } catch (error) {
      log.error('failed to report running', { jobID: job.id, error });
      return;
    }

    let result: ExecutionResult | undefined;
    let executionError: unknown;
    try { result = await this.executor.run(job); }
    catch (error) { executionError = error; log.error('job execution failed', { jobID: job.id, error }); }

    const status = result?.cancelled ? 'cancelled'
      : result?.timedOut ? 'timed_out'
        : executionError || !result || result.exitCode !== 0 ? 'failed' : 'completed';
    let artifactPath: string | undefined;
    let logsPath = result?.logsPath;
    let logsUploaded = false;
    if (this.uploader && result?.artifactDir) {
      try { artifactPath = await this.uploader.uploadArtifacts(job.id, result.artifactDir) ?? undefined; }
      catch (error) { log.error('artifact upload failed', { jobID: job.id, error }); }
    }
    if (this.uploader && result?.logsPath) {
      try {
        logsPath = await this.uploader.uploadLogs(job.id, result.logsPath);
        logsUploaded = true;
      } catch (error) { log.error('log upload failed', { jobID: job.id, error }); }
    }
    try {
      await this.client.reportStatus({ jobID: job.id, status, workerID: this.workerID,
        logsPath, artifactPath });
    } catch (error) { log.error('failed to report job result', { jobID: job.id, error }); }
    await this.executor.cleanup(job.id, !logsUploaded)
      .catch((error) => log.warn('cleanup failed', { jobID: job.id, error }));
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    await Promise.allSettled([...this.active]);
  }
}
