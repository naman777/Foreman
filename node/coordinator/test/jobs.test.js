import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, test } from 'node:test';
import { createCoordinatorServer } from '../dist/server.js';
import { PostgresJobStore } from '../dist/store.js';

const id = '123e4567-e89b-42d3-a456-426614174000';
const job = { id, name: null, status: 'queued', image_name: 'alpine', command: 'echo hi' };
const calls = [];
const jobs = {
  async createJob(input) { calls.push(['create', input]); return job; },
  async createJobEvent(...input) { calls.push(['event', ...input]); },
  async listJobs(filters) { calls.push(['list', filters]); return [job]; },
  async getJob(jobID) { return jobID === id ? job : null; },
  async getJobEvents() { return [{ event_type: 'submitted' }]; },
  async getNextJob(workerID) { calls.push(['next', workerID]); return job; },
  async updateJobStatus(input) { calls.push(['status', input]); return { ...job, status: input.status }; },
  async getMetricsSummary() { return { queued: 2, total: 2 }; },
};
const workers = { async verifyToken(workerID, hash) {
  return workerID === id && hash === createHash('sha256').update('worker-token').digest('hex'); } };
const server = createCoordinatorServer({ secret: 'secret', jobs, workers });
let base;
let token;
before(async () => {
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${base}/auth/login`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ api_key: 'secret' }) });
  token = (await response.json()).token;
});
after(() => new Promise((resolve) => server.close(resolve)));
const headers = () => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });

test('job submission requires login and uses Go defaults', async () => {
  assert.equal((await fetch(`${base}/jobs`, { method: 'POST' })).status, 401);
  assert.equal((await fetch(`${base}/jobs`, { method: 'POST', headers: headers(), body: '{}' })).status, 400);
  const response = await fetch(`${base}/jobs`, { method: 'POST', headers: headers(),
    body: JSON.stringify({ image_name: 'alpine', command: 'echo hi' }) });
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), job);
  assert.deepEqual(calls.at(-2), ['create', { name: null, imageName: 'alpine', command: 'echo hi',
    requiredCPU: 1, requiredMemory: 256, maxRetries: 0, timeoutSeconds: 300, priority: 5, selector: {} }]);
  assert.deepEqual(calls.at(-1), ['event', id, 'submitted', {}]);
});

test('job listing and detail preserve filters and event envelope', async () => {
  const list = await fetch(`${base}/jobs?status=queued&worker_id=${id}&limit=10&offset=2`, { headers: headers() });
  assert.equal(list.status, 200);
  assert.deepEqual(await list.json(), [job]);
  assert.deepEqual(calls.at(-1), ['list', { status: 'queued', workerID: id, limit: 10, offset: 2 }]);
  assert.equal((await fetch(`${base}/jobs?worker_id=bad`, { headers: headers() })).status, 400);
  const detail = await fetch(`${base}/jobs/${id}`, { headers: headers() });
  assert.deepEqual(await detail.json(), { job, events: [{ event_type: 'submitted' }] });
  assert.equal((await fetch(`${base}/jobs/123e4567-e89b-42d3-a456-426614174001`, { headers: headers() })).status, 404);
});

test('PostgreSQL job store parameterizes filters and uses existing schema', async () => {
  const queries = [];
  const pool = { async query(sql, values) {
    queries.push({ sql, values });
    return { rows: sql.includes('INSERT INTO job_events') ? [] : [job] };
  } };
  const store = new PostgresJobStore(pool);
  assert.deepEqual(await store.createJob({ name: null, imageName: 'alpine', command: 'echo hi',
    requiredCPU: 1, requiredMemory: 256, maxRetries: 0, timeoutSeconds: 300, priority: 5 }), job);
  await store.createJobEvent(id, 'submitted', {});
  assert.deepEqual(queries[1].values, [id, 'submitted', '{}']);
  await store.listJobs({ status: 'queued', workerID: id, limit: 10, offset: 2 });
  assert.deepEqual(queries[2].values, ['queued', id, 10, 2]);
  assert.match(queries[2].sql, /status = \$1 AND worker_id = \$2/);
  assert.match(queries[2].sql, /LIMIT \$3 OFFSET \$4/);
});

test('worker claim and status routes use the worker token, not the shared secret', async () => {
  assert.equal((await fetch(`${base}/jobs/next?worker_id=${id}`)).status, 401);
  assert.equal((await fetch(`${base}/jobs/next?worker_id=${id}`, {
    headers: { Authorization: 'Bearer secret' } })).status, 401, 'the bootstrap secret no longer works here');
  const next = await fetch(`${base}/jobs/next?worker_id=${id}`, {
    headers: { Authorization: 'Bearer worker-token' },
  });
  assert.equal(next.status, 200);
  assert.deepEqual(await next.json(), job);
  assert.deepEqual(calls.at(-1), ['next', id]);
  const update = await fetch(`${base}/jobs/${id}/status`, { method: 'POST',
    headers: { Authorization: 'Bearer worker-token', 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'running', worker_id: id }) });
  assert.equal((await fetch(`${base}/jobs/${id}/status`, { method: 'POST',
    headers: { Authorization: 'Bearer worker-token', 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'running', worker_id: '123e4567-e89b-42d3-a456-426614174001' }) })).status,
  401, 'a worker cannot report as another worker');
  assert.equal(update.status, 200);
  assert.deepEqual(calls.at(-2), ['status', {
    jobID: id, status: 'running', workerID: id, logsPath: null, artifactPath: null,
  }]);
  assert.deepEqual(calls.at(-1), ['event', id, 'status_changed', { status: 'running' }]);
});

test('claim and final status use one database client per transaction', async () => {
  const statements = [];
  let released = 0;
  const client = {
    async query(sql, values) {
      statements.push({ sql, values });
      if (sql.includes("status = 'scheduled' AND worker_id")) return { rows: [job] };
      if (sql.includes('UPDATE jobs')) return { rows: [{ ...job, status: 'running', worker_id: id }] };
      return { rows: [] };
    },
    release() { released += 1; },
  };
  const store = new PostgresJobStore({ async connect() { return client; } });
  assert.equal((await store.getNextJob(id)).status, 'running');
  assert.match(statements[1].sql, /status = 'scheduled' AND worker_id = \$1/);
  assert.match(statements[1].sql, /FOR UPDATE SKIP LOCKED/);
  assert.deepEqual(statements[2].values, [id]);
  assert.match(statements[2].sql, /timeout_seconds \+ 30/);
  assert.equal(statements[3].sql, 'COMMIT');
  await store.updateJobStatus({ jobID: id, status: 'completed', workerID: id,
    logsPath: 'logs/key', artifactPath: 'artifacts/key' });
  assert.deepEqual(statements[5].values, [id, 'completed', 'logs/key', 'artifacts/key', id]);
  assert.match(statements[5].sql, /status = 'running' AND worker_id = \$5/);
  assert.match(statements[5].sql, /status = CASE WHEN \$2 IN \('failed', 'timed_out'\) AND retries < max_retries THEN 'queued'/);
  assert.match(statements[5].sql, /retries = CASE WHEN \$2 IN \('failed', 'timed_out'\) AND retries < max_retries THEN retries \+ 1/);
  assert.match(statements[5].sql, /run_after = CASE WHEN .* THEN NOW\(\) \+ \(LEAST\(300, 5 \* POWER\(2, retries\)\)/);
  assert.match(statements[6].sql, /current_load = GREATEST/);
  assert.equal(statements[7].sql, 'COMMIT');
  assert.equal(released, 2);
});

test('worker polling claims its scheduled job before queued jobs', async () => {
  const statements = [];
  const client = {
    async query(sql, values) {
      statements.push({ sql, values });
      if (sql.includes("status = 'scheduled' AND worker_id")) return { rows: [job] };
      if (sql.includes('UPDATE jobs')) return { rows: [{ ...job, status: 'running' }] };
      return { rows: [] };
    },
    release() {},
  };
  const store = new PostgresJobStore({ async connect() { return client; } });
  const claimed = await store.getNextJob(id);
  assert.equal(claimed.status, 'running');
  assert.equal(statements.some(({ sql }) => sql.includes("WHERE status = 'queued'")), false);
  assert.equal(statements.at(-1).sql, 'COMMIT');
});

test('stale worker result cannot finish a recovered job or decrement load', async () => {
  const statements = [];
  const client = {
    async query(sql, values) {
      statements.push({ sql, values });
      return { rows: [] };
    },
    release() {},
  };
  const store = new PostgresJobStore({ async connect() { return client; } });
  assert.equal(await store.updateJobStatus({ jobID: id, status: 'completed', workerID: id,
    logsPath: null, artifactPath: null }), null);
  assert.match(statements[1].sql, /status = 'running' AND worker_id = \$5/);
  assert.equal(statements.some(({ sql }) => sql.includes('UPDATE workers')), false);
  assert.equal(statements.at(-1).sql, 'ROLLBACK');
});

test('worker polling leaves unassigned queued jobs for the scheduler', async () => {
  const statements = [];
  const client = {
    async query(sql) { statements.push(sql); return { rows: [] }; },
    release() {},
  };
  const store = new PostgresJobStore({ async connect() { return client; } });
  assert.equal(await store.getNextJob(id), null);
  assert.deepEqual(statements.at(-1), 'ROLLBACK');
  assert.equal(statements.some((sql) => sql.includes("status = 'queued'")), false);
});

test('metrics require dashboard session and count jobs by status', async () => {
  assert.equal((await fetch(`${base}/metrics/summary`)).status, 401);
  const response = await fetch(`${base}/metrics/summary`, { headers: headers() });
  assert.deepEqual(await response.json(), { queued: 2, total: 2 });
  const store = new PostgresJobStore({
    async query() { return { rows: [{ status: 'queued', count: '2' },
      { status: 'retrying', count: '1' }] }; },
  });
  assert.deepEqual(await store.getMetricsSummary(), {
    queued: 2, scheduled: 0, running: 0, completed: 0, failed: 0,
    timed_out: 0, cancelled: 0, total: 3,
  });
});
