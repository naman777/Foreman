import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import { CoordinatorClient, CoordinatorError } from '../dist/client.js';

const received = [];
const worker = { id: 'worker-id', hostname: 'host' };
const job = { id: 'job-id', status: 'scheduled' };
let queued = false;
const server = createServer(async (request, response) => {
  let raw = '';
  for await (const chunk of request) raw += chunk;
  received.push({ method: request.method, path: request.url, auth: request.headers.authorization,
    body: raw ? JSON.parse(raw) : undefined });
  if (request.url?.startsWith('/jobs/next')) {
    if (!queued) { response.writeHead(204); response.end(); return; }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(job)); return;
  }
  if (request.url === '/workers/heartbeat' && received.at(-1).body?.worker_id === 'cancelling') {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ status: 'ok', cancel_jobs: ['job-a', 7] })); return;
  }
  if (request.url === '/workers/register') {
    response.writeHead(201, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ ...worker, token: 'issued-token' })); return;
  }
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end('{}');
});
let client;
before(async () => {
  await new Promise((resolve) => server.listen(0, resolve));
  client = new CoordinatorClient(`http://127.0.0.1:${server.address().port}`, 'secret');
});
after(() => new Promise((resolve) => server.close(resolve)));

test('register uses the shared secret, then every call uses the issued worker token', async () => {
  await assert.rejects(new CoordinatorClient(`http://127.0.0.1:${server.address().port}`, 'secret')
    .heartbeat('worker-id', 0), /not registered/);
  assert.deepEqual(await client.register('host', 2, 1024), worker);
  await client.heartbeat('worker-id', 3);
  assert.deepEqual(received.slice(-2), [
    { method: 'POST', path: '/workers/register', auth: 'Bearer secret',
      body: { hostname: 'host', cpu_cores: 2, memory_mb: 1024 } },
    { method: 'POST', path: '/workers/heartbeat', auth: 'Bearer issued-token',
      body: { worker_id: 'worker-id', current_load: 3 } },
  ]);
});

test('poll treats 204 as no job and parses assigned job', async () => {
  assert.equal(await client.pollJob('worker-id'), null);
  queued = true;
  assert.deepEqual(await client.pollJob('worker-id'), job);
});

test('status report includes optional artifact fields only when present', async () => {
  await client.reportStatus({ jobID: 'job-id', status: 'completed', workerID: 'worker-id',
    logsPath: 'logs/key', artifactPath: 'artifacts/key' });
  assert.deepEqual(received.at(-1).body, { status: 'completed', worker_id: 'worker-id',
    logs_path: 'logs/key', artifact_path: 'artifacts/key' });
});

test('register sends a saved worker ID and labels only when present', async () => {
  await client.register('host', 1, 512, { workerID: 'saved-id', labels: { gpu: 'true' } });
  assert.deepEqual(received.at(-1).body, { hostname: 'host', cpu_cores: 1, memory_mb: 512,
    worker_id: 'saved-id', labels: { gpu: 'true' } });
  await client.register('host', 1, 512, { labels: {} });
  assert.deepEqual(received.at(-1).body, { hostname: 'host', cpu_cores: 1, memory_mb: 512 });
});

test('heartbeat returns the jobs to cancel and polling asks the coordinator to wait', async () => {
  assert.deepEqual(await client.heartbeat('cancelling', 1), ['job-a']);
  assert.deepEqual(await client.heartbeat('worker-id', 0), []);
  await client.pollJob('worker-id', 7);
  assert.equal(received.at(-1).path, '/jobs/next?worker_id=worker-id&wait=7');
});

test('the worker token is never the shared secret and HTTP failures carry their status', async () => {
  await client.heartbeat('worker-id', 0);
  assert.equal(received.at(-1).auth, 'Bearer issued-token');
  const failing = createServer((request, response) => { response.writeHead(401); response.end(); });
  await new Promise((resolve) => failing.listen(0, resolve));
  try {
    const rejected = new CoordinatorClient(`http://127.0.0.1:${failing.address().port}`, 'secret');
    await assert.rejects(rejected.register('h', 1, 512), (error) =>
      error instanceof CoordinatorError && error.status === 401);
  } finally { await new Promise((resolve) => failing.close(resolve)); }
});

test('registration without an issued token is an error', async () => {
  const bare = createServer((request, response) => {
    response.writeHead(201, { 'Content-Type': 'application/json' }); response.end('{"id":"x"}');
  });
  await new Promise((resolve) => bare.listen(0, resolve));
  try {
    await assert.rejects(new CoordinatorClient(`http://127.0.0.1:${bare.address().port}`, 's')
      .register('h', 1, 512), /did not issue/);
  } finally { await new Promise((resolve) => bare.close(resolve)); }
});
