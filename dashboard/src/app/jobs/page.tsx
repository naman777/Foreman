"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { api } from "@/lib/api";
import type { Job, JobStatus, WSEvent } from "@/lib/types";
import { JobStatusBadge } from "@/components/StatusBadge";
import { useWebSocket } from "@/hooks/useWebSocket";
import { ago, duration } from "@/lib/utils";

const STATUSES: Array<{ value: string; label: string }> = [
  { value: "", label: "All" },
  { value: "queued", label: "Queued" },
  { value: "running", label: "Running" },
  { value: "completed", label: "Completed" },
  { value: "failed", label: "Failed" },
  { value: "timed_out", label: "Timed out" },
];

export default function JobsPage() {
  const qc = useQueryClient();
  const [status, setStatus] = useState("");

  const { data: jobs = [], isLoading } = useQuery<Job[]>({
    queryKey: ["jobs", status],
    queryFn: () => api.jobs({ status: status || undefined, limit: 100 }),
    refetchInterval: 10_000,
  });

  useWebSocket((e: WSEvent) => {
    if (e.type === "job_updated") {
      qc.invalidateQueries({ queryKey: ["jobs"] });
    }
  });

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-end justify-between animate-fade-in">
        <div>
          <h1 className="text-2xl font-bold tracking-tight" style={{ color: "var(--text-primary)" }}>
            Jobs
          </h1>
          <p className="mt-1 text-sm" style={{ color: "var(--text-muted)" }}>
            Browse and monitor all scheduled jobs
          </p>
        </div>
        <span className="text-xs px-2.5 py-1 rounded-full"
          style={{ background: "rgba(99, 102, 241, 0.1)", color: "var(--accent-primary)" }}
        >
          {jobs.length} shown
        </span>
      </div>

      {/* Status filter tabs */}
      <div className="flex gap-1 p-1 rounded-xl w-fit animate-fade-in-up"
        style={{ background: "var(--bg-card)", border: "1px solid var(--border-subtle)" }}
      >
        {STATUSES.map((s) => (
          <button
            key={s.value}
            onClick={() => setStatus(s.value)}
            className="rounded-lg px-4 py-2 text-sm font-medium transition-all duration-200 cursor-pointer"
            style={{
              background: status === s.value
                ? "var(--accent-gradient)"
                : "transparent",
              color: status === s.value
                ? "#ffffff"
                : "var(--text-muted)",
              boxShadow: status === s.value
                ? "0 2px 12px rgba(99, 102, 241, 0.3)"
                : "none",
            }}
          >
            {s.label}
          </button>
        ))}
      </div>

      {/* Jobs Table */}
      <div className="glass-table animate-fade-in-up" style={{ animationDelay: "0.1s" }}>
        <table className="w-full text-sm">
          <thead>
            <tr>
              {["Name / ID", "Status", "Image", "Priority", "Duration", "Submitted"].map((h) => (
                <th key={h} className="text-left">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <tr>
                <td colSpan={6} className="!py-12 text-center">
                  <div className="flex flex-col items-center gap-3">
                    <div className="w-6 h-6 rounded-full border-2 border-t-transparent animate-spin"
                      style={{ borderColor: "var(--accent-primary)", borderTopColor: "transparent" }}
                    />
                    <span style={{ color: "var(--text-muted)" }}>Loading jobs…</span>
                  </div>
                </td>
              </tr>
            )}
            {!isLoading && jobs.length === 0 && (
              <tr>
                <td colSpan={6} className="!py-12 text-center">
                  <div className="flex flex-col items-center gap-2">
                    <div className="w-12 h-12 rounded-2xl flex items-center justify-center"
                      style={{ background: "rgba(99, 102, 241, 0.1)" }}
                    >
                      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#818cf8" strokeWidth="1.5">
                        <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" strokeLinecap="round" strokeLinejoin="round" />
                        <rect x="8" y="2" width="8" height="4" rx="1" ry="1" />
                      </svg>
                    </div>
                    <p className="text-sm" style={{ color: "var(--text-muted)" }}>No jobs found</p>
                  </div>
                </td>
              </tr>
            )}
            {jobs.map((j, i) => (
              <tr key={j.id} className="animate-fade-in-up" style={{ animationDelay: `${Math.min(i * 0.03, 0.3)}s` }}>
                <td>
                  <Link href={`/jobs/${j.id}`} className="group">
                    <p className="font-medium transition-colors duration-200"
                      style={{ color: "var(--text-primary)" }}
                    >
                      <span className="group-hover:text-[var(--accent-primary)]">{j.name ?? "Unnamed"}</span>
                    </p>
                    <p className="font-mono text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>
                      {j.id.slice(0, 8)}…
                    </p>
                  </Link>
                </td>
                <td>
                  <JobStatusBadge status={j.status as JobStatus} />
                </td>
                <td className="font-mono text-xs max-w-[160px] truncate" style={{ color: "var(--text-muted)" }}>
                  {j.image_name}
                </td>
                <td>
                  <span className="inline-flex items-center justify-center w-7 h-7 rounded-lg text-xs font-semibold"
                    style={{
                      background: j.priority >= 8
                        ? "rgba(239, 68, 68, 0.1)"
                        : j.priority >= 5
                          ? "rgba(245, 158, 11, 0.1)"
                          : "rgba(100, 116, 139, 0.1)",
                      color: j.priority >= 8
                        ? "#fca5a5"
                        : j.priority >= 5
                          ? "#fbbf24"
                          : "var(--text-muted)",
                    }}
                  >
                    {j.priority}
                  </span>
                </td>
                <td className="tabular-nums" style={{ color: "var(--text-secondary)" }}>
                  {duration(j.started_at, j.completed_at ?? (j.status === "running" ? null : j.scheduled_at))}
                </td>
                <td className="text-xs" style={{ color: "var(--text-muted)" }}>{ago(j.submitted_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
