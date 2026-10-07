import { CreateBucketCommand, GetObjectCommand, HeadBucketCommand, PutBucketLifecycleConfigurationCommand,
  S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { log } from './log.js';
import type { ArtifactStore } from './types.js';

export class S3ArtifactStore implements ArtifactStore {
  constructor(private readonly client: S3Client, private readonly bucket: string,
    private readonly presignClient: S3Client = client) {}

  async ensureBucket(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status !== 404) throw error;
      await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
    }
  }

  /** Expires stored artifacts and logs; best effort because not every S3 clone supports lifecycle rules. */
  async setRetention(days: number): Promise<void> {
    try {
      await this.client.send(new PutBucketLifecycleConfigurationCommand({
        Bucket: this.bucket,
        LifecycleConfiguration: { Rules: [{
          ID: 'foreman-retention', Status: 'Enabled', Filter: { Prefix: '' },
          Expiration: { Days: days },
        }] },
      }));
    } catch (error) {
      log.warn('bucket retention rule not applied', { error });
    }
  }

  /** Reads at most the last `maxBytes` of an object as text. */
  async getText(objectKey: string, maxBytes: number): Promise<string> {
    const read = async (range?: string): Promise<string> => {
      const response = await this.client.send(new GetObjectCommand({
        Bucket: this.bucket, Key: objectKey, ...(range ? { Range: range } : {}) }));
      return (await response.Body?.transformToString()) ?? '';
    };
    try { return await read(`bytes=-${maxBytes}`); }
    catch (error) {
      // Not every S3-compatible store supports suffix ranges; logs are capped at write time anyway.
      const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status === 404) throw error;
      return (await read()).slice(-maxBytes);
    }
  }

  async getPresignedURL(objectKey: string): Promise<string> {
    return getSignedUrl(this.presignClient,
      new GetObjectCommand({ Bucket: this.bucket, Key: objectKey }),
      { expiresIn: 3600 });
  }
}

export async function createArtifactStore(env: NodeJS.ProcessEnv): Promise<S3ArtifactStore | undefined> {
  if (!env.MINIO_ENDPOINT) return undefined;
  const endpoint = (value: string): string => /^https?:\/\//.test(value)
    ? value : `${env.MINIO_USE_SSL === 'true' ? 'https' : 'http'}://${value}`;
  const config = {
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: {
      accessKeyId: env.MINIO_ACCESS_KEY ?? 'minioadmin',
      secretAccessKey: env.MINIO_SECRET_KEY ?? 'minioadmin',
    },
  };
  const client = new S3Client({ ...config, endpoint: endpoint(env.MINIO_ENDPOINT) });
  const publicClient = env.MINIO_PUBLIC_ENDPOINT
    ? new S3Client({ ...config, endpoint: endpoint(env.MINIO_PUBLIC_ENDPOINT) }) : client;
  const store = new S3ArtifactStore(client, env.MINIO_BUCKET ?? 'foreman-artifacts', publicClient);
  try {
    await store.ensureBucket();
    const days = Number(env.RETENTION_DAYS ?? 30);
    if (Number.isInteger(days) && days > 0) await store.setRetention(days);
    return store;
  } catch (error) {
    client.destroy();
    if (publicClient !== client) publicClient.destroy();
    log.warn('artifact storage unavailable', { error });
    return undefined;
  }
}
