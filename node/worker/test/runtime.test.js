import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WorkerRuntime } from '../dist/runtime.js';

const workerID = '123e4567-e89b-42d3-a456-426614174000';
const job = { id: 'job-1', image_name: 'alpine', command: 'echo hi', timeout_seconds: 300 };
const result = { exitCode: 0, timedOut: false, stdout: 'hi', stderr: '',
  logsPath: '/tmp/logs.txt', artifactDir: '/tmp/output', durationMs: 10 };

test('runtime registers, polls, runs, uploads, and reports lifecycle', async () => {
  const calls = [];
  let next = job;
  const client = {
    async register(...args) { calls.push(['register', ...args]); return { id: workerID }; },
    async heartbeat(...args) { calls.push(['heartbeat', ...args]); },
    async pollJob(id) { calls.push(['poll', id]); const value = next; next = null; return value; },
    async reportStatus(value) { calls.push(['status', value]); },
  };
  const executor = { async run(value) { calls.push(['execute', value]); return result; } };
  const uploader = { async uploadArtifacts(...args) { calls.push(['upload', ...args]); return 'artifacts/job-1.tar'; } };
  const runtime = new WorkerRuntime(client, executor, uploader,
    { hostname: 'host', cpuCores: 2, memoryMB: 1024, persistWorkerID: false });
  await runtime.start();
  await runtime.pollOnce();
  await runtime.heartbeat();
  await runtime.stop();
  assert.deepEqual(calls[0], ['register', 'host', 2, 1024]);
  assert.deepEqual(calls.find((call) => call[0] === 'heartbeat'), ['heartbeat', workerID, 1]);
  assert.deepEqual(calls.filter((call) => call[0] === 'status').map((call) => call[1].status),
    ['running', 'completed']);
  assert.deepEqual(calls.find((call) => call[0] === 'upload'),
    ['upload', 'job-1', '/tmp/output']);
  assert.equal(calls.at(-1)[1].artifactPath, 'artifacts/job-1.tar');
  assert.equal(runtime.currentLoad, 0);
});

test('runtime reports timeouts and does not upload when output is absent', async () => {
  const statuses = [];
  const client = {
    async register() { return { id: workerID }; }, async heartbeat() {},
    async pollJob() { return job; },
    async reportStatus(value) { statuses.push(value.status); },
  };
  const executor = { async run() { return { ...result, timedOut: true, artifactDir: '' }; } };
  const runtime = new WorkerRuntime(client, executor, null, { persistWorkerID: false });
  await runtime.start();
  await runtime.pollOnce();
  await runtime.stop();
  assert.deepEqual(statuses, ['running', 'timed_out']);
});

test('runtime reports a failed job when Docker execution throws', async () => {
  const statuses = [];
  const client = {
    async register() { return { id: workerID }; }, async heartbeat() {},
    async pollJob() { return job; },
    async reportStatus(value) { statuses.push(value.status); },
  };
  const executor = { async run() { throw new Error('docker unavailable'); } };
  const runtime = new WorkerRuntime(client, executor, null, { persistWorkerID: false });
  const originalError = console.error;
  console.error = () => {};
  try {
    await runtime.start();
    await runtime.pollOnce();
    await runtime.stop();
    assert.deepEqual(statuses, ['running', 'failed']);
  } finally { console.error = originalError; }
});
