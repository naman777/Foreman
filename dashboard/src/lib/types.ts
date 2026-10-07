import type { Worker as ApiWorker } from "./shared";

export type {
  Job,
  JobEvent,
  JobStatus,
  MetricsSummary,
  WorkerStatus,
  WSEvent,
} from "./shared";

// The public demo API reports fleet capacity but not worker labels.
export type Worker = Omit<ApiWorker, "labels">;
