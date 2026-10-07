import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCoordinatorServer } from '../dist/server.js';
import { DemoLimiter } from '../dist/demo.js';
import { Monitor } from '../dist/monitor.js';
import { PostgresMonitorStore } from '../dist/monitor-store.js';
import { PostgresJobStore } from '../dist/store.js';
import { PostgresSchedulerStore } from '../dist/scheduler-store.js';
import { selectWorker, startScheduler } from '../dist/scheduler.js';

import { createHash } from 'node:crypto';
const id = '123e4567-e89b-42d3-a456-426614174000';
const credential = { async verifyToken(workerID, hash) {
  return workerID === id && hash === createHash('sha256').update('worker-token').digest('hex'); } };
const job = { id, name: null, status: 'queued', image_name: 'alpine', command: 'true' };

async function withServer(options, run) {
  const server = createCoordinatorServer({ secret: 'secret', ...options });
  await new Promise((resolve) => server.listen(0, resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try { await run(origin); } finally { await new Promise((resolve) => server.close(resolve)); }
}
const login = async (origin) => (await (await fetch(`${origin}/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ api_key: 'secret' }) })).json()).token;

test('job selector must map names to scalars', async () => {
  const created = [];
  const jobs = { async createJob(input) { created.push(input); return job; }, async createJobEvent() {} };
  await withServer({ jobs }, async (origin) => {
    const headers = { Authorization: `Bearer ${await login(origin)}`, 'Content-Type': 'application/json' };
    const submit = (selector) => fetch(`${origin}/jobs`, { method: 'POST', headers,
      body: JSON.stringify({ image_name: 'alpine', command: 'true', selector }) });
    assert.equal((await submit({ gpu: { nested: true } })).status, 400);
    assert.equal((await submit('gpu')).status, 400);
    assert.equal((await submit({ gpu: 'true', region: 'eu' })).status, 201);
    assert.deepEqual(created.at(-1).selector, { gpu: 'true', region: 'eu' });
  });
});

test('cancel route reports queued, running and finished jobs', async () => {
  const outcomes = [{ job: { ...job, status: 'cancelled' }, state: 'cancelled' },
    { job: { ...job, status: 'running' }, state: 'requested' }, { job, state: 'finished' }, null];
  const events = [];
  const jobs = {
    async getJob(jobID) { return jobID === id ? job : null; },
    async cancelJob() { return outcomes.shift() ?? null; },
    async createJobEvent(...args) { events.push(args); },
  };
  await withServer({ jobs }, async (origin) => {
    const headers = { Authorization: `Bearer ${await login(origin)}` };
    const cancel = (target = id, auth = headers) =>
      fetch(`${origin}/jobs/${target}/cancel`, { method: 'POST', headers: auth });
    assert.equal((await cancel(id, {})).status, 401);
    assert.equal((await cancel()).status, 202);
    assert.equal(events.at(-1)[1], 'cancelled');
    assert.equal((await cancel()).status, 202);
    assert.equal(events.at(-1)[1], 'cancel_requested');
    assert.equal((await cancel()).status, 409);
    assert.equal((await cancel()).status, 404);
    assert.equal((await cancel('not-a-uuid')).status, 400);
  });
});

test('cancelJob locks the row and releases a scheduled worker slot', async () => {
  const statements = [];
  const client = {
    async query(sql, values) {
      statements.push({ sql, values });
      if (sql.includes('FOR UPDATE')) return { rows: [{ status: 'scheduled', worker_id: id }] };
      return { rows: [{ ...job, status: 'cancelled' }] };
    },
    release() {},
  };
  const result = await new PostgresJobStore({ async connect() { return client; } }).cancelJob(id);
  assert.equal(result.state, 'cancelled');
  assert.match(statements[1].sql, /SELECT status, worker_id FROM jobs WHERE id = \$1 FOR UPDATE/);
  assert.match(statements[2].sql, /status = 'cancelled'/);
  assert.match(statements[3].sql, /current_load = GREATEST\(0, current_load - 1\)/);
  assert.equal(statements.at(-1).sql, 'COMMIT');
});

test('long polling returns a job that appears while waiting', async () => {
  let attempts = 0;
  const jobs = { async getNextJob() { return ++attempts >= 2 ? job : null; } };
  await withServer({ jobs, workers: credential }, async (origin) => {
    const response = await fetch(`${origin}/jobs/next?worker_id=${id}&wait=5`, {
      headers: { Authorization: 'Bearer worker-token' } });
    assert.equal(response.status, 200);
    assert.equal(attempts, 2);
  });
});

test('long polling answers 204 when nothing arrives', async () => {
  await withServer({ jobs: { async getNextJob() { return null; } }, workers: credential }, async (origin) => {
    const response = await fetch(`${origin}/jobs/next?worker_id=${id}&wait=1`, {
      headers: { Authorization: 'Bearer worker-token' } });
    assert.equal(response.status, 204);
  });
});

test('health reflects dependency checks and metrics use Prometheus format', async () => {
  let healthy = true;
  const jobs = { async getMetricsSummary() { return { queued: 2, total: 2 }; } };
  await withServer({ jobs, healthCheck: async () => { if (!healthy) throw new Error('db down'); } },
    async (origin) => {
      assert.equal((await fetch(`${origin}/health`)).status, 200);
      healthy = false;
      assert.equal((await fetch(`${origin}/health`)).status, 503);
      const text = await (await fetch(`${origin}/metrics`)).text();
      assert.match(text, /foreman_up 1/);
      assert.match(text, /foreman_jobs\{status="queued"\} 2/);
      assert.match(text, /foreman_http_responses_total\{code="503"\} 1/);
    });
});

test('login is rate limited per client', async () => {
  await withServer({ now: () => 5000 }, async (origin) => {
    const attempt = (key) => fetch(`${origin}/auth/login`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ api_key: key }) });
    for (let i = 0; i < 10; i += 1) assert.equal((await attempt('wrong')).status, 401);
    assert.equal((await attempt('secret')).status, 429);
  });
});

test('registration reuses a saved worker ID and rejects malformed ones', async () => {
  const registered = [];
  const workers = { async registerWorker(input) { registered.push(input); return { id, hostname: 'w' }; } };
  await withServer({ workers }, async (origin) => {
    const register = (body) => fetch(`${origin}/workers/register`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer secret' },
      body: JSON.stringify(body) });
    assert.equal((await register({ hostname: 'w', worker_id: 'nope' })).status, 400);
    assert.equal((await register({ hostname: 'w', worker_id: id, labels: { region: 'eu' },
      cpu_cores: 4, memory_mb: 2048 })).status, 201);
    assert.equal(registered[0].workerID, id);
    assert.deepEqual(registered[0].labels, { region: 'eu' });
    assert.equal(registered[0].cpuCores, 4);
  });
});

test('heartbeat response lists jobs the worker must cancel', async () => {
  const workers = { ...credential, async updateHeartbeat() { return true; } };
  const jobs = { async getCancelRequests(workerID) { return workerID === id ? ['job-9'] : []; } };
  await withServer({ workers, jobs }, async (origin) => {
    const response = await fetch(`${origin}/workers/heartbeat`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer worker-token' },
      body: JSON.stringify({ worker_id: id, current_load: 1 }) });
    assert.deepEqual(await response.json(), { status: 'ok', cancel_jobs: ['job-9'] });
  });
});

test('job selector only matches workers carrying every label', () => {
  const worker = (name, load, labels) => ({ id: name, status: 'online', cpu_cores: 2, memory_mb: 1024,
    current_load: load, used_cpu: 0, used_memory: 0, labels });
  const eu = worker('eu', 0, { region: 'eu' });
  const gpu = worker('gpu', 3, { region: 'eu', gpu: true });
  const pick = (selector) => selectWorker({ id: 'j', required_cpu: 1, required_memory: 256, selector },
    [eu, gpu], 4)?.id ?? null;
  assert.equal(pick({}), 'eu');
  assert.equal(pick({ gpu: 'true' }), 'gpu');
  assert.equal(pick({ gpu: 'true', region: 'us' }), null);
  assert.equal(pick({ tier: 'a' }), null);
});

test('queued jobs are read highest priority first and respect retry backoff', async () => {
  let sql = '';
  const store = new PostgresSchedulerStore({ async query(text) { sql = text; return { rows: [] }; } });
  await store.getQueuedJobs(5);
  assert.match(sql, /ORDER BY priority DESC, submitted_at ASC/);
  assert.match(sql, /run_after IS NULL OR run_after <= NOW\(\)/);
});

test('scheduler keeps assigning while batches make progress', async () => {
  let batches = 0;
  const handle = startScheduler({ async runBatch() { batches += 1; return batches < 3 ? 1 : 0; } }, 60_000);
  handle.kick();
  await new Promise((resolve) => setTimeout(resolve, 100));
  handle.stop();
  assert.equal(batches, 3);
});

test('monitor labels cancelled recoveries and prunes at most hourly', async () => {
  const events = [];
  const prunes = [];
  let clock = 0;
  const store = {
    async markWorkersUnhealthy() { return []; }, async markWorkersOffline() { return []; },
    async recoverJobsForWorkers() { return []; },
    async recoverStaleJobs() { return [{ id: 'job-c', status: 'cancelled', retries: 1 }]; },
    async createJobEvent(...args) { events.push(args); },
    async pruneExpired(retention) { prunes.push(retention); return { jobs: 0, workers: 0 }; },
  };
  const monitor = new Monitor(store, { retentionDays: 7, staleWorkerHours: 12, now: () => clock });
  await monitor.runOnce();
  clock += 30 * 60 * 1000;
  await monitor.runOnce();
  clock += 31 * 60 * 1000;
  await monitor.runOnce();
  assert.equal(events[0][1], 'auto_cancelled');
  assert.deepEqual(prunes, [{ jobDays: 7, workerHours: 12 }, { jobDays: 7, workerHours: 12 }]);
  await new Monitor(store, { retentionDays: 0, now: () => clock }).runOnce();
  assert.equal(prunes.length, 2);
});

test('recovery honours cancel requests and pruning keeps job history', async () => {
  const statements = [];
  const pool = { async query(sql, values) { statements.push({ sql, values }); return { rows: [], rowCount: 3 }; } };
  const store = new PostgresMonitorStore(pool);
  await store.recoverStaleJobs();
  assert.match(statements[0].sql, /WHEN cancel_requested THEN 'cancelled'/);
  assert.deepEqual(await store.pruneExpired({ jobDays: 30, workerHours: 24 }), { jobs: 3, workers: 3 });
  assert.match(statements[1].sql, /DELETE FROM jobs/);
  assert.deepEqual(statements[1].values, [30]);
  assert.match(statements[2].sql, /NOT EXISTS \(SELECT 1 FROM jobs j WHERE j.worker_id = w.id/);
});

test('demo limiter caps each visitor separately from the global limit', () => {
  let time = 0;
  const limiter = new DemoLimiter(() => time, 2, 24);
  const next = (visitor) => { time += 3000; return limiter.allow(visitor); };
  assert.equal(next('a'), true);
  assert.equal(next('a'), true);
  assert.equal(next('a'), false);
  assert.equal(next('b'), true);
  time += 60 * 60 * 1000;
  assert.equal(next('a'), true);
});

test('logs are served only from uploaded object keys', async () => {
  const jobs = { async getJob(jobID) {
    return { ...job, id: jobID, logs_path: jobID === id ? 'logs/x.txt' : '/worker/local/logs.txt' };
  } };
  const artifacts = { async getText(key, max) { return `${key}:${max}`; } };
  await withServer({ jobs, artifacts }, async (origin) => {
    const headers = { Authorization: `Bearer ${await login(origin)}` };
    const response = await fetch(`${origin}/jobs/${id}/logs`, { headers });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'logs/x.txt:262144');
    const local = await fetch(`${origin}/jobs/123e4567-e89b-42d3-a456-426614174001/logs`, { headers });
    assert.equal(local.status, 404);
  });
});

test('re-registering rotates the credential and the old one stops working', async () => {
  const issued = new Map();
  const workers = {
    async registerWorker(input) { issued.set(input.workerID ?? id, input.tokenHash); return { id, hostname: 'w' }; },
    async verifyToken(workerID, hash) { return issued.get(workerID) === hash; },
    async updateHeartbeat() { return true; },
  };
  await withServer({ workers }, async (origin) => {
    const register = async () => (await (await fetch(`${origin}/workers/register`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer secret' },
      body: JSON.stringify({ hostname: 'w', worker_id: id }) })).json()).token;
    const beat = (token) => fetch(`${origin}/workers/heartbeat`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ worker_id: id, current_load: 0 }) });
    const first = await register();
    assert.equal((await beat(first)).status, 200);
    const second = await register();
    assert.notEqual(first, second);
    assert.equal((await beat(first)).status, 401);
    assert.equal((await beat(second)).status, 200);
  });
});

test('registration requires the bootstrap secret; a store that cannot verify tokens never accepts them', async () => {
  await withServer({ workers: { async registerWorker() { return { id }; } } }, async (origin) => {
    const attempt = (token) => fetch(`${origin}/workers/register`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ hostname: 'w' }) });
    assert.equal((await attempt('wrong')).status, 401);
    assert.equal((await attempt('secret')).status, 201);
    const beat = await fetch(`${origin}/workers/heartbeat`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer anything' },
      body: JSON.stringify({ worker_id: id }) });
    assert.equal(beat.status, 503);
  });
});
