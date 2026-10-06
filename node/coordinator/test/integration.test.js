// Runs the real SQL against PostgreSQL. Set FOREMAN_TEST_DATABASE_URL to an empty,
// disposable database: the test drops and recreates its public schema.
// FOREMAN_TEST_EMBEDDED=1 adapts the run for embedded Postgres (PGlite): it skips contrib
// extensions and the cross-connection NOTIFY test, which PGlite's connection multiplexer cannot deliver.
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { after, before, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { JobEventListener } from '../dist/events.js';
import { Monitor } from '../dist/monitor.js';
import { PostgresMonitorStore } from '../dist/monitor-store.js';
import { Scheduler } from '../dist/scheduler.js';
import { PostgresSchedulerStore } from '../dist/scheduler-store.js';
import { createPool, PostgresJobStore, PostgresWorkerStore } from '../dist/store.js';

const url = process.env.FOREMAN_TEST_DATABASE_URL;
const embedded = Boolean(process.env.FOREMAN_TEST_EMBEDDED);
const it = (name, fn, skipReason) => test(name, {
  skip: (!url && 'FOREMAN_TEST_DATABASE_URL is not set') || skipReason || false }, fn);

let pool;
let jobs;
let workers;
let scheduler;
const locker = { async lock() { return true; } };
const spec = (overrides = {}) => ({ name: null, imageName: 'alpine', command: 'true', requiredCPU: 1,
  requiredMemory: 128, maxRetries: 0, timeoutSeconds: 60, priority: 5, ...overrides });
const newWorker = (overrides = {}) => workers.registerWorker({ hostname: 'w', cpuCores: 4,
  memoryMB: 4096, labels: {}, tokenHash: 'hash', ...overrides });
const sql = async (text, values) => (await pool.query(text, values)).rows;
const jobRow = async (id) => (await sql('SELECT * FROM jobs WHERE id = $1', [id]))[0];
const loadOf = async (id) => (await sql('SELECT current_load FROM workers WHERE id = $1', [id]))[0].current_load;

/** Walks a job through schedule -> claim so a worker "owns" it, like production does. */
async function runOn(worker, job) {
  await scheduler.runBatch();
  const claimed = await jobs.getNextJob(worker.id);
  assert.equal(claimed?.id, job.id);
  return claimed;
}

before(async () => {
  if (!url) return;
  pool = createPool(url);
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  const dir = fileURLToPath(new URL('../../../migrations/', import.meta.url));
  for (const file of (await readdir(dir)).filter((name) => name.endsWith('.up.sql')).sort()) {
    let migration = await readFile(dir + file, 'utf8');
    // Embedded Postgres builds lack contrib extensions; gen_random_uuid() is built in since PG 13.
    if (embedded) migration = migration.replace(/CREATE EXTENSION[^;]*;/g, '');
    await pool.query(migration);
  }
  jobs = new PostgresJobStore(pool);
  workers = new PostgresWorkerStore(pool);
  scheduler = new Scheduler(new PostgresSchedulerStore(pool), locker, 4);
});
beforeEach(async () => { if (url) await pool.query('TRUNCATE jobs, workers, job_events CASCADE'); });
after(async () => { await pool?.end(); });

it('queue is ordered by priority, then age, and hides jobs in retry backoff', async () => {
  const store = new PostgresSchedulerStore(pool);
  const low = await jobs.createJob(spec({ priority: 1 }));
  const high = await jobs.createJob(spec({ priority: 9 }));
  const normalA = await jobs.createJob(spec({ priority: 5 }));
  const normalB = await jobs.createJob(spec({ priority: 5 }));
  const delayed = await jobs.createJob(spec({ priority: 10 }));
  await pool.query(`UPDATE jobs SET run_after = NOW() + INTERVAL '1 hour' WHERE id = $1`, [delayed.id]);
  const queued = await store.getQueuedJobs(10);
  assert.deepEqual(queued.map((job) => job.id), [high.id, normalA.id, normalB.id, low.id]);
});

it('scheduler places jobs by label selector and capacity, and a worker claims only its own', async () => {
  const plain = await newWorker({ hostname: 'plain' });
  const gpu = await newWorker({ hostname: 'gpu', labels: { gpu: 'true' } });
  const wantsGpu = await jobs.createJob(spec({ selector: { gpu: 'true' } }));
  const wantsNothing = await jobs.createJob(spec({ requiredCPU: 99 }));
  assert.equal(await scheduler.runBatch(), 1);
  assert.equal((await jobRow(wantsGpu.id)).worker_id, gpu.id);
  assert.equal((await jobRow(wantsNothing.id)).status, 'queued');
  assert.equal(await jobs.getNextJob(plain.id), null);
  const claimed = await jobs.getNextJob(gpu.id);
  assert.equal(claimed.status, 'running');
  assert.equal(await loadOf(gpu.id), 1);
  const done = await jobs.updateJobStatus({ jobID: claimed.id, status: 'completed', workerID: gpu.id,
    logsPath: 'logs/x.txt', artifactPath: null });
  assert.equal(done.status, 'completed');
  assert.equal(done.logs_path, 'logs/x.txt');
  assert.equal(await loadOf(gpu.id), 0);
  assert.equal(await jobs.updateJobStatus({ jobID: claimed.id, status: 'failed', workerID: gpu.id,
    logsPath: null, artifactPath: null }), null, 'a finished job cannot be reported twice');
});

it('failures and timeouts retry with exponential backoff until retries run out', async () => {
  const worker = await newWorker();
  const job = await jobs.createJob(spec({ maxRetries: 2 }));
  let claimed = await runOn(worker, job);
  let after = await jobs.updateJobStatus({ jobID: job.id, status: 'failed', workerID: worker.id,
    logsPath: null, artifactPath: null });
  assert.equal(after.status, 'queued');
  assert.equal(after.retries, 1);
  assert.equal(after.worker_id, null);
  const wait = (await sql(`SELECT EXTRACT(EPOCH FROM run_after - NOW()) AS s FROM jobs WHERE id = $1`, [job.id]))[0].s;
  assert.ok(wait > 3 && wait <= 5.5, `first retry waits about 5s, got ${wait}`);
  assert.equal(await scheduler.runBatch(), 0, 'job in backoff is not scheduled');
  await pool.query(`UPDATE jobs SET run_after = NOW() - INTERVAL '1 second' WHERE id = $1`, [job.id]);
  claimed = await runOn(worker, job);
  after = await jobs.updateJobStatus({ jobID: job.id, status: 'timed_out', workerID: worker.id,
    logsPath: null, artifactPath: null });
  assert.equal(after.status, 'queued');
  assert.equal(after.retries, 2);
  const second = (await sql(`SELECT EXTRACT(EPOCH FROM run_after - NOW()) AS s FROM jobs WHERE id = $1`, [job.id]))[0].s;
  assert.ok(second > 8 && second <= 10.5, `second retry waits about 10s, got ${second}`);
  await pool.query(`UPDATE jobs SET run_after = NULL WHERE id = $1`, [job.id]);
  claimed = await runOn(worker, job);
  after = await jobs.updateJobStatus({ jobID: job.id, status: 'failed', workerID: worker.id,
    logsPath: null, artifactPath: null });
  assert.equal(after.status, 'failed');
  assert.ok(after.completed_at);
  assert.equal(await loadOf(worker.id), 0);
});

it('heartbeats revive offline workers and a restarted worker keeps its row', async () => {
  const worker = await newWorker();
  await pool.query(`UPDATE workers SET status = 'offline', current_load = 0 WHERE id = $1`, [worker.id]);
  assert.equal(await workers.updateHeartbeat(worker.id, 2), true);
  const [revived] = await sql('SELECT status, current_load FROM workers WHERE id = $1', [worker.id]);
  assert.deepEqual(revived, { status: 'online', current_load: 2 });
  assert.equal(await workers.updateHeartbeat('123e4567-e89b-42d3-a456-426614174999', 0), false);
  const again = await newWorker({ workerID: worker.id, hostname: 'renamed', labels: { zone: 'a' } });
  assert.equal(again.id, worker.id);
  assert.equal(again.hostname, 'renamed');
  assert.equal(again.current_load, 0);
  assert.equal((await workers.listWorkers()).length, 1);
  const fresh = await newWorker();
  assert.ok(fresh.last_heartbeat, 'new workers start with a heartbeat so the monitor can age them out');
});

it('worker tokens are checked per worker and rotate on re-registration', async () => {
  const first = await newWorker({ tokenHash: 'hash-one' });
  const other = await newWorker({ tokenHash: 'hash-other' });
  assert.equal(await workers.verifyToken(first.id, 'hash-one'), true);
  assert.equal(await workers.verifyToken(first.id, 'hash-other'), false, 'another worker\'s token is useless here');
  assert.equal(await workers.verifyToken(other.id, 'hash-other'), true);
  assert.equal(await workers.verifyToken('123e4567-e89b-42d3-a456-426614174999', 'hash-one'), false);
  await newWorker({ workerID: first.id, tokenHash: 'hash-two' });
  assert.equal(await workers.verifyToken(first.id, 'hash-one'), false, 'old token is revoked');
  assert.equal(await workers.verifyToken(first.id, 'hash-two'), true);
});

it('cancel handles queued, scheduled and running jobs and the worker confirms', async () => {
  const worker = await newWorker();
  const queued = await jobs.createJob(spec());
  assert.equal((await jobs.cancelJob(queued.id)).state, 'cancelled');
  assert.equal((await jobRow(queued.id)).status, 'cancelled');

  const scheduled = await jobs.createJob(spec());
  await scheduler.runBatch();
  assert.equal(await loadOf(worker.id), 1);
  assert.equal((await jobs.cancelJob(scheduled.id)).state, 'cancelled');
  assert.equal(await loadOf(worker.id), 0);

  const running = await jobs.createJob(spec());
  await runOn(worker, running);
  assert.deepEqual(await jobs.getCancelRequests(worker.id), []);
  const requested = await jobs.cancelJob(running.id);
  assert.equal(requested.state, 'requested');
  assert.equal(requested.job.status, 'running');
  assert.deepEqual(await jobs.getCancelRequests(worker.id), [running.id]);
  const confirmed = await jobs.updateJobStatus({ jobID: running.id, status: 'cancelled',
    workerID: worker.id, logsPath: null, artifactPath: null });
  assert.equal(confirmed.status, 'cancelled');
  assert.deepEqual(await jobs.getCancelRequests(worker.id), []);
  assert.equal((await jobs.cancelJob(running.id)).state, 'finished');
  assert.equal(await jobs.cancelJob('123e4567-e89b-42d3-a456-426614174999'), null);
});

it('monitor requeues expired jobs, cancels flagged ones and marks silent workers offline', async () => {
  const worker = await newWorker();
  const retryable = await jobs.createJob(spec({ maxRetries: 1 }));
  const flagged = await jobs.createJob(spec({ maxRetries: 3 }));
  const exhausted = await jobs.createJob(spec({ maxRetries: 0 }));
  await scheduler.runBatch();
  await jobs.getNextJob(worker.id);
  await jobs.getNextJob(worker.id);
  await jobs.getNextJob(worker.id);
  await jobs.cancelJob(flagged.id);
  await pool.query(`UPDATE jobs SET lock_expires_at = NOW() - INTERVAL '1 second'`);
  const monitor = new Monitor(new PostgresMonitorStore(pool), { retentionDays: 0 });
  await monitor.runOnce();
  assert.equal((await jobRow(retryable.id)).status, 'queued');
  assert.equal((await jobRow(flagged.id)).status, 'cancelled');
  assert.equal((await jobRow(exhausted.id)).status, 'failed');
  const events = await sql('SELECT event_type FROM job_events ORDER BY event_type');
  assert.deepEqual(events.map((row) => row.event_type), ['auto_cancelled', 'auto_failed', 'auto_recovered']);

  const silent = await newWorker({ hostname: 'silent' });
  await pool.query(`UPDATE workers SET last_heartbeat = NOW() - INTERVAL '31 seconds' WHERE id = $1`, [silent.id]);
  await monitor.runOnce();
  assert.equal((await sql('SELECT status FROM workers WHERE id = $1', [silent.id]))[0].status, 'offline');
});

it('pruning drops old finished jobs and silent workers but keeps recent history', async () => {
  const stale = await newWorker({ hostname: 'stale' });
  const recent = await jobs.createJob(spec());
  await runOn(stale, recent);
  await jobs.updateJobStatus({ jobID: recent.id, status: 'completed', workerID: stale.id,
    logsPath: null, artifactPath: null });
  const ancient = await jobs.createJob(spec());
  await pool.query(`UPDATE jobs SET status = 'completed', completed_at = NOW() - INTERVAL '40 days' WHERE id = $1`, [ancient.id]);
  const pending = await jobs.createJob(spec());
  await pool.query(`UPDATE workers SET status = 'offline', last_heartbeat = NOW() - INTERVAL '2 days' WHERE id = $1`, [stale.id]);
  const removed = await new PostgresMonitorStore(pool).pruneExpired({ jobDays: 30, workerHours: 24 });
  assert.deepEqual(removed, { jobs: 1, workers: 1 });
  assert.equal(await jobRow(ancient.id), undefined);
  assert.equal((await jobRow(recent.id)).worker_id, null, 'history survives; the worker link is cleared');
  assert.equal((await jobRow(pending.id)).status, 'queued');
});

it('demo listing filters in SQL however many other jobs exist', async () => {
  const demo = await jobs.createJob(spec({ name: 'Demo · x', isDemo: true }));
  for (let i = 0; i < 5; i += 1) await jobs.createJob(spec());
  const listed = await jobs.listJobs({ status: '', workerID: null, limit: 3, offset: 0, demo: true });
  assert.deepEqual(listed.map((job) => job.id), [demo.id]);
  assert.equal((await jobs.listJobs({ status: '', workerID: null, limit: 50, offset: 0 })).length, 6);
});

it('every coordinator hears job changes through NOTIFY', async () => {
  const seen = [];
  const listener = new JobEventListener(url, (id) => jobs.getJob(id), (job) => seen.push([job.id, job.status]));
  await listener.start();
  try {
    const worker = await newWorker();
    const job = await jobs.createJob(spec());
    await scheduler.runBatch();
    await jobs.getNextJob(worker.id);
    const deadline = Date.now() + 5000;
    while (seen.length < 3 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual([...new Set(seen.map(([, status]) => status))].sort(), ['queued', 'running', 'scheduled']);
    assert.ok(seen.every(([id]) => id === job.id));
  } finally { await listener.stop(); }
}, embedded && 'embedded Postgres cannot deliver NOTIFY across connections');
