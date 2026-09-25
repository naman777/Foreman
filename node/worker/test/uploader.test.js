import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import tar from 'tar-stream';
import { ArtifactUploader } from '../dist/uploader.js';

test('uploader skips empty output directories', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'foreman-upload-test-'));
  let sent = false;
  try {
    const uploader = new ArtifactUploader({ async send() { sent = true; } }, 'bucket');
    assert.equal(await uploader.uploadArtifacts('job-1', dir), null);
    assert.equal(sent, false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('uploader packs nested files and uses the Go object key', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'foreman-upload-test-'));
  await mkdir(join(dir, 'nested'));
  await writeFile(join(dir, 'nested', 'answer.txt'), '42');
  let command;
  let tarBytes;
  const client = { async send(value) {
    command = value;
    const chunks = [];
    for await (const chunk of value.input.Body) chunks.push(chunk);
    tarBytes = Buffer.concat(chunks);
  } };
  try {
    const key = await new ArtifactUploader(client, 'bucket').uploadArtifacts('job-1', dir);
    assert.equal(key, 'artifacts/job-1.tar');
    assert.equal(command.input.Bucket, 'bucket');
    assert.equal(command.input.Key, key);
    assert.equal(command.input.ContentType, 'application/x-tar');
    assert.equal(command.input.ContentLength, tarBytes.length);
    const extract = tar.extract();
    extract.end(tarBytes);
    const entries = [];
    for await (const entry of extract) {
      const chunks = [];
      for await (const chunk of entry) chunks.push(chunk);
      entries.push([entry.header.name, Buffer.concat(chunks).toString()]);
    }
    assert.deepEqual(entries, [['nested/answer.txt', '42']]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
