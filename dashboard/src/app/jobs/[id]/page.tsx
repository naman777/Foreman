"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "next/navigation";
import Link from "next/link";
import { ChevronLeft, Download, Link2 } from "lucide-react";
import { api } from "@/lib/api";
import type { Job, JobEvent, JobStatus, WSEvent } from "@/lib/types";
import { JobStatusBadge } from "@/components/StatusBadge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Spinner } from "@/components/ui/spinner";
import { useToast } from "@/components/ui/toast";
import { useWebSocket } from "@/hooks/useWebSocket";
import { cn, fmt, duration } from "@/lib/utils";

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="min-w-0 space-y-1">
      <dt className="text-[11px] font-semibold tracking-[0.1em] text-muted-foreground uppercase">{label}</dt>
      <dd className="text-sm">{value ?? <span className="text-muted-foreground">-</span>}</dd>
    </div>
  );
}

// Only the outcomes carry colour, as text.
const EVENT_TONES: Record<string, string> = {
  job_completed: "text-green-700 dark:text-green-400",
  job_failed: "text-red-700 dark:text-red-400",
  job_timed_out: "text-red-700 dark:text-red-400",
  job_retrying: "text-yellow-800 dark:text-yellow-200",
};

const PANEL = "card-chai p-6";
const PANEL_TITLE = "font-montserrat text-base font-semibold";
const CODE_BLOCK = "overflow-x-auto rounded-lg border border-border bg-black/[0.03] px-3 py-2 font-mono text-xs text-muted-foreground dark:bg-white/[0.03]";

