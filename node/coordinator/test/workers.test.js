import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, test } from 'node:test';
import { createCoordinatorServer } from '../dist/server.js';

const workerID = '123e4567-e89b-42d3-a456-426614174000';
const calls = [];
const events = [];
const worker = {
  id: workerID, hostname: 'worker-1', status: 'online', last_heartbeat: null,
  cpu_cores: 1, memory_mb: 512, labels: {}, current_load: 0,
  registered_at: '2026-09-25T00:00:00Z',
};
const store = {
  async registerWorker(input) { calls.push(['register', input]); return worker; },
  async updateHeartbeat(id, load) { calls.push(['heartbeat', id, load]); return id === workerID; },
  async listWorkers() { return [worker]; },
};
let clock = 1000;
const server = createCoordinatorServer({
  secret: 'test-secret', workers: store, broadcast: (event) => events.push(event), now: () => clock,
});
let base;
before(async () => {
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((resolve) => server.close(resolve)));

const post = (path, body, token = 'test-secret') => fetch(`${base}${path}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  body: JSON.stringify(body),
});

test('worker registration checks auth, defaults, token hash and event', async () => {
  const denied = await post('/workers/register', { hostname: 'worker-1' }, 'wrong');
  assert.equal(denied.status, 401);
  assert.equal((await post('/workers/register', {})).status, 400);
  const response = await post('/workers/register', { hostname: 'worker-1' });
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), worker);
  assert.deepEqual(calls.at(-1), ['register', {
    hostname: 'worker-1', cpuCores: 1, memoryMB: 512, labels: {},
    tokenHash: createHash('sha256').update('test-secret').digest('hex'),
  }]);
  assert.deepEqual(events.at(-1), { type: 'worker_registered', payload: worker });
});

test('heartbeat validates worker ID and reports missing worker', async () => {
  assert.equal((await post('/workers/heartbeat', { worker_id: 'bad' })).status, 400);
  const missing = await post('/workers/heartbeat', {
    worker_id: '123e4567-e89b-42d3-a456-426614174001', current_load: 1,
  });
  assert.equal(missing.status, 404);
  const response = await post('/workers/heartbeat', { worker_id: workerID, current_load: 2 });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok' });
  assert.deepEqual(calls.at(-1), ['heartbeat', workerID, 2]);
  assert.deepEqual(events.at(-1), {
    type: 'worker_heartbeat', payload: { worker_id: workerID, current_load: 2 },
  });
});

test('worker list requires a live dashboard session', async () => {
  assert.equal((await fetch(`${base}/workers`)).status, 401);
  const login = await post('/auth/login', { api_key: 'test-secret' });
  const { token } = await login.json();
  const list = () => fetch(`${base}/workers`, { headers: { Authorization: `Bearer ${token}` } });
  const response = await list();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), [worker]);
  clock += 24 * 60 * 60 * 1000;
  assert.equal((await list()).status, 401);
});
