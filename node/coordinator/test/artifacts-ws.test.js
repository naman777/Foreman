import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import WebSocket from 'ws';
import { S3Client } from '@aws-sdk/client-s3';
import { S3ArtifactStore } from '../dist/artifacts.js';
import { createCoordinatorServer } from '../dist/server.js';

const id = '123e4567-e89b-42d3-a456-426614174000';
const job = { id, artifact_path: 'jobs/test/output.tar.gz' };
const jobs = {
  async getJob(value) { return value === id ? job : null; },
  async updateJobStatus() { return job; },
  async createJobEvent() {},
};
const artifacts = { async getPresignedURL(key) { return `https://example.test/${key}`; } };
const server = createCoordinatorServer({ secret: 'secret', jobs, artifacts });
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

test('artifact endpoint preserves auth, lookup, and one-hour URL response', async () => {
  assert.equal((await fetch(`${base}/jobs/${id}/artifacts`)).status, 401);
  const response = await fetch(`${base}/jobs/${id}/artifacts`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { object_key: 'jobs/test/output.tar.gz',
    download_url: 'https://example.test/jobs/test/output.tar.gz', expires_in: '1h' });
  assert.equal((await fetch(`${base}/jobs/123e4567-e89b-42d3-a456-426614174001/artifacts`,
    { headers: { Authorization: `Bearer ${token}` } })).status, 404);
});

test('artifact endpoint reports missing artifact and missing storage', async () => {
  const noArtifact = createCoordinatorServer({ secret: 'secret', jobs: {
    ...jobs, async getJob() { return { ...job, artifact_path: null }; },
  } });
  await new Promise((resolve) => noArtifact.listen(0, resolve));
  try {
    const local = `http://127.0.0.1:${noArtifact.address().port}`;
    const login = await fetch(`${local}/auth/login`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ api_key: 'secret' }) });
    const auth = { Authorization: `Bearer ${(await login.json()).token}` };
    const response = await fetch(`${local}/jobs/${id}/artifacts`, { headers: auth });
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: 'no artifacts for this job' });
  } finally { await new Promise((resolve) => noArtifact.close(resolve)); }

  const noStore = createCoordinatorServer({ secret: 'secret', jobs });
  await new Promise((resolve) => noStore.listen(0, resolve));
  try {
    const local = `http://127.0.0.1:${noStore.address().port}`;
    const login = await fetch(`${local}/auth/login`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ api_key: 'secret' }) });
    const auth = { Authorization: `Bearer ${(await login.json()).token}` };
    assert.equal((await fetch(`${local}/jobs/${id}/artifacts`, { headers: auth })).status, 503);
  } finally { await new Promise((resolve) => noStore.close(resolve)); }
});

test('WebSocket uses dashboard token and broadcasts job event envelope', async () => {
  const ws = new WebSocket(`${base.replace('http', 'ws')}/ws?token=${token}`);
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const nextMessage = new Promise((resolve) => ws.once('message', (data) => resolve(JSON.parse(data.toString()))));
  const response = await fetch(`${base}/jobs/${id}/status`, { method: 'POST',
    headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'completed' }) });
  assert.equal(response.status, 200);
  assert.deepEqual(await nextMessage, { type: 'job_updated', payload: job });
  ws.close();
  await new Promise((resolve) => ws.once('close', resolve));
});

test('S3 presigner produces a one-hour path-style GET URL without a network call', async () => {
  const client = new S3Client({ endpoint: 'http://localhost:9000', region: 'us-east-1',
    forcePathStyle: true, credentials: { accessKeyId: 'test', secretAccessKey: 'test' } });
  try {
    const url = await new S3ArtifactStore(client, 'foreman-artifacts').getPresignedURL('jobs/file.tar.gz');
    assert.match(url, /\/foreman-artifacts\/jobs\/file\.tar\.gz/);
    assert.match(url, /X-Amz-Expires=3600/);
  } finally { client.destroy(); }
});

test('artifact signing can use a browser-reachable endpoint', async () => {
  const credentials = { accessKeyId: 'test', secretAccessKey: 'test' };
  const internal = new S3Client({ endpoint: 'http://minio:9000', region: 'us-east-1',
    forcePathStyle: true, credentials });
  const publicClient = new S3Client({ endpoint: 'http://localhost:9000', region: 'us-east-1',
    forcePathStyle: true, credentials });
  try {
    const url = await new S3ArtifactStore(internal, 'foreman-artifacts', publicClient)
      .getPresignedURL('artifacts/job.tar');
    assert.equal(new URL(url).hostname, 'localhost');
  } finally { internal.destroy(); publicClient.destroy(); }
});
