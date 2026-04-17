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
    <div className="space-y-1">
      <dt className="text-[11px] font-medium uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>
        {label}
      </dt>
      <dd className="text-sm" style={{ color: "var(--text-primary)" }}>
        {value ?? <span style={{ color: "var(--text-muted)" }}>—</span>}
      </dd>
    </div>
  );
}

const EVENT_COLORS: Record<string, string> = {
  job_submitted: "#818cf8",
  job_scheduled: "#3b82f6",
  job_started: "#10b981",
  job_completed: "#10b981",
  job_failed: "#ef4444",
  job_retrying: "#f97316",
  job_timed_out: "#dc2626",
  job_cancelled: "#64748b",
};

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
    return (
      <div className="flex items-center justify-center py-20">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 rounded-full border-2 border-t-transparent animate-spin"
            style={{ borderColor: "var(--accent-primary)", borderTopColor: "transparent" }}
          />
          <span style={{ color: "var(--text-muted)" }}>Loading job details…</span>
        </div>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="flex flex-col items-center justify-center py-20 gap-3">
        <div className="w-12 h-12 rounded-2xl flex items-center justify-center"
          style={{ background: "rgba(239, 68, 68, 0.1)" }}
        >
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#fca5a5" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
        </div>
        <p style={{ color: "var(--text-muted)" }}>Job not found</p>
      </div>
    );
  }

  const { job, events } = data;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="animate-fade-in">
        <Link href="/jobs" className="inline-flex items-center gap-1.5 text-sm mb-4 transition-colors duration-200"
          style={{ color: "var(--text-muted)" }}
          onMouseEnter={(e) => e.currentTarget.style.color = "var(--accent-primary)"}
          onMouseLeave={(e) => e.currentTarget.style.color = "var(--text-muted)"}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
          Back to Jobs
        </Link>

        <div className="flex items-center gap-4">
          <h1 className="text-2xl font-bold tracking-tight" style={{ color: "var(--text-primary)" }}>
            {job.name ?? "Unnamed job"}
          </h1>
          <JobStatusBadge status={job.status as JobStatus} />
        </div>
        <p className="mt-1 font-mono text-xs" style={{ color: "var(--text-muted)" }}>{job.id}</p>
      </div>

      {/* Details grid */}
      <div className="glass-card-static p-6 animate-fade-in-up" style={{ animationDelay: "0.1s" }}>
        <h2 className="text-sm font-semibold mb-5" style={{ color: "var(--text-primary)" }}>Job Configuration</h2>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-3 lg:grid-cols-4">
          <Field label="Image" value={<span className="font-mono text-xs">{job.image_name}</span>} />
          <Field label="Command" value={<span className="font-mono text-xs break-all">{job.command}</span>} />
          <Field label="Priority" value={
            <span className="inline-flex items-center justify-center w-7 h-7 rounded-lg text-xs font-semibold"
              style={{
                background: job.priority >= 8 ? "rgba(239,68,68,0.1)" : job.priority >= 5 ? "rgba(245,158,11,0.1)" : "rgba(100,116,139,0.1)",
                color: job.priority >= 8 ? "#fca5a5" : job.priority >= 5 ? "#fbbf24" : "var(--text-secondary)",
              }}
            >
              {job.priority}
            </span>
          } />
          <Field label="CPU Required" value={`${job.required_cpu} core${job.required_cpu !== 1 ? "s" : ""}`} />
          <Field label="Memory Required" value={`${job.required_memory} MB`} />
          <Field label="Timeout" value={`${job.timeout_seconds}s`} />
          <Field label="Retries" value={
            <span>
              <span style={{ color: "var(--text-primary)" }}>{job.retries}</span>
              <span style={{ color: "var(--text-muted)" }}> / {job.max_retries}</span>
            </span>
          } />
          <Field label="Worker" value={job.worker_id ? <span className="font-mono text-xs">{job.worker_id.slice(0, 8)}…</span> : null} />
          <Field label="Submitted" value={fmt(job.submitted_at)} />
          <Field label="Started" value={fmt(job.started_at)} />
          <Field label="Completed" value={fmt(job.completed_at)} />
          <Field label="Duration" value={
            <span className="font-mono tabular-nums">{duration(job.started_at, job.completed_at)}</span>
          } />
        </dl>
      </div>

      {/* Artifact download */}
      {job.artifact_path && (
        <div className="glass-card-static p-6 animate-fade-in-up" style={{ animationDelay: "0.15s" }}>
          <h2 className="text-sm font-semibold mb-3" style={{ color: "var(--text-primary)" }}>Artifacts</h2>
          <p className="font-mono text-xs mb-4" style={{ color: "var(--text-muted)" }}>{job.artifact_path}</p>
          {artifactUrl ? (
            <a
              href={artifactUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="btn-gradient inline-flex items-center gap-2"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
              Download Artifact
            </a>
          ) : (
            <button
              onClick={fetchArtifact}
              disabled={artifactLoading}
              className="btn-gradient inline-flex items-center gap-2"
            >
              {artifactLoading ? (
                <>
                  <div className="w-4 h-4 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                  Generating URL…
                </>
              ) : (
                <>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                    <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                  </svg>
                  Get Download Link
                </>
              )}
            </button>
          )}
        </div>
      )}

      {/* Event timeline */}
      <div className="glass-card-static p-6 animate-fade-in-up" style={{ animationDelay: "0.2s" }}>
        <h2 className="text-sm font-semibold mb-6" style={{ color: "var(--text-primary)" }}>Event Timeline</h2>
        {events.length === 0 ? (
          <p className="text-sm py-4 text-center" style={{ color: "var(--text-muted)" }}>No events yet</p>
        ) : (
          <ol className="relative space-y-0 ml-3">
            {/* Vertical line */}
            <div
              className="absolute left-0 top-2 bottom-2 w-px"
              style={{ background: "linear-gradient(180deg, var(--accent-primary), rgba(99,102,241,0.1))" }}
            />
            {events.map((ev, i) => {
              const dotColor = EVENT_COLORS[ev.event_type] ?? "#818cf8";
              return (
                <li key={ev.id} className="relative pl-8 pb-6 last:pb-0 animate-slide-in-left"
                  style={{ animationDelay: `${i * 0.05}s` }}
                >
                  {/* Dot */}
                  <span
                    className="absolute left-0 top-1 w-2 h-2 rounded-full -translate-x-[3.5px]"
                    style={{
                      background: dotColor,
                      boxShadow: `0 0 8px ${dotColor}60`,
                    }}
                  />
                  <div>
                    <p className="text-sm font-medium capitalize" style={{ color: "var(--text-primary)" }}>
                      {ev.event_type.replace(/_/g, " ")}
                    </p>
                    <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>{fmt(ev.timestamp)}</p>
                    {Object.keys(ev.metadata ?? {}).length > 0 && (
                      <pre
                        className="mt-2 rounded-lg px-3 py-2 text-xs overflow-x-auto"
                        style={{
                          background: "rgba(255,255,255,0.02)",
                          border: "1px solid var(--border-subtle)",
                          color: "var(--text-secondary)",
                        }}
                      >
                        {JSON.stringify(ev.metadata, null, 2)}
                      </pre>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </div>

      {/* Logs */}
      {job.logs_path && (
        <div className="glass-card-static p-6 animate-fade-in-up" style={{ animationDelay: "0.25s" }}>
          <h2 className="text-sm font-semibold mb-2" style={{ color: "var(--text-primary)" }}>Log Path</h2>
          <div className="flex items-center gap-2 px-3 py-2 rounded-lg"
            style={{ background: "rgba(255,255,255,0.02)", border: "1px solid var(--border-subtle)" }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ color: "var(--text-muted)", flexShrink: 0 }}>
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
              <line x1="16" y1="13" x2="8" y2="13" />
              <line x1="16" y1="17" x2="8" y2="17" />
            </svg>
            <p className="font-mono text-xs break-all" style={{ color: "var(--text-secondary)" }}>{job.logs_path}</p>
          </div>
        </div>
      )}
    </div>
  );
}
