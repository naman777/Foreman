import type { JobStatus, WorkerStatus } from "@/lib/types";
import { Chip } from "@/components/ui/chip";
import { cn } from "@/lib/utils";

// Status is text and a thin outline, never a filled pill.
type Tone = "default" | "success" | "danger" | "special" | "warning";

const WARNING = "border-yellow-600/35 text-yellow-800 dark:border-yellow-400/30 dark:text-yellow-200";

const JOB_TONES: Record<JobStatus, Tone> = {
  queued: "default",
  scheduled: "default",
  running: "special",
  completed: "success",
  failed: "danger",
  retrying: "warning",
  timed_out: "danger",
  cancelled: "default",
};

const WORKER_TONES: Record<WorkerStatus, Tone> = {
  online: "success",
  busy: "special",
  unhealthy: "warning",
  offline: "default",
};

function StatusChip({ tone, live, children }: { tone: Tone; live?: boolean; children: React.ReactNode }) {
  return (
    <Chip tone={tone === "warning" ? "default" : tone} className={cn("gap-1.5 capitalize", tone === "warning" && WARNING)}>
      {live && (
        <span className="relative flex size-1.5" aria-hidden="true">
          <span className="absolute size-full rounded-full bg-current opacity-60 motion-safe:animate-ping" />
          <span className="relative size-1.5 rounded-full bg-current" />
        </span>
      )}
      {children}
    </Chip>
  );
}

export function JobStatusBadge({ status }: { status: JobStatus }) {
  return (
    <StatusChip tone={JOB_TONES[status] ?? "default"} live={status === "running"}>
      {status.replace("_", " ")}
    </StatusChip>
  );
}

export function WorkerStatusBadge({ status }: { status: WorkerStatus }) {
  return (
    <StatusChip tone={WORKER_TONES[status] ?? "default"} live={status === "busy"}>
      {status}
    </StatusChip>
  );
}
