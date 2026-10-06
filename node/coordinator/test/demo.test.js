import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createCoordinatorServer } from '../dist/server.js';
import { demoScenarios } from '../dist/demo.js';

const demoID = '123e4567-e89b-42d3-a456-426614174010';
const privateID = '123e4567-e89b-42d3-a456-426614174011';
const privateJob = { id: privateID, name: 'Private job', status: 'completed',
  image_name: 'private-image', command: 'private-command', artifact_path: 'private-key' };
const demoJob = { id: demoID, name: 'Demo · successful artifact', status: 'completed',
  image_name: 'alpine:3.20', command: demoScenarios.artifact.command,
  worker_id: privateID, logs_path: '/secret', artifact_path: 'demo-key' };
const created = [];
let current = 100_000;
const jobs = {
  async listJobs() { return [privateJob, demoJob]; },
  async getJob(id) { return id === demoID ? demoJob : id === privateID ? privateJob : null; },
  async getJobEvents() { return []; },
  async getMetricsSummary() { return { queued: 0, scheduled: 0, running: 0 }; },
  async createJob(input) { created.push(input); return { ...demoJob, name: input.name }; },
  async createJobEvent() {},
};
const workers = { async listWorkers() { return [{ id: privateID, hostname: 'private-host',
  status: 'online', cpu_cores: 1, memory_mb: 1024, current_load: 0 }]; } };
const artifacts = { async getPresignedURL(key) { return `https://example.com/${key}`; } };
const server = createCoordinatorServer({ secret: 'private-secret', jobs, workers, artifacts,
  publicDemo: true, now: () => current });
let base;
before(async () => {
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((resolve) => server.close(resolve)));

test('public routes expose only demo jobs and sanitized workers', async () => {
  const list = await fetch(`${base}/demo/jobs`);
  assert.equal(list.status, 200);
  const visible = await list.json();
  assert.equal(visible.length, 1);
  assert.equal(visible[0].id, demoID);
  assert.equal(visible[0].worker_id, null);
  assert.equal(visible[0].logs_path, null);
  assert.equal((await fetch(`${base}/demo/jobs/${privateID}`)).status, 404);
  assert.equal((await fetch(`${base}/demo/jobs/${privateID}/artifacts`)).status, 404);
  assert.equal((await fetch(`${base}/jobs`)).status, 401);
  const fleet = await (await fetch(`${base}/demo/workers`)).json();
  assert.equal(fleet[0].hostname, 'Worker 1');
  assert.notEqual(fleet[0].id, privateID);
});

test('public submission accepts fixed scenarios only and is rate limited', async () => {
  const post = (body) => fetch(`${base}/demo/jobs`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await post({ scenario: 'artifact', command: 'id' })).status, 400);
  assert.equal((await post({ scenario: 'arbitrary' })).status, 400);
  assert.equal((await post({ scenario: 'artifact' })).status, 201);
  assert.equal(created.length, 1);
  assert.equal(created[0].imageName, 'alpine:3.20');
  assert.match(created[0].command, /result.txt/);
  assert.equal((await post({ scenario: 'failure' })).status, 429);
  current += 3000;
  assert.equal((await post({ scenario: 'timeout' })).status, 201);
  assert.equal(created[1].timeoutSeconds, 2);
  assert.equal((await fetch(`${base}/jobs`, { method: 'POST' })).status, 401);
});

test('demo logs and cancel are limited to demo jobs', async () => {
  assert.equal((await fetch(`${base}/demo/jobs/${privateID}/logs`)).status, 404);
  assert.equal((await fetch(`${base}/demo/jobs/${privateID}/cancel`, { method: 'POST' })).status, 404);
  assert.equal((await fetch(`${base}/demo/jobs/${demoID}/logs`)).status, 404);
});
