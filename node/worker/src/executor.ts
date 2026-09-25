import Docker from 'dockerode';
import { createWriteStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import tar from 'tar-stream';
import type { Job } from './client.js';

export interface ExecutionResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  logsPath: string;
  artifactDir: string;
  durationMs: number;
  timedOut: boolean;
}

export function demuxDockerLogs(buffer: Buffer): { stdout: string; stderr: string } {
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let offset = 0;
  while (offset + 8 <= buffer.length) {
    const stream = buffer[offset];
    const length = buffer.readUInt32BE(offset + 4);
    if (offset + 8 + length > buffer.length) break;
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (stream === 1) stdout.push(data);
    if (stream === 2) stderr.push(data);
    offset += 8 + length;
  }
  return { stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() };
}

export async function extractDockerArchive(archive: NodeJS.ReadableStream, destination: string): Promise<void> {
  const extract = tar.extract();
  archive.pipe(extract);
  const root = resolve(destination);
  for await (const entry of extract) {
    const name = entry.header.name.replace(/^\.\//, '').replace(/^output(?:\/|$)/, '');
    const target = resolve(root, name);
    if (!name || target !== root && !target.startsWith(root + sep)) {
      entry.resume();
      continue;
    }
    if (entry.header.type === 'directory') {
      await mkdir(target, { recursive: true });
      entry.resume();
    } else if (entry.header.type === 'file') {
      await mkdir(resolve(target, '..'), { recursive: true });
      await pipeline(entry, createWriteStream(target));
    } else {
      entry.resume();
    }
  }
}

export class DockerExecutor {
  constructor(private readonly docker: Docker,
    private readonly dataDir = resolve(tmpdir(), 'foreman')) {}

  async ping(): Promise<void> { await this.docker.ping(); }

  private async ensureImage(image: string): Promise<void> {
    try { await this.docker.getImage(image).inspect(); return; }
    catch { /* Pull images missing from the daemon. */ }
    const stream = await this.docker.pull(image);
    for await (const _chunk of stream) { /* Drain until pull completes. */ }
  }

  async run(job: Job): Promise<ExecutionResult> {
    await this.ensureImage(job.image_name);
    const artifactDir = join(this.dataDir, 'artifacts', job.id);
    await mkdir(artifactDir, { recursive: true });
    const container = await this.docker.createContainer({
      Image: job.image_name,
      Cmd: ['sh', '-c', job.command],
      Volumes: { '/output': {} },
      HostConfig: {
        Memory: job.required_memory * 1024 * 1024,
        NanoCpus: job.required_cpu * 1_000_000_000,
      },
    });
    const started = Date.now();
    let timer: NodeJS.Timeout | undefined;
    try {
      await container.start();
      const wait = container.wait();
      const outcome = await Promise.race([
        wait.then((value) => ({ timedOut: false, exitCode: value.StatusCode as number })),
        new Promise<{ timedOut: boolean; exitCode: number }>((resolveTimeout) => {
          timer = setTimeout(() => resolveTimeout({ timedOut: true, exitCode: -1 }),
            Math.max(1, job.timeout_seconds) * 1000);
        }),
      ]);
      if (outcome.timedOut) {
        try { await container.stop({ t: 10 }); }
        catch { await container.kill().catch(() => {}); }
      }
      const durationMs = Date.now() - started;
      let logs = { stdout: '', stderr: '' };
      try { logs = demuxDockerLogs(await container.logs({ stdout: true, stderr: true })); }
      catch (error) { console.warn('failed to collect container logs', job.id, error); }
      try { await extractDockerArchive(await container.getArchive({ path: '/output' }), artifactDir); }
      catch (error) { console.warn('failed to collect container output', job.id, error); }
      const logsDir = join(this.dataDir, 'jobs', job.id);
      await mkdir(logsDir, { recursive: true });
      const logsPath = join(logsDir, 'logs.txt');
      await writeFile(logsPath, `=== STDOUT ===\n${logs.stdout}\n\n=== STDERR ===\n${logs.stderr}\n`);
      return { ...outcome, ...logs, logsPath, artifactDir, durationMs };
    } finally {
      if (timer) clearTimeout(timer);
      await container.remove({ force: true, v: true }).catch((error: unknown) =>
        console.warn('failed to remove container', job.id, error));
    }
  }
}

export function createDockerExecutor(): DockerExecutor {
  return new DockerExecutor(new Docker(),
    process.env.FOREMAN_DATA_DIR ?? resolve(tmpdir(), 'foreman'));
}
