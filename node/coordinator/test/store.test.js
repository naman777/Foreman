import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PostgresWorkerStore } from '../dist/store.js';

test('worker store uses schema columns and parameterized values', async () => {
  const calls = [];
  const worker = { id: 'worker-1', hostname: 'host', labels: { region: 'west' } };
  const pool = {
    async query(sql, values) {
      calls.push({ sql, values });
      if (sql.includes('INSERT INTO workers')) return { rows: [worker] };
      if (sql.includes('UPDATE workers')) return { rowCount: 1 };
      return { rows: [worker] };
    },
  };
  const store = new PostgresWorkerStore(pool);
  assert.deepEqual(await store.registerWorker({
    hostname: 'host', cpuCores: 2, memoryMB: 1024,
    labels: { region: 'west' }, tokenHash: 'hash',
  }), worker);
  assert.deepEqual(calls[0].values, ['host', 2, 1024, '{"region":"west"}', 'hash']);
  assert.match(calls[0].sql, /registered_token_hash/);
  assert.match(calls[0].sql, /\$4::jsonb/);
  assert.equal(await store.updateHeartbeat('worker-1', 3), true);
  assert.deepEqual(calls[1].values, ['worker-1', 3]);
  assert.deepEqual(await store.listWorkers(), [worker]);
  assert.match(calls[2].sql, /ORDER BY registered_at DESC/);
});

test('heartbeat distinguishes unknown workers', async () => {
  const store = new PostgresWorkerStore({ async query() { return { rowCount: 0 }; } });
  assert.equal(await store.updateHeartbeat('missing', 0), false);
});
