"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "next/navigation";
import Link from "next/link";
import { api } from "@/lib/api";
import type { Job, JobEvent, JobStatus, WSEvent } from "@/lib/types";
import { JobStatusBadge } from "@/components/StatusBadge";
import { useWebSocket } from "@/hooks/useWebSocket";
import { fmt, duration, ago } from "@/lib/utils";

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-zinc-400">{label}</dt>
      <dd className="mt-0.5 text-sm text-zinc-700">{value ?? "—"}</dd>
    </div>
  );
}

export default function JobDetailPage() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const [artifactUrl, setArtifactUrl] = useState<string | null>(null);
  const [artifactLoading, setArtifactLoading] = useState(false);

  const { data, isLoading } = useQuery<{ job: Job; events: JobEvent[] }>({
    queryKey: ["job", id],
    queryFn: () => api.job(id),
    refetchInterval: 5_000,
  });

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
      alert("No artifacts available or storage not configured.");
    } finally {
      setArtifactLoading(false);
    }
  }

  if (isLoading) {
    return <p className="text-zinc-400">Loading…</p>;
  }
  if (!data) {
    return <p className="text-zinc-500">Job not found.</p>;
  }

  const { job, events } = data;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-3">
            <Link href="/jobs" className="text-sm text-zinc-400 hover:text-zinc-600">← Jobs</Link>
            <h1 className="text-xl font-semibold">{job.name ?? "Unnamed job"}</h1>
            <JobStatusBadge status={job.status as JobStatus} />
          </div>
          <p className="mt-1 font-mono text-xs text-zinc-400">{job.id}</p>
        </div>
      </div>

      {/* Details grid */}
      <div className="rounded-lg border border-zinc-200 bg-white p-5 shadow-sm">
        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          <Field label="Image"       value={<span className="font-mono">{job.image_name}</span>} />
          <Field label="Command"     value={<span className="font-mono text-xs break-all">{job.command}</span>} />
          <Field label="Priority"    value={job.priority} />
          <Field label="CPU req."    value={`${job.required_cpu} core${job.required_cpu !== 1 ? "s" : ""}`} />
          <Field label="Memory req." value={`${job.required_memory} MB`} />
          <Field label="Timeout"     value={`${job.timeout_seconds}s`} />
          <Field label="Retries"     value={`${job.retries} / ${job.max_retries}`} />
          <Field label="Worker ID"   value={job.worker_id ? <span className="font-mono text-xs">{job.worker_id.slice(0, 8)}…</span> : null} />
          <Field label="Submitted"   value={fmt(job.submitted_at)} />
          <Field label="Started"     value={fmt(job.started_at)} />
          <Field label="Completed"   value={fmt(job.completed_at)} />
          <Field label="Duration"    value={duration(job.started_at, job.completed_at)} />
        </dl>
      </div>

      {/* Artifact download */}
      {job.artifact_path && (
        <div className="rounded-lg border border-zinc-200 bg-white p-5 shadow-sm">
          <p className="mb-3 text-sm font-medium text-zinc-700">Artifacts</p>
          <p className="mb-3 font-mono text-xs text-zinc-400">{job.artifact_path}</p>
          {artifactUrl ? (
            <a
              href={artifactUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-md bg-indigo-600 px-3 py-1.5 text-sm text-white hover:bg-indigo-700"
            >
              ↓ Download
            </a>
          ) : (
            <button
              onClick={fetchArtifact}
              disabled={artifactLoading}
              className="inline-flex items-center gap-1.5 rounded-md bg-zinc-900 px-3 py-1.5 text-sm text-white hover:bg-zinc-700 disabled:opacity-50"
            >
              {artifactLoading ? "Generating URL…" : "Get download link"}
            </button>
          )}
        </div>
      )}

      {/* Event timeline */}
      <div className="rounded-lg border border-zinc-200 bg-white p-5 shadow-sm">
        <p className="mb-4 text-sm font-medium text-zinc-700">Event timeline</p>
        {events.length === 0 ? (
          <p className="text-sm text-zinc-400">No events yet.</p>
        ) : (
          <ol className="relative space-y-3 border-l border-zinc-200 pl-5">
            {events.map((ev) => (
              <li key={ev.id} className="relative">
                <span className="absolute -left-[21px] mt-1 flex h-3 w-3 items-center justify-center rounded-full border border-zinc-300 bg-white" />
                <p className="text-sm font-medium text-zinc-800">{ev.event_type.replace(/_/g, " ")}</p>
                <p className="text-xs text-zinc-400">{fmt(ev.timestamp)}</p>
                {Object.keys(ev.metadata ?? {}).length > 0 && (
                  <pre className="mt-1 rounded bg-zinc-50 px-2 py-1 text-xs text-zinc-500">
                    {JSON.stringify(ev.metadata, null, 2)}
                  </pre>
                )}
              </li>
            ))}
          </ol>
        )}
      </div>

      {/* Logs */}
      {job.logs_path && (
        <div className="rounded-lg border border-zinc-200 bg-white p-5 shadow-sm">
          <p className="mb-2 text-sm font-medium text-zinc-700">Log path</p>
          <p className="font-mono text-xs text-zinc-500 break-all">{job.logs_path}</p>
        </div>
      )}
    </div>
  );
}
