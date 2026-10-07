import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
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
import { DemoLimiter, demoScenarios, isDemoJob, isDemoScenario } from './demo.js';
import { JobEventListener } from './events.js';
import { log } from './log.js';
import type { ArtifactStore, Job, JobStore, WorkerStore } from './types.js';

export type { ArtifactStore, Job, JobStore, Worker, WorkerStore } from './types.js';

type Event = { type: string; payload: unknown };
type Options = {
  secret: string;
  workers?: WorkerStore;
  jobs?: JobStore;
  artifacts?: ArtifactStore;
  broadcast?: (event: Event) => void;
  now?: () => number;
  publicDemo?: boolean;
  /** Trust X-Forwarded-For for visitor identity; enable only behind a proxy that sets it. */
  trustProxy?: boolean;
  /** When false, job_updated events come only from `publish` (e.g. the NOTIFY listener). */
  emitJobUpdates?: boolean;
  /** Throws when a dependency is down; /health then answers 503. */
  healthCheck?: () => Promise<void>;
};

interface Ctx {
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
  params: string[];
  ip: string;
}
// 'secret' = the bootstrap COORDINATOR_SECRET (registration only); 'worker' = a per-worker
// token issued at registration, checked against the worker named in the request.
type Auth = 'none' | 'secret' | 'worker' | 'dashboard';
interface Route { method: string; pattern: RegExp; auth: Auth; handler: (ctx: Ctx) => Promise<void> }

const maxLogBytes = 256 * 1024;
const maxPollWaitSeconds = 25;
const workerStatuses = ['scheduled', 'running', 'completed', 'failed', 'timed_out', 'cancelled'];

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

const digest = (value: string): Buffer => createHash('sha256').update(value).digest();
const sha256hex = (value: string): string => createHash('sha256').update(value).digest('hex');
const sameSecret = (given: string, secret: string): boolean =>
  timingSafeEqual(digest(given), digest(secret));

function isUUID(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

// Visitors may learn that logs exist (an object key) but never worker-local paths or worker IDs.
const publicJob = (job: Job): Job => ({ ...job, worker_id: null,
  logs_path: job.logs_path?.startsWith('logs/') ? job.logs_path : null });
const isDemo = (job: Job): boolean => job.is_demo === true || isDemoJob(job);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function parseSelector(value: unknown): Record<string, string | number | boolean> | null {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out: Record<string, string | number | boolean> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string' && typeof entry !== 'number' && typeof entry !== 'boolean') return null;
    out[key] = entry;
  }
  return out;
}

