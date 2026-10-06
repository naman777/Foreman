import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import tar from 'tar-stream';
import { DockerExecutor, demuxDockerLogs, extractDockerArchive } from '../dist/executor.js';

const frame = (stream, text) => {
  const body = Buffer.from(text);
  const header = Buffer.alloc(8);
  header[0] = stream;
  header.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
};
const job = { id: 'job-1', image_name: 'alpine', command: 'echo hi',
  required_cpu: 2, required_memory: 256, timeout_seconds: 5 };

async function archive(name, content) {
  const pack = tar.pack();
  pack.entry({ name }, content);
  pack.finalize();
  const chunks = [];
  for await (const chunk of pack) chunks.push(chunk);
  return Buffer.concat(chunks);
}

test('Docker log multiplexing separates stdout and stderr', () => {
  assert.deepEqual(demuxDockerLogs(Buffer.concat([frame(1, 'hello'), frame(2, 'warning')])),
    { stdout: 'hello', stderr: 'warning' });
});

test('executor applies limits, captures logs, and removes container', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'foreman-worker-test-'));
  const calls = [];
  const outputArchive = await archive('output/answer.txt', '42');
  const container = {
    async start() { calls.push('start'); },
    async wait() { return { StatusCode: 0 }; },
    async logs() { return Buffer.concat([frame(1, 'hello'), frame(2, 'warning')]); },
    async getArchive() { return Readable.from(outputArchive); },
    async remove(options) { calls.push(['remove', options]); },
  };
  const docker = {
    getImage() { return { async inspect() {} }; },
    async createContainer(options) { calls.push(['create', options]); return container; },
  };
  try {
    const result = await new DockerExecutor(docker, dir).run(job);
    assert.equal(result.exitCode, 0);
    assert.equal(result.timedOut, false);
    assert.equal(result.stdout, 'hello');
    assert.equal(result.stderr, 'warning');
    assert.equal(await readFile(result.logsPath, 'utf8'),
      '=== STDOUT ===\nhello\n\n=== STDERR ===\nwarning\n');
    assert.equal(await readFile(join(result.artifactDir, 'answer.txt'), 'utf8'), '42');
    assert.equal(calls[0][1].HostConfig.Memory, 256 * 1024 * 1024);
    assert.equal(calls[0][1].HostConfig.NanoCpus, 2_000_000_000);
    assert.deepEqual(calls[0][1].Volumes, { '/output': {} });
    const host = calls[0][1].HostConfig;
    assert.equal(host.NetworkMode, 'none');
    assert.deepEqual(host.CapDrop, ['ALL']);
    assert.deepEqual(host.SecurityOpt, ['no-new-privileges']);
    assert.equal(host.ReadonlyRootfs, true);
    assert.equal(host.PidsLimit, 512);
    assert.equal(host.LogConfig.Config['max-size'], '1m');
    assert.equal(calls[0][1].Labels['foreman.job'], 'job-1');
    assert.ok(Number(calls[0][1].Labels['foreman.deadline']) > Date.now());
    assert.deepEqual(calls.at(-1), ['remove', { force: true, v: true }]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('executor stops a timed-out container', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'foreman-worker-test-'));
  let stopped = false;
  let removed = false;
  const docker = {
    getImage() { return { async inspect() {} }; },
    async createContainer() { return {
      async start() {}, async wait() { return new Promise(() => {}); },
      async stop() { stopped = true; },
      async logs() { return Buffer.alloc(0); },
      async getArchive() { return Readable.from(await archive('output/', '')); },
      async remove() { removed = true; },
    }; },
  };
  try {
    const result = await new DockerExecutor(docker, dir).run({ ...job, timeout_seconds: 0.001 });
    assert.equal(result.timedOut, true);
    assert.equal(result.exitCode, -1);
    assert.equal(stopped, true);
    assert.equal(removed, true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('job network is configurable and cancel kills the running container', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'foreman-worker-test-'));
  let created;
  let killed = false;
  let finish;
  const docker = {
    getImage() { return { async inspect() {} }; },
    async createContainer(options) {
      created = options;
      return {
        async start() {},
        wait() { return new Promise((resolve) => { finish = () => resolve({ StatusCode: 137 }); }); },
        async kill() { killed = true; finish(); },
        async logs() { return Buffer.alloc(0); },
        async getArchive() { return Readable.from(await archive('output/', '')); },
        async remove() {},
      };
    },
  };
  try {
    const executor = new DockerExecutor(docker, dir, { network: 'bridge' });
    const running = executor.run(job);
    while (!finish) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(await executor.cancel('missing'), false);
    assert.equal(await executor.cancel('job-1'), true);
    const result = await running;
    assert.equal(created.HostConfig.NetworkMode, 'bridge');
    assert.equal(killed, true);
    assert.equal(result.cancelled, true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('executor keeps only the tail of very long logs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'foreman-worker-test-'));
  const big = 'x'.repeat(600 * 1024);
  const docker = {
    getImage() { return { async inspect() {} }; },
    async createContainer() { return {
      async start() {}, async wait() { return { StatusCode: 0 }; },
      async logs() { return frame(1, big); },
      async getArchive() { return Readable.from(await archive('output/', '')); },
      async remove() {},
    }; },
  };
  try {
    const result = await new DockerExecutor(docker, dir).run(job);
    assert.ok(result.stdout.length < 520 * 1024);
    assert.match(result.stdout, /^\[earlier output truncated\]/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('reaper removes only containers past their deadline, and cleanup deletes local files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'foreman-worker-test-'));
  const removed = [];
  const docker = {
    async listContainers(options) {
      assert.deepEqual(options.filters, { label: ['foreman.job'] });
      return [
        { Id: 'old', Labels: { 'foreman.deadline': String(Date.now() - 1000) } },
        { Id: 'live', Labels: { 'foreman.deadline': String(Date.now() + 60_000) } },
        { Id: 'unlabelled', Labels: {} },
      ];
    },
    getContainer(id) { return { async remove(options) { removed.push([id, options]); } }; },
  };
  try {
    const executor = new DockerExecutor(docker, dir);
    assert.equal(await executor.reapExpired(), 1);
    assert.deepEqual(removed, [['old', { force: true, v: true }]]);
    await mkdir(join(dir, 'artifacts', 'job-1'), { recursive: true });
    await mkdir(join(dir, 'jobs', 'job-1'), { recursive: true });
    await executor.cleanup('job-1', true);
    await assert.rejects(stat(join(dir, 'artifacts', 'job-1')));
    await stat(join(dir, 'jobs', 'job-1'));
    await executor.cleanup('job-1', false);
    await assert.rejects(stat(join(dir, 'jobs', 'job-1')));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('artifact extraction ignores paths outside output', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'foreman-worker-test-'));
  try {
    await extractDockerArchive(Readable.from(await archive('../escape.txt', 'bad')), dir);
    await assert.rejects(readFile(join(dir, 'escape.txt')));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
