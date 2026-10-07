import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';

const base = process.env.FOREMAN_API_URL ?? 'http://localhost:8080';
const dashboard = process.env.FOREMAN_DASHBOARD_URL ?? 'http://localhost:3000';
const secret = process.env.COORDINATOR_SECRET ?? 'dev-secret-change-in-prod';
const minWorkers = Number(process.env.FOREMAN_MIN_WORKERS ?? 3);
const terminal = new Set(['completed', 'failed', 'timed_out', 'cancelled']);

async function request(path, { token, method = 'GET', body } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, data: response.status === 204 ? null : await response.json() };
}

async function waitForJob(id, token, expected) {
  for (let attempt = 0; attempt < 45; attempt += 1) {
    const detail = await request(`/jobs/${id}`, { token });
    assert.equal(detail.status, 200);
    if (terminal.has(detail.data.job.status)) {
      assert.equal(detail.data.job.status, expected, `job ${id} ended unexpectedly`);
      return detail.data;
    }
    await sleep(1000);
  }
  throw new Error(`job ${id} did not finish within 45 seconds`);
}

async function waitForStatus(id, token, expected) {
  for (let attempt = 0; attempt < 45; attempt += 1) {
    const detail = await request(`/jobs/${id}`, { token });
    if (detail.data.job.status === expected) return detail.data;
    await sleep(500);
  }
  throw new Error(`job ${id} never reached ${expected}`);
}

async function main() {
  const health = await request('/health');
  assert.equal(health.status, 200);
  assert.equal((await request('/jobs')).status, 401);
  assert.equal((await request('/auth/login', { method: 'POST', body: { api_key: 'incorrect' } })).status, 401);
  const login = await request('/auth/login', { method: 'POST', body: { api_key: secret } });
  assert.equal(login.status, 200);
  const token = login.data.token;
  assert.ok(token);
  // Workers register a few seconds after the coordinator becomes healthy.
  let online = 0;
  for (let attempt = 0; attempt < 30 && online < minWorkers; attempt += 1) {
    const workers = await request('/workers', { token });
    assert.equal(workers.status, 200);
    online = workers.data.filter((worker) => worker.status === 'online').length;
    if (online < minWorkers) await sleep(1000);
  }
  assert.ok(online >= minWorkers, `expected ${minWorkers} online workers, found ${online}`);
  assert.equal((await request('/metrics/summary', { token })).status, 200);
  assert.equal((await request('/jobs', { token })).status, 200);
  const page = await fetch(`${dashboard}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Foreman/);
  console.log('PASS health, authentication, workers, metrics, jobs, dashboard HTTP');

  const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/ws?token=${encodeURIComponent(token)}`);
  const events = [];
  ws.addEventListener('message', (event) => events.push(JSON.parse(event.data)));
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  try {
    const submit = async (name, command, timeout_seconds = 30) => {
      const result = await request('/jobs', { token, method: 'POST', body: {
        name: `node-only-smoke-${name}`, image_name: 'alpine:3.20', command,
        required_cpu: 1, required_memory: 128, max_retries: 0, timeout_seconds,
      } });
      assert.equal(result.status, 201);
      return result.data.id;
    };

    const successID = await submit('success', 'printf node-only-ok > /output/result.txt');
    const success = await waitForJob(successID, token, 'completed');
    assert.equal(success.job.retries, 0);
    assert.ok(success.events.some((event) => event.event_type === 'status_changed'));
    const artifact = await request(`/jobs/${successID}/artifacts`, { token });
    assert.equal(artifact.status, 200);
    const archive = await fetch(artifact.data.download_url);
    assert.equal(archive.status, 200);
    assert.ok(Buffer.from(await archive.arrayBuffer()).includes(Buffer.from('node-only-ok')));
    console.log(`PASS successful job and artifact ${successID}`);

    const failureID = await submit('failure', 'exit 7');
    await waitForJob(failureID, token, 'failed');
    console.log(`PASS failed job ${failureID}`);

    const timeoutID = await submit('timeout', 'sleep 10', 2);
    const timedOut = await waitForJob(timeoutID, token, 'timed_out');
    assert.equal(timedOut.job.retries, 0);
    console.log(`PASS timed-out job ${timeoutID}`);

    const logsID = await submit('logs', 'echo hello-from-logs; echo oops >&2');
    await waitForJob(logsID, token, 'completed');
    const logs = await fetch(`${base}/jobs/${logsID}/logs`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(logs.status, 200);
    const logText = await logs.text();
    assert.match(logText, /hello-from-logs/);
    assert.match(logText, /oops/);
    console.log(`PASS job logs ${logsID}`);

    const retryID = (await request('/jobs', { token, method: 'POST', body: {
      name: 'node-only-smoke-retry', image_name: 'alpine:3.20', command: 'exit 1',
      required_cpu: 1, required_memory: 128, max_retries: 1, timeout_seconds: 30 } })).data.id;
    const retried = await waitForJob(retryID, token, 'failed');
    assert.equal(retried.job.retries, 1);
    console.log(`PASS failed job retried once with backoff ${retryID}`);

    const cancelID = await submit('cancel', 'sleep 120', 300);
    await waitForStatus(cancelID, token, 'running');
    assert.equal((await request(`/jobs/${cancelID}/cancel`, { token, method: 'POST' })).status, 202);
    await waitForJob(cancelID, token, 'cancelled');
    assert.equal((await request(`/jobs/${cancelID}/cancel`, { token, method: 'POST' })).status, 409);
    console.log(`PASS running job cancelled ${cancelID}`);

    const concurrentIDs = await Promise.all(Array.from({ length: 6 }, (_, index) =>
      submit(`concurrent-${index}`, 'sleep 1; echo done')));
    const concurrent = await Promise.all(concurrentIDs.map((id) => waitForJob(id, token, 'completed')));
    for (const detail of concurrent) {
      assert.equal(detail.job.retries, 0);
      assert.equal(detail.events.filter((event) => event.event_type === 'status_changed').length, 2);
    }
    console.log('PASS six concurrent jobs completed once each');

    assert.ok(events.some((event) => event.type === 'job_updated' && event.payload?.id === successID));
    console.log(`PASS WebSocket job updates (${events.length} events received)`);
  } finally { ws.close(); }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