export default function JobDetailPage() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const toast = useToast();
  const [artifactUrl, setArtifactUrl] = useState<string | null>(null);
  const [artifactLoading, setArtifactLoading] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);

  const { data, isLoading } = useQuery<{ job: Job; events: JobEvent[] }>({
    queryKey: ["job", id],
    queryFn: () => api.job(id),
    refetchInterval: 5_000,
  });

  const logsKey = data?.job.logs_path ?? null;
  const logs = useQuery<string>({
    queryKey: ["job-logs", id, logsKey],
    queryFn: () => api.jobLogs(id),
    enabled: logsKey !== null,
    retry: false,
  });

  async function cancel() {
    setCancelling(true);
    setCancelError(null);
    try {
      await api.cancelJob(id);
      await qc.invalidateQueries({ queryKey: ["job", id] });
      setConfirming(false);
      toast("Cancellation requested", { tone: "success" });
    } catch (error) {
      setCancelError(error instanceof Error ? error.message : "Could not cancel the job.");
    } finally {
      setCancelling(false);
    }
  }

  useWebSocket((e: WSEvent) => {
    if (e.type === "job_updated") {
      const updated = e.payload as { id: string };
      if (updated?.id === id) qc.invalidateQueries({ queryKey: ["job", id] });
    }
  });

  async function fetchArtifact() {
    setArtifactLoading(true);
    try {
      const res = await api.jobArtifacts(id);
      setArtifactUrl(res.download_url);
    } catch {
      toast("No artifacts available, or storage is not configured.", { tone: "danger" });
    } finally {
      setArtifactLoading(false);
    }
  }

  if (isLoading) {
    return (
      <p className="flex items-center justify-center gap-2 py-20 text-muted-foreground">
        <Spinner label="Loading job details" />
        Loading job details
      </p>
    );
  }
  if (!data) {
    return (
      <div className="flex flex-col items-center gap-4 py-20">
        <p className="text-muted-foreground">Job not found</p>
        <Button asChild variant="outline">
          <Link href="/jobs">Back to jobs</Link>
        </Button>
      </div>
    );
  }

  const { job, events } = data;
  const cancellable = ["queued", "scheduled", "running"].includes(job.status);

  return (
    <div className="space-y-6">
      {/* Header */}
      <header>
        <Link
          href="/jobs"
          className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors duration-200 hover:text-brand"
        >
          <ChevronLeft className="size-4" aria-hidden="true" />
          Back to jobs
        </Link>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <h1 className="text-2xl font-medium sm:text-3xl">{job.name ?? "Unnamed job"}</h1>
          <JobStatusBadge status={job.status as JobStatus} />
          {cancellable && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => { setCancelError(null); setConfirming(true); }}
              disabled={job.cancel_requested}
              className="ml-auto"
            >
              {job.cancel_requested ? "Cancelling" : "Cancel job"}
            </Button>
          )}
        </div>
        <p className="mt-1 font-mono text-xs break-all text-muted-foreground">{job.id}</p>
      </header>

      {/* Details grid */}
      <section className={PANEL}>
        <h2 className={cn(PANEL_TITLE, "mb-5")}>Job configuration</h2>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-3 lg:grid-cols-4">
          <Field label="Image" value={<span className="font-mono text-xs break-all">{job.image_name}</span>} />
          <Field label="Command" value={<span className="font-mono text-xs break-all">{job.command}</span>} />
          <Field label="Priority" value={
            <span
              className={cn(
                "font-semibold tabular-nums",
                job.priority >= 8
                  ? "text-red-700 dark:text-red-400"
                  : job.priority >= 5 && "text-yellow-800 dark:text-yellow-200",
              )}
            >
              {job.priority}
            </span>
          } />
          <Field label="CPU required" value={`${job.required_cpu} core${job.required_cpu !== 1 ? "s" : ""}`} />
          <Field label="Memory required" value={`${job.required_memory} MB`} />
          <Field label="Timeout" value={`${job.timeout_seconds}s`} />
          <Field label="Retries" value={
            <span className="tabular-nums">
              {job.retries}
              <span className="text-muted-foreground"> / {job.max_retries}</span>
            </span>
          } />
          <Field label="Worker" value={job.worker_id ? <span className="font-mono text-xs">{job.worker_id.slice(0, 8)}</span> : null} />
          <Field label="Submitted" value={fmt(job.submitted_at)} />
          <Field label="Started" value={fmt(job.started_at)} />
          <Field label="Completed" value={fmt(job.completed_at)} />
          <Field label="Duration" value={
            <span className="font-mono tabular-nums">{duration(job.started_at, job.completed_at)}</span>
          } />
        </dl>
      </section>

      {/* Artifact download */}
      {job.artifact_path && (
        <section className={PANEL}>
          <h2 className={cn(PANEL_TITLE, "mb-3")}>Artifacts</h2>
          <p className="mb-4 font-mono text-xs break-all text-muted-foreground">{job.artifact_path}</p>
          {artifactUrl ? (
            <Button asChild>
              <a href={artifactUrl} target="_blank" rel="noopener noreferrer">
                <Download aria-hidden="true" />
                Download artifact
              </a>
            </Button>
          ) : (
            <Button onClick={fetchArtifact} disabled={artifactLoading}>
              {artifactLoading ? (
                <>
                  <Spinner label="Generating link" className="text-current" />
                  Generating link
                </>
              ) : (
                <>
                  <Link2 aria-hidden="true" />
                  Get download link
                </>
              )}
            </Button>
          )}
        </section>
      )}

      {/* Event timeline */}
      <section className={PANEL}>
        <h2 className={cn(PANEL_TITLE, "mb-6")}>Event timeline</h2>
        {events.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">No events yet</p>
        ) : (
          <ol className="ml-1 space-y-6 border-l border-card-edge">
            {events.map((ev) => (
              <li key={ev.id} className="relative pl-6">
                <span
                  className="absolute top-1.5 -left-[4.5px] size-2 rounded-full border border-card-edge-hover bg-background"
                  aria-hidden="true"
                />
                <p className={cn("text-sm font-medium first-letter:uppercase", EVENT_TONES[ev.event_type])}>
                  {ev.event_type.replace(/^job_/, "").replace(/_/g, " ")}
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">{fmt(ev.timestamp)}</p>
                {Object.keys(ev.metadata ?? {}).length > 0 && (
                  <pre className={cn(CODE_BLOCK, "mt-2")}>{JSON.stringify(ev.metadata, null, 2)}</pre>
                )}
              </li>
            ))}
          </ol>
        )}
      </section>

      {/* Logs */}
      {job.logs_path && (
        <section className={PANEL}>
          <h2 className={cn(PANEL_TITLE, "mb-3")}>Logs</h2>
          <pre className={cn(CODE_BLOCK, "max-h-96 overflow-auto break-all whitespace-pre-wrap")}>
            {logs.isLoading ? "Loading logs" : logs.isError ? "Logs are not available." : logs.data}
          </pre>
        </section>
      )}

      <ConfirmDialog
        open={confirming}
        title="Cancel this job?"
        confirmLabel="Cancel job"
        busyLabel="Cancelling"
        cancelLabel="Keep it running"
        busy={cancelling}
        error={cancelError}
        onConfirm={cancel}
        onCancel={() => setConfirming(false)}
      >
        {job.name ?? "This job"} will be stopped and marked as cancelled. Any work it has done so far is lost, and it will not be retried.
      </ConfirmDialog>
    </div>
  );
}
