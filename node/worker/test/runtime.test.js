import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CoordinatorError } from '../dist/client.js';
import { parseLabels, WorkerRuntime } from '../dist/runtime.js';

const workerID = '123e4567-e89b-42d3-a456-426614174000';
const job = { id: 'job-1', image_name: 'alpine', command: 'echo hi', timeout_seconds: 300 };
const result = { exitCode: 0, timedOut: false, cancelled: false, stdout: 'hi', stderr: '',
  logsPath: '/tmp/logs.txt', artifactDir: '/tmp/output', durationMs: 10 };
const quiet = { async cleanup() {}, async cancel() { return false; } };

test('runtime registers, polls, runs, uploads, and reports lifecycle', async () => {
  const calls = [];
  let next = job;
  const client = {
    async register(...args) { calls.push(['register', ...args]); return { id: workerID }; },
    async heartbeat(...args) { calls.push(['heartbeat', ...args]); return []; },
    async pollJob(id, wait) { calls.push(['poll', id, wait]); const value = next; next = null; return value; },
    async reportStatus(value) { calls.push(['status', value]); },
  };
  const executor = { ...quiet,
    async run(value) { calls.push(['execute', value]); return result; },
    async cleanup(...args) { calls.push(['cleanup', ...args]); } };
  const uploader = {
    async uploadArtifacts(...args) { calls.push(['upload', ...args]); return 'artifacts/job-1.tar'; },
    async uploadLogs(...args) { calls.push(['logs', ...args]); return 'logs/job-1.txt'; },
  };
  const runtime = new WorkerRuntime(client, executor, uploader,
    { hostname: 'host', cpuCores: 2, memoryMB: 1024, persistWorkerID: false, labels: { gpu: 'true' } });
  await runtime.start();
  await runtime.pollOnce();
  await runtime.heartbeat();
  await runtime.stop();
  assert.deepEqual(calls[0], ['register', 'host', 2, 1024, { workerID: undefined, labels: { gpu: 'true' } }]);
  assert.deepEqual(calls.find((call) => call[0] === 'poll'), ['poll', workerID, 10]);
  assert.deepEqual(calls.find((call) => call[0] === 'heartbeat'), ['heartbeat', workerID, 1]);
  assert.deepEqual(calls.filter((call) => call[0] === 'status').map((call) => call[1].status),
    ['running', 'completed']);
  assert.deepEqual(calls.find((call) => call[0] === 'upload'), ['upload', 'job-1', '/tmp/output']);
  assert.deepEqual(calls.find((call) => call[0] === 'logs'), ['logs', 'job-1', '/tmp/logs.txt']);
  const final = calls.filter((call) => call[0] === 'status').at(-1)[1];
  assert.equal(final.artifactPath, 'artifacts/job-1.tar');
  assert.equal(final.logsPath, 'logs/job-1.txt');
  assert.deepEqual(calls.at(-1), ['cleanup', 'job-1', false]);
  assert.equal(runtime.currentLoad, 0);
});

test('runtime reports timeouts and does not upload when output is absent', async () => {
  const statuses = [];
  const client = {
    async register() { return { id: workerID }; }, async heartbeat() { return []; },
    async pollJob() { return job; },
    async reportStatus(value) { statuses.push(value.status); },
  };
  const executor = { ...quiet, async run() { return { ...result, timedOut: true, artifactDir: '' }; } };
  const runtime = new WorkerRuntime(client, executor, null, { persistWorkerID: false });
  await runtime.start();
  await runtime.pollOnce();
  await runtime.stop();
  assert.deepEqual(statuses, ['running', 'timed_out']);
});

test('runtime reports a failed job when Docker execution throws', async () => {
  const statuses = [];
  const client = {
    async register() { return { id: workerID }; }, async heartbeat() { return []; },
    async pollJob() { return job; },
    async reportStatus(value) { statuses.push(value.status); },
  };
  const executor = { ...quiet, async run() { throw new Error('docker unavailable'); } };
  const runtime = new WorkerRuntime(client, executor, null, { persistWorkerID: false });
  const originalWrite = process.stderr.write;
  process.stderr.write = () => true;
  try {
    await runtime.start();
    await runtime.pollOnce();
    await runtime.stop();
    assert.deepEqual(statuses, ['running', 'failed']);
  } finally { process.stderr.write = originalWrite; }
});

