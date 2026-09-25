import { pathToFileURL } from 'node:url';
import { CoordinatorClient } from './client.js';
import { createDockerExecutor } from './executor.js';
import { WorkerRuntime } from './runtime.js';
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
      },
    );
    await runtime.start();
    console.log('worker registered and polling');
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      process.once(signal, () => { void runtime.stop(); });
    }
  } catch (error) {
    console.error('worker startup failed', error);
    process.exitCode = 1;
  }
}
