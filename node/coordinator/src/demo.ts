export const demoScenarios = {
  artifact: {
    name: 'Demo · successful artifact',
    command: 'mkdir -p /output; printf "Foreman ran this job on a worker.\\n" > /output/result.txt',
    timeoutSeconds: 15, maxRetries: 0, priority: 5,
  },
  failure: {
    name: 'Demo · failure handling',
    command: 'exit 7',
    timeoutSeconds: 15, maxRetries: 0, priority: 5,
  },
  timeout: {
    name: 'Demo · timeout handling',
    command: 'sleep 8',
    timeoutSeconds: 2, maxRetries: 0, priority: 5,
  },
  retry: {
    name: 'Demo · retry handling',
    command: 'exit 7',
    timeoutSeconds: 15, maxRetries: 1, priority: 5,
  },
  priority: {
    name: 'Demo · priority scheduling',
    command: 'sleep 2; mkdir -p /output; echo "High-priority job finished" > /output/result.txt',
    timeoutSeconds: 15, maxRetries: 0, priority: 9,
  },
} as const;

export type DemoScenario = keyof typeof demoScenarios;

export function isDemoJob(job: { name: string | null; image_name: string; command: string }): boolean {
  return job.image_name === 'alpine:3.20' &&
    Object.values(demoScenarios).some((scenario) =>
      scenario.name === job.name && scenario.command === job.command);
}

export function isDemoScenario(value: unknown): value is DemoScenario {
  return typeof value === 'string' && Object.hasOwn(demoScenarios, value);
}

export class DemoLimiter {
  private timestamps: number[] = [];
  private readonly perIp = new Map<string, number[]>();

  constructor(private readonly now: () => number,
    private readonly perIpPerHour = 8, private readonly globalPerHour = 24) {}

  /** Allows one submission per 3s overall, a global hourly cap, and a per-visitor hourly cap. */
  allow(visitor = 'anonymous'): boolean {
    const current = this.now();
    const fresh = (time: number) => current - time < 60 * 60 * 1000;
    this.timestamps = this.timestamps.filter(fresh);
    for (const [key, times] of this.perIp) {
      const kept = times.filter(fresh);
      if (kept.length) this.perIp.set(key, kept); else this.perIp.delete(key);
    }
    const last = this.timestamps.at(-1);
    const own = this.perIp.get(visitor) ?? [];
    if (this.timestamps.length >= this.globalPerHour || own.length >= this.perIpPerHour ||
        (last !== undefined && current - last < 3000)) {
      return false;
    }
    this.timestamps.push(current);
    this.perIp.set(visitor, [...own, current]);
    return true;
  }
}
