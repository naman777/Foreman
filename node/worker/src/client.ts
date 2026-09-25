export interface Worker {
  id: string;
  hostname: string;
  status: 'online' | 'busy' | 'offline' | 'unhealthy';
  last_heartbeat: string | null;
  cpu_cores: number;
  memory_mb: number;
  labels: Record<string, unknown>;
  current_load: number;
  registered_at: string;
}

export interface Job {
  id: string;
  name: string | null;
  status: string;
  submitted_at: string;
  scheduled_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  retries: number;
  max_retries: number;
  timeout_seconds: number;
  required_cpu: number;
  required_memory: number;
  worker_id: string | null;
  image_name: string;
  command: string;
  logs_path: string | null;
  artifact_path: string | null;
  lock_expires_at: string | null;
  priority: number;
}

export type ReportStatus = {
  jobID: string;
  status: 'scheduled' | 'running' | 'completed' | 'failed' | 'timed_out' | 'cancelled';
  workerID: string;
  logsPath?: string;
  artifactPath?: string;
};

export class CoordinatorClient {
  constructor(private readonly baseURL: string, private readonly secret: string) {}

  private async request(path: string, method: 'GET' | 'POST', body?: unknown): Promise<Response> {
    const response = await fetch(new URL(path, `${this.baseURL.replace(/\/$/, '')}/`), {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.secret}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status >= 400) throw new Error(`coordinator returned ${response.status} for ${method} ${path}`);
    return response;
  }

  async register(hostname: string, cpuCores: number, memoryMB: number): Promise<Worker> {
    const response = await this.request('/workers/register', 'POST', {
      hostname, cpu_cores: cpuCores, memory_mb: memoryMB,
    });
    return response.json() as Promise<Worker>;
  }

  async heartbeat(workerID: string, currentLoad: number): Promise<void> {
    await this.request('/workers/heartbeat', 'POST', {
      worker_id: workerID, current_load: currentLoad,
    });
  }

  async pollJob(workerID: string): Promise<Job | null> {
    const response = await this.request(`/jobs/next?worker_id=${encodeURIComponent(workerID)}`, 'GET');
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
