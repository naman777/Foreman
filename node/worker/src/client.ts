import type { Job, Worker } from './shared.js';

export type { Job, Worker } from './shared.js';

export type ReportStatus = {
  jobID: string;
  status: 'scheduled' | 'running' | 'completed' | 'failed' | 'timed_out' | 'cancelled';
  workerID: string;
  logsPath?: string;
  artifactPath?: string;
};

export class CoordinatorError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export class CoordinatorClient {
  /** Per-worker credential issued by `register`; every later call authenticates with it. */
  private token: string | null = null;

  constructor(private readonly baseURL: string, private readonly secret: string) {}

  private async request(path: string, method: 'GET' | 'POST', body?: unknown,
    timeoutMs = 10_000, credential = this.token): Promise<Response> {
    if (!credential) throw new Error('worker is not registered');
    const response = await fetch(new URL(path, `${this.baseURL.replace(/\/$/, '')}/`), {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${credential}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status >= 400) {
      throw new CoordinatorError(`coordinator returned ${response.status} for ${method} ${path}`, response.status);
    }
    return response;
  }

  async register(hostname: string, cpuCores: number, memoryMB: number,
    options: { workerID?: string; labels?: Record<string, string> } = {}): Promise<Worker> {
    const response = await this.request('/workers/register', 'POST', {
      hostname, cpu_cores: cpuCores, memory_mb: memoryMB,
      ...(options.workerID ? { worker_id: options.workerID } : {}),
      ...(options.labels && Object.keys(options.labels).length ? { labels: options.labels } : {}),
    }, 10_000, this.secret);
    // Registration is the only call that uses the shared secret; it returns this worker's own token.
    const { token, ...worker } = await response.json() as Worker & { token?: string };
    if (!token) throw new Error('coordinator did not issue a worker token');
    this.token = token;
    return worker;
  }

  /** Returns the IDs of running jobs the coordinator wants this worker to cancel. */
  async heartbeat(workerID: string, currentLoad: number): Promise<string[]> {
    const response = await this.request('/workers/heartbeat', 'POST', {
      worker_id: workerID, current_load: currentLoad,
    });
    const body = await response.json().catch(() => ({})) as { cancel_jobs?: unknown };
    return Array.isArray(body.cancel_jobs)
      ? body.cancel_jobs.filter((id): id is string => typeof id === 'string') : [];
  }

  /** Long polls: the coordinator holds the request up to `waitSeconds` for a job to be assigned. */
  async pollJob(workerID: string, waitSeconds = 0): Promise<Job | null> {
    const response = await this.request(
      `/jobs/next?worker_id=${encodeURIComponent(workerID)}&wait=${waitSeconds}`, 'GET',
      undefined, 10_000 + waitSeconds * 1000);
    if (response.status === 204) return null;
    return response.json() as Promise<Job>;
  }

  async reportStatus({ jobID, status, workerID, logsPath, artifactPath }: ReportStatus): Promise<void> {
    await this.request(`/jobs/${encodeURIComponent(jobID)}/status`, 'POST', {
      status, worker_id: workerID,
      ...(logsPath ? { logs_path: logsPath } : {}),
      ...(artifactPath ? { artifact_path: artifactPath } : {}),
    });
  }
}
