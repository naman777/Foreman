import pg from 'pg';
import { log } from './log.js';
import type { Job } from './types.js';

const channel = 'foreman_jobs';

/**
 * Subscribes to PostgreSQL NOTIFY for job status changes (see migration 000003).
 * Every coordinator hears every change, wherever it was made: another coordinator,
 * the scheduler, the monitor, or a worker request handled elsewhere.
 */
export class JobEventListener {
  private client: pg.Client | null = null;
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;

  constructor(private readonly connectionString: string,
    private readonly getJob: (id: string) => Promise<Job | null>,
    private readonly onJob: (job: Job) => void) {}

  async start(): Promise<void> {
    await this.connect();
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const client = new pg.Client({ connectionString: this.connectionString });
    client.on('notification', (message) => {
      if (message.channel !== channel || !message.payload) return;
      this.getJob(message.payload)
        .then((job) => { if (job) this.onJob(job); })
        .catch((error) => log.warn('failed to load notified job', { error }));
    });
    const lost = (error?: Error): void => {
      if (this.client !== client) return;
      this.client = null;
      client.removeAllListeners();
      client.end().catch(() => {});
      if (error) log.warn('job event listener lost its connection', { error });
      if (!this.stopped) this.timer = setTimeout(() => void this.retry(), 2000);
    };
    client.on('error', lost);
    client.on('end', () => lost());
    await client.connect();
    this.client = client;
    await client.query(`LISTEN ${channel}`);
  }

  private async retry(): Promise<void> {
    try { await this.connect(); }
    catch (error) {
      log.warn('job event listener reconnect failed', { error });
      if (!this.stopped) this.timer = setTimeout(() => void this.retry(), 2000);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    const client = this.client;
    this.client = null;
    await client?.end().catch(() => {});
  }
}
