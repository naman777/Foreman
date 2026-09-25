import { mkdir, writeFile } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import type { CoordinatorClient, Job } from './client.js';
import type { DockerExecutor, ExecutionResult } from './executor.js';
import type { ArtifactUploader } from './uploader.js';

type Client = Pick<CoordinatorClient, 'register' | 'heartbeat' | 'pollJob' | 'reportStatus'>;
type Executor = Pick<DockerExecutor, 'run'>;
type Uploader = Pick<ArtifactUploader, 'uploadArtifacts'>;

export interface WorkerOptions {
  hostname?: string;
  cpuCores?: number;
  memoryMB?: number;
  maxParallel?: number;
  persistWorkerID?: boolean;
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
    };
    if (!Number.isInteger(this.options.maxParallel) || this.options.maxParallel <= 0) {
      throw new Error('maxParallel must be a positive integer');
    }
  }

  get currentLoad(): number { return this.active.size; }

  async start(): Promise<void> {
    const worker = await this.client.register(
      this.options.hostname, this.options.cpuCores, this.options.memoryMB);
    this.workerID = worker.id;
    if (this.options.persistWorkerID) {
      const dir = join(homedir(), '.foreman');
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await writeFile(join(dir, 'worker_id'), this.workerID, { mode: 0o600 });
    }
    this.heartbeatTimer = setInterval(() => {
      void this.heartbeat().catch((error) => console.warn('heartbeat failed', error));
    }, 5000);
    this.pollTimer = setInterval(() => {
      void this.pollOnce().catch((error) => console.warn('job poll failed', error));
    }, 3000);
  }

  async heartbeat(): Promise<void> {
    if (this.workerID && !this.stopping) {
      await this.client.heartbeat(this.workerID, this.currentLoad);
    }
  }

  async pollOnce(): Promise<void> {
    if (!this.workerID || this.stopping || this.polling || this.currentLoad >= this.options.maxParallel) return;
    this.polling = true;
    try {
      const job = await this.client.pollJob(this.workerID);
      if (!job || this.stopping) return;
      const task = this.runJob(job);
      this.active.add(task);
      void task.finally(() => this.active.delete(task)).catch((error) =>
        console.error('unexpected job error', job.id, error));
    } finally { this.polling = false; }
  }

  private async runJob(job: Job): Promise<void> {
    try {
      await this.client.reportStatus({ jobID: job.id, status: 'running', workerID: this.workerID });
    } catch (error) {
      console.error('failed to report running', job.id, error);
      return;
    }

    let result: ExecutionResult | undefined;
    let executionError: unknown;
    try { result = await this.executor.run(job); }
    catch (error) { executionError = error; console.error('job execution failed', job.id, error); }

    const status = result?.timedOut ? 'timed_out'
      : executionError || !result || result.exitCode !== 0 ? 'failed' : 'completed';
    let artifactPath: string | undefined;
    if (this.uploader && result?.artifactDir) {
      try { artifactPath = await this.uploader.uploadArtifacts(job.id, result.artifactDir) ?? undefined; }
      catch (error) { console.error('artifact upload failed', job.id, error); }
    }
    try {
      await this.client.reportStatus({ jobID: job.id, status, workerID: this.workerID,
        logsPath: result?.logsPath, artifactPath });
    } catch (error) { console.error('failed to report job result', job.id, error); }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    await Promise.allSettled([...this.active]);
  }
}
