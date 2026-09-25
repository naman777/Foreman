import { createHash, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { pathToFileURL } from 'node:url';
import { createPool, PostgresJobStore, PostgresWorkerStore } from './store.js';
import { createClient } from 'redis';
import { RedisJobLocker } from './locker.js';
import { Monitor, startMonitor } from './monitor.js';
import { PostgresMonitorStore } from './monitor-store.js';
import { Scheduler, startScheduler } from './scheduler.js';
import { PostgresSchedulerStore } from './scheduler-store.js';
import WebSocket, { WebSocketServer } from 'ws';
import { createArtifactStore } from './artifacts.js';

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

export interface WorkerStore {
  registerWorker(input: {
    hostname: string; cpuCores: number; memoryMB: number;
    labels: Record<string, unknown>; tokenHash: string;
  }): Promise<Worker>;
  updateHeartbeat(workerID: string, currentLoad: number): Promise<boolean>;
  listWorkers(): Promise<Worker[]>;
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

export interface JobStore {
  createJob(input: {
    name: string | null; imageName: string; command: string; requiredCPU: number;
    requiredMemory: number; maxRetries: number; timeoutSeconds: number; priority: number;
  }): Promise<Job>;
  createJobEvent(jobID: string, type: string, metadata: Record<string, unknown>): Promise<void>;
  listJobs(filters: { status: string; workerID: string | null; limit: number; offset: number }): Promise<Job[]>;
  getJob(id: string): Promise<Job | null>;
  getJobEvents(id: string): Promise<unknown[]>;
  getNextJob(workerID: string): Promise<Job | null>;
  updateJobStatus(input: {
    jobID: string; status: string; workerID: string | null;
    logsPath: string | null; artifactPath: string | null;
  }): Promise<Job | null>;
  getMetricsSummary(): Promise<Record<string, number>>;
}

export interface ArtifactStore {
  getPresignedURL(objectKey: string): Promise<string>;
}

type Event = { type: string; payload: unknown };
type Options = {
  secret: string;
  workers?: WorkerStore;
  jobs?: JobStore;
  artifacts?: ArtifactStore;
  broadcast?: (event: Event) => void;
  now?: () => number;
};

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
}

function error(response: ServerResponse, status: number, message: string): void {
  json(response, status, { error: message });
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = '';
  for await (const chunk of request) {
    raw += chunk;
    if (raw.length > 1024 * 1024) throw new Error('body too large');
  }
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid body');
  return value as Record<string, unknown>;
}

function bearer(request: IncomingMessage): string {
  const authorization = request.headers.authorization ?? '';
  return authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
}

function isUUID(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export function createCoordinatorServer({ secret, workers, jobs, artifacts, broadcast = () => {}, now = Date.now }: Options) {
  if (!secret) throw new Error('COORDINATOR_SECRET is required');
  const sessions = new Map<string, number>();
  const wss = new WebSocketServer({ noServer: true });
  const emit = (event: Event): void => {
    broadcast(event);
    const message = JSON.stringify(event);
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(message);
    }
  };

  const server = createServer(async (request, response) => {
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (request.method === 'OPTIONS') {
      response.writeHead(204);
      response.end();
      return;
    }

    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (request.method === 'GET' && path === '/health') {
      json(response, 200, { status: 'ok' });
      return;
    }
    if (request.method === 'POST' && path === '/auth/login') {
      let body: Record<string, unknown>;
      try { body = await readJson(request); }
      catch { error(response, 400, 'invalid request body'); return; }
      if (body.api_key !== secret) { error(response, 401, 'invalid api_key'); return; }
      const token = randomUUID();
      sessions.set(token, now() + 24 * 60 * 60 * 1000);
      json(response, 200, { token });
      return;
    }

    const jobDetail = /^\/jobs\/([^/]+)$/.exec(path);
    const jobArtifacts = /^\/jobs\/([^/]+)\/artifacts$/.exec(path);
    const jobStatus = /^\/jobs\/([^/]+)\/status$/.exec(path);
    const nextJob = request.method === 'GET' && path === '/jobs/next';
    const workerRoute = (request.method === 'POST' && (path === '/workers/register' || path === '/workers/heartbeat' || jobStatus !== null)) || nextJob;
    const dashboardRoute = (request.method === 'GET' && path === '/workers') ||
      (request.method === 'GET' && path === '/metrics/summary') ||
      ((request.method === 'GET' || request.method === 'POST') && path === '/jobs') ||
      (request.method === 'GET' && ((jobDetail !== null && !nextJob) || jobArtifacts !== null));
    if (!workerRoute && !dashboardRoute) { error(response, 404, 'not found'); return; }
    if (workerRoute && bearer(request) !== secret) {
      error(response, 401, 'invalid or missing bearer token'); return;
    }
    if (dashboardRoute && (sessions.get(bearer(request)) ?? 0) <= now()) {
      error(response, 401, 'invalid or missing session token'); return;
    }
    if (path === '/metrics/summary') {
      if (!jobs) { error(response, 503, 'job store not configured'); return; }
      try { json(response, 200, await jobs.getMetricsSummary()); }
      catch { error(response, 500, 'failed to get metrics'); }
      return;
    }
    if (jobArtifacts) {
      if (!jobs) { error(response, 503, 'job store not configured'); return; }
      const id = jobArtifacts[1];
      if (!isUUID(id)) { error(response, 400, 'invalid job id'); return; }
      let job: Job | null;
      try { job = await jobs.getJob(id); }
      catch { error(response, 500, 'failed to get job'); return; }
      if (!job) { error(response, 404, 'job not found'); return; }
      if (!job.artifact_path) { error(response, 404, 'no artifacts for this job'); return; }
      if (!artifacts) { error(response, 503, 'artifact storage not configured'); return; }
      try {
        json(response, 200, { object_key: job.artifact_path,
          download_url: await artifacts.getPresignedURL(job.artifact_path), expires_in: '1h' });
      } catch { error(response, 500, 'failed to generate download URL'); }
      return;
    }
    if (nextJob || jobStatus) {
      if (!jobs) { error(response, 503, 'job store not configured'); return; }
      if (nextJob) {
        const workerID = new URL(request.url ?? '/', 'http://localhost').searchParams.get('worker_id');
        if (!isUUID(workerID)) { error(response, 400, 'invalid worker_id'); return; }
        try {
          const job = await jobs.getNextJob(workerID);
          if (!job) { response.writeHead(204); response.end(); return; }
          json(response, 200, job);
        } catch { error(response, 500, 'failed to get next job'); }
        return;
      }
      const id = jobStatus?.[1];
      if (!isUUID(id)) { error(response, 400, 'invalid job id'); return; }
      let body: Record<string, unknown>;
      try { body = await readJson(request); }
      catch { error(response, 400, 'invalid request body'); return; }
      const status = body.status;
      if (typeof status !== 'string' || !['scheduled', 'running', 'completed', 'failed', 'timed_out', 'cancelled'].includes(status)) {
        error(response, 400, 'invalid status value'); return;
      }
      if (body.worker_id !== undefined && !isUUID(body.worker_id)) {
        error(response, 400, 'invalid worker_id'); return;
      }
      try {
        const job = await jobs.updateJobStatus({
          jobID: id, status, workerID: typeof body.worker_id === 'string' ? body.worker_id : null,
          logsPath: typeof body.logs_path === 'string' ? body.logs_path : null,
          artifactPath: typeof body.artifact_path === 'string' ? body.artifact_path : null,
        });
        if (!job) { error(response, 404, 'job not found'); return; }
        try { await jobs.createJobEvent(id, 'status_changed', { status }); } catch { /* Go ignores event write failures. */ }
        emit({ type: 'job_updated', payload: job });
        json(response, 200, job);
      } catch { error(response, 500, 'failed to update job status'); }
      return;
    }
    if (path === '/jobs' || (jobDetail && !nextJob)) {
      if (!jobs) { error(response, 503, 'job store not configured'); return; }
      if (request.method === 'POST') {
        let body: Record<string, unknown>;
        try { body = await readJson(request); }
        catch { error(response, 400, 'invalid request body'); return; }
        if (typeof body.image_name !== 'string' || !body.image_name) {
          error(response, 400, 'image_name is required'); return;
        }
        if (typeof body.command !== 'string' || !body.command) {
          error(response, 400, 'command is required'); return;
        }
        const positive = (value: unknown, fallback: number) =>
          typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;
        try {
          const job = await jobs.createJob({
            name: typeof body.name === 'string' ? body.name : null,
            imageName: body.image_name,
            command: body.command,
            requiredCPU: positive(body.required_cpu, 1),
            requiredMemory: positive(body.required_memory, 256),
            maxRetries: typeof body.max_retries === 'number' && Number.isInteger(body.max_retries) ? body.max_retries : 0,
            timeoutSeconds: positive(body.timeout_seconds, 300),
            priority: typeof body.priority === 'number' && Number.isInteger(body.priority) && body.priority >= 1 && body.priority <= 10 ? body.priority : 5,
          });
          try { await jobs.createJobEvent(job.id, 'submitted', {}); } catch { /* Go ignores event write failures. */ }
          json(response, 201, job);
        } catch { error(response, 500, 'failed to create job'); }
        return;
      }
      if (jobDetail) {
        const id = jobDetail[1];
        if (!isUUID(id)) { error(response, 400, 'invalid job id'); return; }
        try {
          const job = await jobs.getJob(id);
          if (!job) { error(response, 404, 'job not found'); return; }
          json(response, 200, { job, events: await jobs.getJobEvents(id) });
        } catch { error(response, 500, 'failed to get job'); }
        return;
      }
      const query = new URL(request.url ?? '/', 'http://localhost').searchParams;
      const workerID = query.get('worker_id');
      if (workerID && !isUUID(workerID)) { error(response, 400, 'invalid worker_id'); return; }
      const limit = Number(query.get('limit') ?? 0);
      const offset = Number(query.get('offset') ?? 0);
      try {
        json(response, 200, await jobs.listJobs({
          status: query.get('status') ?? '', workerID,
          limit: Number.isInteger(limit) && limit > 0 && limit <= 200 ? limit : 50,
          offset: Number.isInteger(offset) ? offset : 0,
        }));
      } catch { error(response, 500, 'failed to list jobs'); }
      return;
    }
    if (!workers) { error(response, 503, 'worker store not configured'); return; }

    if (path === '/workers/register') {
      let body: Record<string, unknown>;
      try { body = await readJson(request); }
      catch { error(response, 400, 'invalid request body'); return; }
      if (typeof body.hostname !== 'string' || !body.hostname) {
        error(response, 400, 'hostname is required'); return;
      }
      const labels = body.labels && typeof body.labels === 'object' && !Array.isArray(body.labels)
        ? body.labels as Record<string, unknown> : {};
      try {
        const worker = await workers.registerWorker({
          hostname: body.hostname,
          cpuCores: typeof body.cpu_cores === 'number' && body.cpu_cores > 0 ? body.cpu_cores : 1,
          memoryMB: typeof body.memory_mb === 'number' && body.memory_mb > 0 ? body.memory_mb : 512,
          labels,
          tokenHash: createHash('sha256').update(bearer(request)).digest('hex'),
        });
        emit({ type: 'worker_registered', payload: worker });
        json(response, 201, worker);
      } catch { error(response, 500, 'failed to register worker'); }
      return;
    }

    if (path === '/workers/heartbeat') {
      let body: Record<string, unknown>;
      try { body = await readJson(request); }
      catch { error(response, 400, 'invalid request body'); return; }
      if (!isUUID(body.worker_id)) { error(response, 400, 'invalid worker_id'); return; }
      try {
        if (!await workers.updateHeartbeat(body.worker_id, typeof body.current_load === 'number' ? body.current_load : 0)) {
          error(response, 404, 'worker not found'); return;
        }
        emit({ type: 'worker_heartbeat', payload: { worker_id: body.worker_id, current_load: body.current_load ?? 0 } });
        json(response, 200, { status: 'ok' });
      } catch { error(response, 500, 'failed to update heartbeat'); }
      return;
    }

    try { json(response, 200, await workers.listWorkers()); }
    catch { error(response, 500, 'failed to list workers'); }
  });
  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.pathname !== '/ws') { socket.destroy(); return; }
    const token = bearer(request) || url.searchParams.get('token') || '';
    if ((sessions.get(token) ?? 0) <= now()) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (client) => {
      wss.emit('connection', client, request);
    });
  });
  server.on('close', () => wss.close());
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const pool = createPool(process.env.DATABASE_URL ?? '');
  const redisURL = process.env.REDIS_URL;
  if (!redisURL) throw new Error('REDIS_URL is required');
  const redis = createClient({ url: redisURL });
  redis.on('error', (error) => console.error('Redis client error', error));
  try {
    await pool.query('SELECT 1');
    await redis.connect();
    await redis.ping();
    const artifacts = await createArtifactStore(process.env);
    const server = createCoordinatorServer({
      secret: process.env.COORDINATOR_SECRET ?? '',
      workers: new PostgresWorkerStore(pool),
      jobs: new PostgresJobStore(pool),
      artifacts,
    });
    const maxParallel = Number(process.env.MAX_PARALLEL_JOBS_PER_WORKER ?? 4);
    const scheduler = new Scheduler(
      new PostgresSchedulerStore(pool), new RedisJobLocker(redis), maxParallel);
    const port = Number(process.env.PORT ?? 8080);
    server.listen(port, () => console.log(`Foreman coordinator listening on ${port}`));
    const stopMonitor = startMonitor(new Monitor(new PostgresMonitorStore(pool)));
    const stopScheduler = startScheduler(scheduler);
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      process.once(signal, () => {
        stopMonitor();
        stopScheduler();
        server.close(() => { void Promise.all([redis.close(), pool.end()]); });
      });
    }
  } catch (error) {
    console.error('coordinator startup failed', error);
    if (redis.isOpen) await redis.close();
    await pool.end();
    process.exitCode = 1;
  }
}
