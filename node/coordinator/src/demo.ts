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

  constructor(private readonly now: () => number) {}

  allow(): boolean {
    const current = this.now();
    this.timestamps = this.timestamps.filter((time) => current - time < 60 * 60 * 1000);
    const last = this.timestamps.at(-1);
    if (this.timestamps.length >= 24 || (last !== undefined && current - last < 3000)) {
      return false;
    }
    this.timestamps.push(current);
    return true;
  }
}
