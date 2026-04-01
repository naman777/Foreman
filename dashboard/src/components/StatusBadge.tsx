import type { JobStatus, WorkerStatus } from "@/lib/types";

const JOB: Record<JobStatus, string> = {
  queued:    "bg-amber-100 text-amber-800",
  scheduled: "bg-blue-100 text-blue-700",
  running:   "bg-indigo-100 text-indigo-800",
  completed: "bg-green-100 text-green-800",
  failed:    "bg-red-100 text-red-800",
  retrying:  "bg-orange-100 text-orange-800",
  timed_out: "bg-red-50 text-red-600",
  cancelled: "bg-zinc-100 text-zinc-500",
};

const WORKER: Record<WorkerStatus, string> = {
  online:    "bg-green-100 text-green-800",
  busy:      "bg-blue-100 text-blue-800",
  unhealthy: "bg-orange-100 text-orange-800",
  offline:   "bg-zinc-100 text-zinc-500",
};

export function JobStatusBadge({ status }: { status: JobStatus }) {
  return (
    <span className={`inline-flex rounded px-2 py-0.5 text-xs font-medium ${JOB[status] ?? "bg-zinc-100 text-zinc-500"}`}>
      {status.replace("_", " ")}
    </span>
  );
}

export function WorkerStatusBadge({ status }: { status: WorkerStatus }) {
  return (
    <span className={`inline-flex rounded px-2 py-0.5 text-xs font-medium ${WORKER[status] ?? "bg-zinc-100 text-zinc-500"}`}>
      {status}
    </span>
  );
}
