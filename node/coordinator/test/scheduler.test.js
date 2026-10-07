import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Scheduler, selectWorker } from '../dist/scheduler.js';
import { PostgresSchedulerStore } from '../dist/scheduler-store.js';
import { RedisJobLocker } from '../dist/locker.js';

const job = (id, cpu = 1, memory = 256) => ({ id, required_cpu: cpu, required_memory: memory });
const worker = (id, cpu, memory, load = 0) => ({ id, status: 'online', cpu_cores: cpu,
  memory_mb: memory, current_load: load, used_cpu: 0, used_memory: 0 });

test('scoring filters capacity and chooses the worker with most headroom', () => {
  const busy = worker('busy', 8, 8192, 4);
  const small = worker('small', 1, 256);
  const large = worker('large', 4, 2048);
  assert.equal(selectWorker(job('j', 2, 512), [busy, small, large], 4), large);
  assert.equal(selectWorker(job('j', 10, 512), [busy, small, large], 4), null);
});

test('batch updates local capacity and respects Redis lock result', async () => {
  const jobs = [job('a'), job('b'), job('c')];
  const assigned = [];
  const store = {
    async getQueuedJobs(limit) { assert.equal(limit, 50); return jobs; },
    async getEligibleWorkersWithLoad() { return [worker('w', 2, 512)]; },
    async assignJob(j, w) { assigned.push([j, w]); return true; },
  };
  const locker = { async lock(j) { return j !== 'b'; } };
  await new Scheduler(store, locker, 4).runBatch();
  assert.deepEqual(assigned, [['a', 'w'], ['c', 'w']]);
});

test('Redis locker uses a 30 second NX lock', async () => {
  let args;
  const locker = new RedisJobLocker({ async set(...value) { args = value; return 'OK'; } });
  assert.equal(await locker.lock('job-1', 'owner-1'), true);
  assert.deepEqual(args, ['scheduler:job:job-1', 'owner-1', { NX: true, EX: 30 }]);
});

test('database assignment guards queued status and increments load in one transaction', async () => {
  const queries = [];
  let released = false;
  const client = { async query(sql, values) { queries.push({ sql, values }); return { rowCount: 1 }; },
    release() { released = true; } };
  const store = new PostgresSchedulerStore({ async connect() { return client; } });
  assert.equal(await store.assignJob('job-1', 'worker-1'), true);
  assert.match(queries[1].sql, /WHERE id = \$1 AND status = 'queued'/);
  assert.deepEqual(queries[1].values, ['job-1', 'worker-1']);
  assert.match(queries[2].sql, /current_load = current_load \+ 1/);
  assert.equal(queries[3].sql, 'COMMIT');
  assert.equal(released, true);
});

test('lost assignment race rolls back without incrementing worker load', async () => {
  const statements = [];
  const client = { async query(sql) { statements.push(sql); return { rowCount: 0 }; }, release() {} };
  const store = new PostgresSchedulerStore({ async connect() { return client; } });
  assert.equal(await store.assignJob('claimed-job', 'worker-1'), false);
  assert.equal(statements.length, 3);
  assert.equal(statements[2], 'ROLLBACK');
});
