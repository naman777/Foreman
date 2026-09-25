import type { RedisClientType } from 'redis';
import type { JobLocker } from './scheduler.js';

export class RedisJobLocker implements JobLocker {
  constructor(private readonly client: RedisClientType) {}

  async lock(jobID: string, owner: string): Promise<boolean> {
    return await this.client.set(`scheduler:job:${jobID}`, owner, { NX: true, EX: 30 }) === 'OK';
  }
}
