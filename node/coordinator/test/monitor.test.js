import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Monitor } from '../dist/monitor.js';
import { PostgresMonitorStore } from '../dist/monitor-store.js';

test('monitor recovers offline workers then expired locks and records reasons', async () => {
  const calls = [];
  const store = {
    async markWorkersUnhealthy() { calls.push('unhealthy'); return ['worker-a']; },
    async markWorkersOffline() { calls.push('offline'); return ['worker-a']; },
    async recoverJobsForWorkers(ids) { calls.push(['recover-workers', ids]);
      return [{ id: 'job-a', status: 'queued', retries: 1 }]; },
    async recoverStaleJobs() { calls.push('recover-stale');
      return [{ id: 'job-b', status: 'failed', retries: 3 }]; },
    async createJobEvent(...args) { calls.push(['event', ...args]); },
  };
  await new Monitor(store).runOnce();
  assert.deepEqual(calls, ['unhealthy', 'offline', ['recover-workers', ['worker-a']],
    ['event', 'job-a', 'auto_recovered', { new_status: 'queued', retries: 1, reason: 'worker_offline' }],
    'recover-stale',
    ['event', 'job-b', 'auto_failed', { new_status: 'failed', retries: 3, reason: 'lock_expired' }]]);
});

test('monitor store uses Go heartbeat thresholds and retry expression', async () => {
  const statements = [];
  const pool = { async query(sql, values) { statements.push({ sql, values }); return { rows: [] }; } };
  const store = new PostgresMonitorStore(pool);
  await store.markWorkersUnhealthy();
  await store.markWorkersOffline();
  await store.recoverJobsForWorkers(['worker-a']);
  await store.recoverStaleJobs();
  assert.match(statements[0].sql, /INTERVAL '15 seconds'/);
  assert.match(statements[1].sql, /INTERVAL '30 seconds'/);
  assert.match(statements[2].sql, /worker_id = ANY\(\$1::uuid\[\]\)/);
  assert.deepEqual(statements[2].values, [['worker-a']]);
  assert.match(statements[3].sql, /lock_expires_at < NOW\(\)/);
  assert.match(statements[3].sql, /retries = retries \+ 1/);
});
