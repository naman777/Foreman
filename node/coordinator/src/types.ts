import type { Job, Worker } from './shared.js';

export type { Job, JobEvent, JobStatus, MetricsSummary, Worker, WorkerStatus, WSEvent } from './shared.js';

export interface WorkerStore {
  registerWorker(input: {
    workerID?: string | null; hostname: string; cpuCores: number; memoryMB: number;
    labels: Record<string, unknown>; tokenHash: string;
  }): Promise<Worker>;
  updateHeartbeat(workerID: string, currentLoad: number): Promise<boolean>;
  listWorkers(): Promise<Worker[]>;
  /** True when `tokenHash` is the credential issued to this worker at registration. */
  verifyToken?(workerID: string, tokenHash: string): Promise<boolean>;
}

export type CancelState = 'cancelled' | 'requested' | 'finished';

export interface JobStore {
  createJob(input: {
    name: string | null; imageName: string; command: string; requiredCPU: number;
    requiredMemory: number; maxRetries: number; timeoutSeconds: number; priority: number;
    selector?: Record<string, unknown>; isDemo?: boolean;
  }): Promise<Job>;
  createJobEvent(jobID: string, type: string, metadata: Record<string, unknown>): Promise<void>;
  listJobs(filters: {
    status: string; workerID: string | null; limit: number; offset: number; demo?: boolean;
  }): Promise<Job[]>;
  getJob(id: string): Promise<Job | null>;
  getJobEvents(id: string): Promise<unknown[]>;
  getNextJob(workerID: string): Promise<Job | null>;
  updateJobStatus(input: {
    jobID: string; status: string; workerID: string | null;
    logsPath: string | null; artifactPath: string | null;
  }): Promise<Job | null>;
  cancelJob?(id: string): Promise<{ job: Job; state: CancelState } | null>;
  getCancelRequests?(workerID: string): Promise<string[]>;
  getMetricsSummary(): Promise<Record<string, number>>;
}

export interface ArtifactStore {
  getPresignedURL(objectKey: string): Promise<string>;
  getText?(objectKey: string, maxBytes: number): Promise<string>;
}
