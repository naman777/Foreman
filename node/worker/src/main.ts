import { pathToFileURL } from 'node:url';
import { CoordinatorClient } from './client.js';
import { createDockerExecutor } from './executor.js';
import { log } from './log.js';
import { parseLabels, WorkerRuntime } from './runtime.js';
import { createArtifactUploader } from './uploader.js';

function required(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`${key} is required`);
  return value;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const executor = createDockerExecutor();
  try {
    await executor.ping();
    const runtime = new WorkerRuntime(
      new CoordinatorClient(required('COORDINATOR_URL'), required('COORDINATOR_SECRET')),
      executor, createArtifactUploader(process.env),
      {
        cpuCores: Number(process.env.WORKER_CPU_CORES ?? 2),
        memoryMB: Number(process.env.WORKER_MEMORY_MB ?? 1024),
        maxParallel: Number(process.env.WORKER_MAX_PARALLEL_JOBS ?? 4),
        labels: parseLabels(process.env.WORKER_LABELS),
      },
    );
    await runtime.start();
    log.info('worker registered and polling');
    // Job containers outlive a crashed worker, so every worker sweeps expired ones.
    const sweep = () => void executor.reapExpired().catch((error) => log.warn('container sweep failed', { error }));
    sweep();
    const sweepTimer = setInterval(sweep, 30_000);
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      process.once(signal, () => {
        clearInterval(sweepTimer);
        void runtime.stop().then(() => process.exit(0));
      });
    }
  } catch (error) {
    log.error('worker startup failed', { error });
    process.exitCode = 1;
  }
}
