import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { finished, pipeline } from 'node:stream/promises';
import tar from 'tar-stream';

async function listFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) files.push(path);
    }
  }
  await visit(root);
  return files.sort();
}

export class ArtifactUploader {
  constructor(private readonly client: S3Client, private readonly bucket: string) {}

  /** Stores a job's combined stdout/stderr so it can be read through the coordinator. */
  async uploadLogs(jobID: string, logsPath: string): Promise<string> {
    const body = await readFile(logsPath);
    const key = `logs/${jobID}.txt`;
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket, Key: key, Body: body,
      ContentLength: body.length, ContentType: 'text/plain; charset=utf-8',
    }));
    return key;
  }

  async uploadArtifacts(jobID: string, directory: string): Promise<string | null> {
    const files = await listFiles(directory);
    if (!files.length) return null;
    const tempDir = await mkdtemp(join(tmpdir(), 'foreman-artifacts-'));
    const tarPath = join(tempDir, 'artifacts.tar');
    try {
      const pack = tar.pack();
      const output = createWriteStream(tarPath);
      pack.pipe(output);
      for (const file of files) {
        const info = await stat(file);
        const entry = pack.entry({
          name: relative(directory, file).split(sep).join('/'),
          size: info.size,
          mode: info.mode & 0o777,
          mtime: info.mtime,
        });
        await pipeline(createReadStream(file), entry);
      }
      pack.finalize();
      await finished(output);
      const size = (await stat(tarPath)).size;
      const key = `artifacts/${jobID}.tar`;
      await this.client.send(new PutObjectCommand({
        Bucket: this.bucket, Key: key, Body: createReadStream(tarPath),
        ContentLength: size, ContentType: 'application/x-tar',
      }));
      return key;
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }
}

export function createArtifactUploader(env: NodeJS.ProcessEnv): ArtifactUploader | null {
  if (!env.MINIO_ENDPOINT) return null;
  const endpoint = /^https?:\/\//.test(env.MINIO_ENDPOINT)
    ? env.MINIO_ENDPOINT
    : `${env.MINIO_USE_SSL === 'true' ? 'https' : 'http'}://${env.MINIO_ENDPOINT}`;
  const client = new S3Client({
    endpoint, region: 'us-east-1', forcePathStyle: true,
    credentials: {
      accessKeyId: env.MINIO_ACCESS_KEY ?? 'minioadmin',
      secretAccessKey: env.MINIO_SECRET_KEY ?? 'minioadmin',
    },
  });
  return new ArtifactUploader(client, env.MINIO_BUCKET ?? 'foreman-artifacts');
}
