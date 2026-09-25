import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import { CoordinatorClient } from '../dist/client.js';

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
  if (request.url === '/workers/register') {
    response.writeHead(201, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(worker)); return;
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

test('register and heartbeat match Go worker requests', async () => {
  assert.deepEqual(await client.register('host', 2, 1024), worker);
  await client.heartbeat('worker-id', 3);
  assert.deepEqual(received.slice(-2), [
    { method: 'POST', path: '/workers/register', auth: 'Bearer secret',
      body: { hostname: 'host', cpu_cores: 2, memory_mb: 1024 } },
    { method: 'POST', path: '/workers/heartbeat', auth: 'Bearer secret',
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
