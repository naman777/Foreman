import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createCoordinatorServer } from '../dist/server.js';

const server = createCoordinatorServer({ secret: 'test-secret' });
let base;
before(async () => {
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((resolve) => server.close(resolve)));

test('health response', async () => {
  const response = await fetch(`${base}/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok' });
});

test('login errors and success', async () => {
  const post = (body) => fetch(`${base}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
  });
  assert.equal((await post('{')).status, 400);
  assert.equal((await post(JSON.stringify({ api_key: 'wrong' }))).status, 401);
  const response = await post(JSON.stringify({ api_key: 'test-secret' }));
  assert.equal(response.status, 200);
  assert.match((await response.json()).token, /^[0-9a-f-]{36}$/);
});

test('CORS preflight', async () => {
  const response = await fetch(`${base}/jobs`, { method: 'OPTIONS' });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
});
