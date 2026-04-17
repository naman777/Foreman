import type { JobStatus, WorkerStatus } from "@/lib/types";

const JOB_STYLES: Record<JobStatus, { bg: string; text: string; dot: string }> = {
  queued: { bg: "rgba(245, 158, 11, 0.1)", text: "#fbbf24", dot: "#f59e0b" },
  scheduled: { bg: "rgba(59, 130, 246, 0.1)", text: "#60a5fa", dot: "#3b82f6" },
  running: { bg: "rgba(99, 102, 241, 0.1)", text: "#a5b4fc", dot: "#818cf8" },
  completed: { bg: "rgba(16, 185, 129, 0.1)", text: "#6ee7b7", dot: "#10b981" },
  failed: { bg: "rgba(239, 68, 68, 0.1)", text: "#fca5a5", dot: "#ef4444" },
  retrying: { bg: "rgba(249, 115, 22, 0.1)", text: "#fdba74", dot: "#f97316" },
  timed_out: { bg: "rgba(220, 38, 38, 0.1)", text: "#fca5a5", dot: "#dc2626" },
  cancelled: { bg: "rgba(100, 116, 139, 0.1)", text: "#94a3b8", dot: "#64748b" },
};

const WORKER_STYLES: Record<WorkerStatus, { bg: string; text: string; dot: string }> = {
  online: { bg: "rgba(16, 185, 129, 0.1)", text: "#6ee7b7", dot: "#10b981" },
  busy: { bg: "rgba(59, 130, 246, 0.1)", text: "#60a5fa", dot: "#3b82f6" },
  unhealthy: { bg: "rgba(249, 115, 22, 0.1)", text: "#fdba74", dot: "#f97316" },
  offline: { bg: "rgba(100, 116, 139, 0.1)", text: "#94a3b8", dot: "#64748b" },
};

export function JobStatusBadge({ status }: { status: JobStatus }) {
  const s = JOB_STYLES[status] ?? JOB_STYLES.cancelled;
  const isPulsing = status === "running" || status === "queued" || status === "retrying";

  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium"
      style={{
        background: s.bg,
        color: s.text,
        border: `1px solid ${s.bg}`,
      }}
    >
      <span
        className={`status-dot ${isPulsing ? "status-dot-pulse" : ""}`}
        style={{ background: s.dot, boxShadow: `0 0 6px ${s.dot}50` }}
      />
      {status.replace("_", " ")}
    </span>
  );
}

export function WorkerStatusBadge({ status }: { status: WorkerStatus }) {
  const s = WORKER_STYLES[status] ?? WORKER_STYLES.offline;
  const isPulsing = status === "online" || status === "busy";

  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium"
      style={{
        background: s.bg,
        color: s.text,
        border: `1px solid ${s.bg}`,
      }}
    >
      <span
        className={`status-dot ${isPulsing ? "status-dot-pulse" : ""}`}
        style={{ background: s.dot, boxShadow: `0 0 6px ${s.dot}50` }}
      />
      {status}
    </span>
  );
}