export function createCoordinatorServer({
  secret, workers, jobs, artifacts, broadcast = () => {}, now = Date.now, publicDemo = false,
  trustProxy = false, emitJobUpdates = true, healthCheck,
}: Options) {
  if (!secret) throw new Error('COORDINATOR_SECRET is required');
  const sessions = new Map<string, number>();
  const loginAttempts = new Map<string, number[]>();
  const demoLimiter = new DemoLimiter(now);
  const wss = new WebSocketServer({ noServer: true });
  const demoWss = new WebSocketServer({ noServer: true });
  const httpCounts = new Map<number, number>();

  const emit = (event: Event): void => {
    broadcast(event);
    const message = JSON.stringify(event);
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(message);
    }
    if (event.type === 'job_updated' && event.payload &&
        typeof event.payload === 'object' && isDemo(event.payload as Job)) {
      const demoMessage = JSON.stringify({ type: event.type, payload: publicJob(event.payload as Job) });
      for (const client of demoWss.clients) {
        if (client.readyState === WebSocket.OPEN) client.send(demoMessage);
      }
    }
  };
  const emitJob = (job: Job): void => { if (emitJobUpdates) emit({ type: 'job_updated', payload: job }); };

  const guard = async (ctx: Ctx, message: string, work: () => Promise<void>): Promise<void> => {
    try { await work(); }
    catch (cause) { log.error(message, { error: cause, path: ctx.url.pathname }); error(ctx.response, 500, message); }
  };
  const body = async (ctx: Ctx): Promise<Record<string, unknown> | null> => {
    try { return await readJson(ctx.request); }
    catch { error(ctx.response, 400, 'invalid request body'); return null; }
  };
  const needJobs = (ctx: Ctx): JobStore | null => {
    if (!jobs) error(ctx.response, 503, 'job store not configured');
    return jobs ?? null;
  };
  const needWorkers = (ctx: Ctx): WorkerStore | null => {
    if (!workers) error(ctx.response, 503, 'worker store not configured');
    return workers ?? null;
  };
  /** Accepts the request only if its bearer token is the one issued to `workerID`. */
  const authWorker = async (ctx: Ctx, workerID: string): Promise<boolean> => {
    if (!workers?.verifyToken) { error(ctx.response, 503, 'worker store not configured'); return false; }
    let valid = false;
    try { valid = await workers.verifyToken(workerID, sha256hex(bearer(ctx.request))); }
    catch (cause) {
      log.error('worker token check failed', { error: cause });
      error(ctx.response, 500, 'failed to verify worker'); return false;
    }
    if (!valid) error(ctx.response, 401, 'invalid worker token');
    return valid;
  };
  /** Loads the job named in the URL, answering 400/404 itself; demo routes hide non-demo jobs. */
  const loadJob = async (ctx: Ctx, store: JobStore, demo: boolean): Promise<Job | null> => {
    const id = ctx.params[0];
    if (!isUUID(id)) { error(ctx.response, 400, 'invalid job id'); return null; }
    const job = await store.getJob(id);
    if (!job || (demo && !isDemo(job))) {
      error(ctx.response, 404, demo ? 'demo job not found' : 'job not found');
      return null;
    }
    return job;
  };

  const summarize = (visible: Job[]): Record<string, number> => {
    const summary: Record<string, number> = {
      queued: 0, scheduled: 0, running: 0, completed: 0, failed: 0,
      timed_out: 0, cancelled: 0, total: visible.length,
    };
    for (const job of visible) {
      if (Object.hasOwn(summary, job.status)) summary[job.status] = (summary[job.status] ?? 0) + 1;
    }
    return summary;
  };

  const artifactLink = (demo: boolean) => async (ctx: Ctx): Promise<void> => {
    const store = needJobs(ctx); if (!store) return;
    await guard(ctx, demo ? 'failed to get demo job' : 'failed to get job', async () => {
      const job = await loadJob(ctx, store, demo); if (!job) return;
      if (!job.artifact_path) { error(ctx.response, 404, 'no artifacts for this job'); return; }
      if (!artifacts) { error(ctx.response, 503, 'artifact storage not configured'); return; }
      json(ctx.response, 200, { object_key: job.artifact_path,
        download_url: await artifacts.getPresignedURL(job.artifact_path), expires_in: '1h' });
    });
  };

  const jobLogs = (demo: boolean) => async (ctx: Ctx): Promise<void> => {
    const store = needJobs(ctx); if (!store) return;
    await guard(ctx, 'failed to read logs', async () => {
      const job = await loadJob(ctx, store, demo); if (!job) return;
      // Only keys the worker uploaded to object storage are readable; local paths stay private.
      if (!job.logs_path?.startsWith('logs/')) { error(ctx.response, 404, 'no logs for this job'); return; }
      if (!artifacts?.getText) { error(ctx.response, 503, 'log storage not configured'); return; }
      const text = await artifacts.getText(job.logs_path, maxLogBytes);
      ctx.response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      ctx.response.end(text);
    });
  };

  const jobDetail = (demo: boolean) => async (ctx: Ctx): Promise<void> => {
    const store = needJobs(ctx); if (!store) return;
    await guard(ctx, demo ? 'failed to get demo job' : 'failed to get job', async () => {
      const job = await loadJob(ctx, store, demo); if (!job) return;
      json(ctx.response, 200, { job: demo ? publicJob(job) : job, events: await store.getJobEvents(job.id) });
    });
  };

  const cancelJob = (demo: boolean) => async (ctx: Ctx): Promise<void> => {
    const store = needJobs(ctx); if (!store) return;
    await guard(ctx, 'failed to cancel job', async () => {
      const job = await loadJob(ctx, store, demo); if (!job) return;
      if (!store.cancelJob) { error(ctx.response, 503, 'cancellation not supported'); return; }
      const result = await store.cancelJob(job.id);
      if (!result) { error(ctx.response, 404, 'job not found'); return; }
      if (result.state === 'finished') { error(ctx.response, 409, 'job already finished'); return; }
      try {
        await store.createJobEvent(job.id,
          result.state === 'cancelled' ? 'cancelled' : 'cancel_requested', {});
      } catch { /* The cancellation itself already took effect. */ }
      emitJob(result.job);
      json(ctx.response, 202, demo ? publicJob(result.job) : result.job);
    });
  };

  const demoJobs = async (ctx: Ctx): Promise<void> => {
    const store = needJobs(ctx); if (!store) return;
    await guard(ctx, 'failed to list demo jobs', async () => {
      const all = await store.listJobs({ status: '', workerID: null, limit: 200, offset: 0, demo: true });
      const visible = all.filter(isDemo).map(publicJob);
      json(ctx.response, 200, ctx.url.pathname === '/demo/jobs' ? visible : summarize(visible));
    });
  };

  const submitDemo = async (ctx: Ctx): Promise<void> => {
    const store = needJobs(ctx); if (!store) return;
    const input = await body(ctx); if (!input) return;
    if (!isDemoScenario(input.scenario) || Object.keys(input).some((key) => key !== 'scenario')) {
      error(ctx.response, 400, 'choose a supported demo scenario'); return;
    }
    const scenarioName = input.scenario;
    await guard(ctx, 'failed to create demo job', async () => {
      const summary = await store.getMetricsSummary();
      if ((summary.queued ?? 0) + (summary.scheduled ?? 0) + (summary.running ?? 0) >= 6) {
        error(ctx.response, 429, 'demo capacity reached; try again shortly'); return;
      }
      if (!demoLimiter.allow(ctx.ip)) {
        error(ctx.response, 429, 'demo rate limit reached; try again later'); return;
      }
      const scenario = demoScenarios[scenarioName];
      const job = await store.createJob({
        name: scenario.name, imageName: 'alpine:3.20', command: scenario.command,
        requiredCPU: 1, requiredMemory: 128, maxRetries: scenario.maxRetries,
        timeoutSeconds: scenario.timeoutSeconds, priority: scenario.priority, isDemo: true,
      });
      try { await store.createJobEvent(job.id, 'submitted', { demo: true, scenario: scenarioName }); }
      catch { /* The job remains visible if the event write fails. */ }
      emitJob(job);
      json(ctx.response, 201, publicJob(job));
    });
  };

  const login = async (ctx: Ctx): Promise<void> => {
    const current = now();
    const recent = (loginAttempts.get(ctx.ip) ?? []).filter((time) => current - time < 60_000);
    if (recent.length >= 10) { error(ctx.response, 429, 'too many login attempts'); return; }
    loginAttempts.set(ctx.ip, [...recent, current]);
    for (const [key, times] of loginAttempts) {
      if (times.every((time) => current - time >= 60_000)) loginAttempts.delete(key);
    }
    const input = await body(ctx); if (!input) return;
    if (typeof input.api_key !== 'string' || !sameSecret(input.api_key, secret)) {
      error(ctx.response, 401, 'invalid api_key'); return;
    }
    for (const [token, expires] of sessions) if (expires <= current) sessions.delete(token);
    const token = randomUUID();
    sessions.set(token, current + 24 * 60 * 60 * 1000);
    json(ctx.response, 200, { token });
  };

  const metrics = async (ctx: Ctx): Promise<void> => {
    const lines = ['# TYPE foreman_up gauge', 'foreman_up 1'];
    await guard(ctx, 'failed to collect metrics', async () => {
      if (jobs) {
        const summary = await jobs.getMetricsSummary();
        lines.push('# TYPE foreman_jobs gauge');
        for (const [status, count] of Object.entries(summary)) {
          if (status !== 'total') lines.push(`foreman_jobs{status="${status}"} ${count}`);
        }
      }
      if (workers) {
        const counts = new Map<string, number>();
        for (const worker of await workers.listWorkers()) {
          counts.set(worker.status, (counts.get(worker.status) ?? 0) + 1);
        }
        lines.push('# TYPE foreman_workers gauge');
        for (const [status, count] of counts) lines.push(`foreman_workers{status="${status}"} ${count}`);
      }
      lines.push('# TYPE foreman_http_responses_total counter');
      for (const [code, count] of httpCounts) lines.push(`foreman_http_responses_total{code="${code}"} ${count}`);
      ctx.response.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
      ctx.response.end(`${lines.join('\n')}\n`);
    });
  };

  const registerWorker = async (ctx: Ctx): Promise<void> => {
    const store = needWorkers(ctx); if (!store) return;
    const input = await body(ctx); if (!input) return;
    if (typeof input.hostname !== 'string' || !input.hostname) {
      error(ctx.response, 400, 'hostname is required'); return;
    }
    if (input.worker_id !== undefined && !isUUID(input.worker_id)) {
      error(ctx.response, 400, 'invalid worker_id'); return;
    }
    const labels = input.labels && typeof input.labels === 'object' && !Array.isArray(input.labels)
      ? input.labels as Record<string, unknown> : {};
    const hostname = input.hostname;
    await guard(ctx, 'failed to register worker', async () => {
      // Registration is the only call that takes the shared secret. It mints a credential
      // for this worker alone; re-registering rotates it and locks out the previous holder.
      const token = randomBytes(32).toString('hex');
      const worker = await store.registerWorker({
        workerID: typeof input.worker_id === 'string' ? input.worker_id : null,
        hostname,
        cpuCores: typeof input.cpu_cores === 'number' && input.cpu_cores > 0 ? input.cpu_cores : 1,
        memoryMB: typeof input.memory_mb === 'number' && input.memory_mb > 0 ? input.memory_mb : 512,
        labels,
        tokenHash: sha256hex(token),
      });
      emit({ type: 'worker_registered', payload: worker });
      json(ctx.response, 201, { ...worker, token });
    });
  };

  const heartbeat = async (ctx: Ctx): Promise<void> => {
    const store = needWorkers(ctx); if (!store) return;
    const input = await body(ctx); if (!input) return;
    const workerID = input.worker_id;
    if (!isUUID(workerID)) { error(ctx.response, 400, 'invalid worker_id'); return; }
    if (!await authWorker(ctx, workerID)) return;
    await guard(ctx, 'failed to update heartbeat', async () => {
      const load = typeof input.current_load === 'number' ? input.current_load : 0;
      if (!await store.updateHeartbeat(workerID, load)) { error(ctx.response, 404, 'worker not found'); return; }
      emit({ type: 'worker_heartbeat', payload: { worker_id: workerID, current_load: input.current_load ?? 0 } });
      // Heartbeats double as the channel that tells a worker which running jobs to stop.
      const cancelJobs = await jobs?.getCancelRequests?.(workerID) ?? [];
      json(ctx.response, 200, { status: 'ok', cancel_jobs: cancelJobs });
    });
  };

  const nextJob = async (ctx: Ctx): Promise<void> => {
    const store = needJobs(ctx); if (!store) return;
    const workerID = ctx.url.searchParams.get('worker_id');
    if (!isUUID(workerID)) { error(ctx.response, 400, 'invalid worker_id'); return; }
    if (!await authWorker(ctx, workerID)) return;
    const requested = Number(ctx.url.searchParams.get('wait') ?? 0);
    const waitMs = Number.isFinite(requested) ? Math.min(Math.max(requested, 0), maxPollWaitSeconds) * 1000 : 0;
    let closed = false;
    ctx.response.on('close', () => { closed = true; });
    await guard(ctx, 'failed to get next job', async () => {
      // Long poll: hold the request open so a freshly scheduled job starts within ~0.5s.
      const deadline = Date.now() + waitMs;
      for (;;) {
        const job = await store.getNextJob(workerID);
        if (job) { json(ctx.response, 200, job); return; }
        if (closed || Date.now() + 500 > deadline) break;
        await sleep(500);
      }
      if (!closed) { ctx.response.writeHead(204); ctx.response.end(); }
    });
  };

  const updateStatus = async (ctx: Ctx): Promise<void> => {
    const store = needJobs(ctx); if (!store) return;
    const id = ctx.params[0];
    if (!isUUID(id)) { error(ctx.response, 400, 'invalid job id'); return; }
    const input = await body(ctx); if (!input) return;
    const status = input.status;
    if (typeof status !== 'string' || !workerStatuses.includes(status)) {
      error(ctx.response, 400, 'invalid status value'); return;
    }
    const reporter = input.worker_id;
    if (!isUUID(reporter)) { error(ctx.response, 400, 'invalid worker_id'); return; }
    if (!await authWorker(ctx, reporter)) return;
    await guard(ctx, 'failed to update job status', async () => {
      const job = await store.updateJobStatus({
        jobID: id, status, workerID: reporter,
        logsPath: typeof input.logs_path === 'string' ? input.logs_path : null,
        artifactPath: typeof input.artifact_path === 'string' ? input.artifact_path : null,
      });
      if (!job) { error(ctx.response, 404, 'job not found'); return; }
      try { await store.createJobEvent(id, 'status_changed', { status: job.status }); } catch { /* Event writes are best effort. */ }
      emitJob(job);
      json(ctx.response, 200, job);
    });
  };

  const submitJob = async (ctx: Ctx): Promise<void> => {
    const store = needJobs(ctx); if (!store) return;
    const input = await body(ctx); if (!input) return;
    if (typeof input.image_name !== 'string' || !input.image_name) {
      error(ctx.response, 400, 'image_name is required'); return;
    }
    if (typeof input.command !== 'string' || !input.command) {
      error(ctx.response, 400, 'command is required'); return;
    }
    const selector = parseSelector(input.selector);
    if (!selector) { error(ctx.response, 400, 'selector must map label names to scalar values'); return; }
    const imageName = input.image_name;
    const command = input.command;
    const positive = (value: unknown, fallback: number) =>
      typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;
    await guard(ctx, 'failed to create job', async () => {
      const job = await store.createJob({
        name: typeof input.name === 'string' ? input.name : null,
        imageName, command, selector,
        requiredCPU: positive(input.required_cpu, 1),
        requiredMemory: positive(input.required_memory, 256),
        maxRetries: typeof input.max_retries === 'number' && Number.isInteger(input.max_retries) ? input.max_retries : 0,
        timeoutSeconds: positive(input.timeout_seconds, 300),
        priority: typeof input.priority === 'number' && Number.isInteger(input.priority) && input.priority >= 1 && input.priority <= 10 ? input.priority : 5,
      });
      try { await store.createJobEvent(job.id, 'submitted', {}); } catch { /* Event writes are best effort. */ }
      json(ctx.response, 201, job);
    });
  };

  const listJobs = async (ctx: Ctx): Promise<void> => {
    const store = needJobs(ctx); if (!store) return;
    const workerID = ctx.url.searchParams.get('worker_id');
    if (workerID && !isUUID(workerID)) { error(ctx.response, 400, 'invalid worker_id'); return; }
    const limit = Number(ctx.url.searchParams.get('limit') ?? 0);
    const offset = Number(ctx.url.searchParams.get('offset') ?? 0);
    await guard(ctx, 'failed to list jobs', async () => {
      json(ctx.response, 200, await store.listJobs({
        status: ctx.url.searchParams.get('status') ?? '', workerID,
        limit: Number.isInteger(limit) && limit > 0 && limit <= 200 ? limit : 50,
        offset: Number.isInteger(offset) ? offset : 0,
      }));
    });
  };

  const summary = async (ctx: Ctx): Promise<void> => {
    const store = needJobs(ctx); if (!store) return;
    await guard(ctx, 'failed to get metrics', async () => json(ctx.response, 200, await store.getMetricsSummary()));
  };

  const demoWorkers = async (ctx: Ctx): Promise<void> => {
    const store = needWorkers(ctx); if (!store) return;
    await guard(ctx, 'failed to list demo workers', async () => {
      const all = await store.listWorkers();
      json(ctx.response, 200, all.map((worker, index) => ({
        id: `demo-worker-${index + 1}`, hostname: `Worker ${index + 1}`,
        status: worker.status, last_heartbeat: worker.last_heartbeat,
        cpu_cores: worker.cpu_cores, memory_mb: worker.memory_mb,
        current_load: worker.current_load, registered_at: worker.registered_at,
      })));
    });
  };

  const adminWorkers = async (ctx: Ctx): Promise<void> => {
    const store = needWorkers(ctx); if (!store) return;
    await guard(ctx, 'failed to list workers', async () => json(ctx.response, 200, await store.listWorkers()));
  };

  const health = async (ctx: Ctx): Promise<void> => {
    try { await healthCheck?.(); json(ctx.response, 200, { status: 'ok' }); }
    catch (cause) {
      log.error('health check failed', { error: cause });
      error(ctx.response, 503, 'dependency unavailable');
    }
  };

  const U = '([^/]+)';
  const route = (method: string, path: string, auth: Auth, handler: Route['handler']): Route =>
    ({ method, pattern: new RegExp(`^${path}$`), auth, handler });
  const routes: Route[] = [
    route('GET', '/health', 'none', health),
    route('GET', '/metrics', 'none', metrics),
    route('POST', '/auth/login', 'none', login),
    route('POST', '/workers/register', 'secret', registerWorker),
    route('POST', '/workers/heartbeat', 'worker', heartbeat),
    route('GET', '/jobs/next', 'worker', nextJob),
    route('POST', `/jobs/${U}/status`, 'worker', updateStatus),
    route('GET', '/workers', 'dashboard', adminWorkers),
    route('GET', '/metrics/summary', 'dashboard', summary),
    route('GET', '/jobs', 'dashboard', listJobs),
    route('POST', '/jobs', 'dashboard', submitJob),
    route('GET', `/jobs/${U}`, 'dashboard', jobDetail(false)),
    route('GET', `/jobs/${U}/artifacts`, 'dashboard', artifactLink(false)),
    route('GET', `/jobs/${U}/logs`, 'dashboard', jobLogs(false)),
    route('POST', `/jobs/${U}/cancel`, 'dashboard', cancelJob(false)),
  ];
  if (publicDemo) {
    routes.push(
      route('GET', '/demo/workers', 'none', demoWorkers),
      route('GET', '/demo/jobs', 'none', demoJobs),
      route('GET', '/demo/metrics/summary', 'none', demoJobs),
      route('POST', '/demo/jobs', 'none', submitDemo),
      route('GET', `/demo/jobs/${U}`, 'none', jobDetail(true)),
      route('GET', `/demo/jobs/${U}/artifacts`, 'none', artifactLink(true)),
      route('GET', `/demo/jobs/${U}/logs`, 'none', jobLogs(true)),
      route('POST', `/demo/jobs/${U}/cancel`, 'none', cancelJob(true)),
    );
  }

  const clientIP = (request: IncomingMessage): string => {
    const forwarded = trustProxy ? String(request.headers['x-forwarded-for'] ?? '').split(',')[0]?.trim() : '';
    return forwarded || request.socket.remoteAddress || 'unknown';
  };

  const server = createServer(async (request, response) => {
    response.on('finish', () => httpCounts.set(response.statusCode, (httpCounts.get(response.statusCode) ?? 0) + 1));
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (request.method === 'OPTIONS') {
      response.writeHead(204);
      response.end();
      return;
    }

    const url = new URL(request.url ?? '/', 'http://localhost');
    for (const candidate of routes) {
      if (candidate.method !== request.method) continue;
      const match = candidate.pattern.exec(url.pathname);
      if (!match) continue;
      if (candidate.auth === 'secret' && !sameSecret(bearer(request), secret)) {
        error(response, 401, 'invalid or missing bearer token'); return;
      }
      if (candidate.auth === 'worker' && !bearer(request)) {
        error(response, 401, 'invalid or missing bearer token'); return;
      }
      if (candidate.auth === 'dashboard' && (sessions.get(bearer(request)) ?? 0) <= now()) {
        error(response, 401, 'invalid or missing session token'); return;
      }
      try {
        await candidate.handler({ request, response, url, params: match.slice(1), ip: clientIP(request) });
      } catch (cause) {
        log.error('unhandled request error', { error: cause, path: url.pathname });
        if (!response.headersSent) error(response, 500, 'internal error');
      }
      return;
    }
    error(response, 404, 'not found');
  });

  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (publicDemo && url.pathname === '/demo/ws') {
      demoWss.handleUpgrade(request, socket, head, (client) => {
        demoWss.emit('connection', client, request);
      });
      return;
    }
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
  server.on('close', () => { wss.close(); demoWss.close(); });
  return Object.assign(server, { publish: emit });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const databaseURL = process.env.DATABASE_URL ?? '';
  const pool = createPool(databaseURL);
  const redisURL = process.env.REDIS_URL;
  if (!redisURL) throw new Error('REDIS_URL is required');
  const redis = createClient({ url: redisURL });
  redis.on('error', (error) => log.error('Redis client error', { error }));
  try {
    await pool.query('SELECT 1');
    await redis.connect();
    await redis.ping();
    const artifacts = await createArtifactStore(process.env);
    const jobStore = new PostgresJobStore(pool);
    const server = createCoordinatorServer({
      secret: process.env.COORDINATOR_SECRET ?? '',
      publicDemo: process.env.PUBLIC_DEMO_ENABLED === 'true',
      trustProxy: process.env.TRUST_PROXY === 'true',
      workers: new PostgresWorkerStore(pool),
      jobs: jobStore,
      artifacts,
      emitJobUpdates: false,
      healthCheck: async () => { await pool.query('SELECT 1'); await redis.ping(); },
    });
    const maxParallel = Number(process.env.MAX_PARALLEL_JOBS_PER_WORKER ?? 4);
    const scheduler = startScheduler(new Scheduler(
      new PostgresSchedulerStore(pool), new RedisJobLocker(redis), maxParallel));
    const listener = new JobEventListener(databaseURL, (id) => jobStore.getJob(id), (job) => {
      server.publish({ type: 'job_updated', payload: job });
      if (job.status === 'queued') scheduler.kick();
    });
    await listener.start();
    const port = Number(process.env.PORT ?? 8080);
    server.listen(port, () => log.info('Foreman coordinator listening', { port }));
    const stopMonitor = startMonitor(new Monitor(new PostgresMonitorStore(pool), {
      retentionDays: Number(process.env.RETENTION_DAYS ?? 30),
    }));
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      process.once(signal, () => {
        stopMonitor();
        scheduler.stop();
        void listener.stop();
        server.close(() => { void Promise.all([redis.close(), pool.end()]); });
        server.closeAllConnections();
      });
    }
  } catch (error) {
    log.error('coordinator startup failed', { error });
    if (redis.isOpen) await redis.close();
    await pool.end();
    process.exitCode = 1;
  }
}
