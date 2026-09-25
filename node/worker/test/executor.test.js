import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
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

test('artifact extraction ignores paths outside output', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'foreman-worker-test-'));
  try {
    await extractDockerArchive(Readable.from(await archive('../escape.txt', 'bad')), dir);
    await assert.rejects(readFile(join(dir, 'escape.txt')));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
