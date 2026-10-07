import Docker from 'dockerode';
import { createWriteStream } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import tar from 'tar-stream';
import type { Job } from './client.js';
import { log } from './log.js';

export interface ExecutionResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  logsPath: string;
  artifactDir: string;
  durationMs: number;
  timedOut: boolean;
  cancelled: boolean;
}

export interface ExecutorOptions {
  /** Docker network for job containers; 'none' (the default) gives jobs no network access. */
  network?: string;
}

const jobLabel = 'foreman.job';
const deadlineLabel = 'foreman.deadline';
const maxLogChars = 512 * 1024;

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

function keepTail(text: string): string {
  return text.length > maxLogChars ? `[earlier output truncated]\n${text.slice(-maxLogChars)}` : text;
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
  private readonly containers = new Map<string, Docker.Container>();
  private readonly cancelRequests = new Set<string>();
  private readonly network: string;

  constructor(private readonly docker: Docker,
    private readonly dataDir = resolve(tmpdir(), 'foreman'), options: ExecutorOptions = {}) {
    this.network = options.network ?? 'none';
  }

  async ping(): Promise<void> { await this.docker.ping(); }

  private async ensureImage(image: string): Promise<void> {
    try { await this.docker.getImage(image).inspect(); return; }
    catch { /* Pull images missing from the daemon. */ }
    const stream = await this.docker.pull(image);
    for await (const _chunk of stream) { /* Drain until pull completes. */ }
  }

  /** Stops a running job's container. Returns false if this worker is not running that job. */
  async cancel(jobID: string): Promise<boolean> {
    const container = this.containers.get(jobID);
    if (!container) return false;
    this.cancelRequests.add(jobID);
    await container.kill().catch((error: unknown) => log.warn('failed to kill container', { jobID, error }));
    return true;
  }

  /** Removes job containers left behind past their deadline, e.g. by a worker that crashed. */
  async reapExpired(): Promise<number> {
    const containers = await this.docker.listContainers({ all: true, filters: { label: [jobLabel] } });
    let removed = 0;
    for (const info of containers) {
      const deadline = Number(info.Labels?.[deadlineLabel]);
      if (!Number.isFinite(deadline) || deadline >= Date.now()) continue;
      await this.docker.getContainer(info.Id).remove({ force: true, v: true })
        .then(() => { removed += 1; })
        .catch((error: unknown) => log.warn('failed to reap container', { id: info.Id, error }));
    }
    if (removed) log.info('reaped expired job containers', { removed });
    return removed;
  }

  /** Deletes a finished job's local files; logs stay when they were not uploaded anywhere. */
  async cleanup(jobID: string, keepLogs: boolean): Promise<void> {
    await rm(join(this.dataDir, 'artifacts', jobID), { recursive: true, force: true });
    if (!keepLogs) await rm(join(this.dataDir, 'jobs', jobID), { recursive: true, force: true });
  }

  async run(job: Job): Promise<ExecutionResult> {
    await this.ensureImage(job.image_name);
    const artifactDir = join(this.dataDir, 'artifacts', job.id);
    await mkdir(artifactDir, { recursive: true });
    const container = await this.docker.createContainer({
      Image: job.image_name,
      Cmd: ['sh', '-c', job.command],
      Volumes: { '/output': {} },
      Labels: {
        [jobLabel]: job.id,
        // Anything still around a minute past its timeout is an orphan.
        [deadlineLabel]: String(Date.now() + (Math.max(1, job.timeout_seconds) + 60) * 1000),
      },
      HostConfig: {
        Memory: job.required_memory * 1024 * 1024,
        NanoCpus: job.required_cpu * 1_000_000_000,
        NetworkMode: this.network,
        PidsLimit: 512,
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges'],
        ReadonlyRootfs: true,
        Tmpfs: { '/tmp': 'rw,size=64m' },
        // Bounds the daemon's copy of a chatty job's output, which is also what we read back.
        LogConfig: { Type: 'json-file', Config: { 'max-size': '1m', 'max-file': '1' } },
      },
    });
    this.containers.set(job.id, container);
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
      const cancelled = this.cancelRequests.delete(job.id);
      const durationMs = Date.now() - started;
      let logs = { stdout: '', stderr: '' };
      try {
        const raw = demuxDockerLogs(await container.logs({ stdout: true, stderr: true, tail: 10000 }));
        logs = { stdout: keepTail(raw.stdout), stderr: keepTail(raw.stderr) };
      } catch (error) { log.warn('failed to collect container logs', { jobID: job.id, error }); }
      try { await extractDockerArchive(await container.getArchive({ path: '/output' }), artifactDir); }
      catch (error) { log.warn('failed to collect container output', { jobID: job.id, error }); }
      const logsDir = join(this.dataDir, 'jobs', job.id);
      await mkdir(logsDir, { recursive: true });
      const logsPath = join(logsDir, 'logs.txt');
      await writeFile(logsPath, `=== STDOUT ===\n${logs.stdout}\n\n=== STDERR ===\n${logs.stderr}\n`);
      return { ...outcome, ...logs, logsPath, artifactDir, durationMs, cancelled };
    } finally {
      if (timer) clearTimeout(timer);
      this.containers.delete(job.id);
      this.cancelRequests.delete(job.id);
      await container.remove({ force: true, v: true }).catch((error: unknown) =>
        log.warn('failed to remove container', { jobID: job.id, error }));
    }
  }
}

export function createDockerExecutor(): DockerExecutor {
  return new DockerExecutor(new Docker(),
    process.env.FOREMAN_DATA_DIR ?? resolve(tmpdir(), 'foreman'),
    { network: process.env.WORKER_JOB_NETWORK ?? 'none' });
}