test('heartbeat forwards coordinator cancel requests and a cancelled run reports cancelled', async () => {
  const cancelled = [];
  const statuses = [];
  let release;
  const client = {
    async register() { return { id: workerID }; },
    async heartbeat() { return ['job-1']; },
    async pollJob() { return job; },
    async reportStatus(value) { statuses.push(value.status); },
  };
  const executor = { ...quiet,
    async cancel(id) { cancelled.push(id); release({ ...result, cancelled: true, exitCode: 137 }); return true; },
    run() { return new Promise((resolve) => { release = resolve; }); } };
  const runtime = new WorkerRuntime(client, executor, null, { persistWorkerID: false });
  await runtime.start();
  await runtime.pollOnce();
  await runtime.heartbeat();
  await runtime.stop();
  assert.deepEqual(cancelled, ['job-1']);
  assert.deepEqual(statuses, ['running', 'cancelled']);
});

test('local logs are kept when they could not be uploaded', async () => {
  const cleanups = [];
  const client = {
    async register() { return { id: workerID }; }, async heartbeat() { return []; },
    async pollJob() { return job; }, async reportStatus() {},
  };
  const executor = { ...quiet, async run() { return result; },
    async cleanup(...args) { cleanups.push(args); } };
  const uploader = { async uploadArtifacts() { return null; },
    async uploadLogs() { throw new Error('minio down'); } };
  const runtime = new WorkerRuntime(client, executor, uploader, { persistWorkerID: false });
  const originalWrite = process.stderr.write;
  process.stderr.write = () => true;
  try {
    await runtime.start();
    await runtime.pollOnce();
    await runtime.stop();
  } finally { process.stderr.write = originalWrite; }
  assert.deepEqual(cleanups, [['job-1', true]]);
});

test('worker ID is saved on first start and reused on restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'foreman-worker-id-'));
  const file = join(dir, 'nested', 'worker_id');
  const registrations = [];
  const client = {
    async register(...args) { registrations.push(args[3]); return { id: workerID }; },
    async heartbeat() { return []; }, async pollJob() { return null; }, async reportStatus() {},
  };
  try {
    const first = new WorkerRuntime(client, quiet, null, { workerIDFile: file });
    await first.start();
    await first.stop();
    assert.equal(await readFile(file, 'utf8'), workerID);
    const second = new WorkerRuntime(client, quiet, null, { workerIDFile: file });
    await second.start();
    await second.stop();
    assert.equal(registrations[0].workerID, undefined);
    assert.equal(registrations[1].workerID, workerID);
    await writeFile(file, 'not-a-uuid');
    const third = new WorkerRuntime(client, quiet, null, { workerIDFile: file });
    await third.start();
    await third.stop();
    assert.equal(registrations[2].workerID, undefined);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('label list parsing ignores malformed pairs', () => {
  assert.deepEqual(parseLabels('region=eu, gpu = true,broken,url=a=b'),
    { region: 'eu', gpu: 'true', url: 'a=b' });
  assert.deepEqual(parseLabels(undefined), {});
});

test('a rejected worker token triggers re-registration with the same worker ID', async () => {
  const registrations = [];
  let rejected = true;
  const client = {
    async register(...args) { registrations.push(args[3]); return { id: workerID }; },
    async heartbeat() {
      if (rejected) { rejected = false; throw new CoordinatorError('rotated', 401); }
      return [];
    },
    async pollJob() { return null; }, async reportStatus() {},
  };
  const runtime = new WorkerRuntime(client, quiet, null, { persistWorkerID: false });
  const originalWrite = process.stderr.write;
  process.stderr.write = () => true;
  try {
    await runtime.start();
    await assert.rejects(runtime.heartbeat(), CoordinatorError);
    assert.equal(registrations.length, 2);
    assert.equal(registrations[1].workerID, workerID);
    await runtime.heartbeat();
    await runtime.stop();
  } finally { process.stderr.write = originalWrite; }
});

test('other heartbeat failures do not re-register', async () => {
  let registered = 0;
  const client = {
    async register() { registered += 1; return { id: workerID }; },
    async heartbeat() { throw new CoordinatorError('boom', 500); },
    async pollJob() { return null; }, async reportStatus() {},
  };
  const runtime = new WorkerRuntime(client, quiet, null, { persistWorkerID: false });
  await runtime.start();
  await assert.rejects(runtime.heartbeat(), CoordinatorError);
  await runtime.stop();
  assert.equal(registered, 1);
});
