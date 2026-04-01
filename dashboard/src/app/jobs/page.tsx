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
  { value: "",          label: "All"       },
  { value: "queued",    label: "Queued"    },
  { value: "running",   label: "Running"   },
  { value: "completed", label: "Completed" },
  { value: "failed",    label: "Failed"    },
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
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Jobs</h1>
        <span className="text-sm text-zinc-400">{jobs.length} shown</span>
      </div>

      {/* Status filter tabs */}
      <div className="flex gap-1 rounded-lg border border-zinc-200 bg-white p-1 w-fit shadow-sm">
        {STATUSES.map((s) => (
          <button
            key={s.value}
            onClick={() => setStatus(s.value)}
            className={`rounded-md px-3 py-1.5 text-sm transition-colors ${
              status === s.value
                ? "bg-zinc-900 text-white"
                : "text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900"
            }`}
          >
            {s.label}
          </button>
        ))}
      </div>

      <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white shadow-sm">
        <table className="w-full text-sm">
          <thead className="border-b border-zinc-100 bg-zinc-50">
            <tr>
              {["Name / ID", "Status", "Image", "Priority", "Duration", "Submitted"].map((h) => (
                <th key={h} className="px-4 py-3 text-left font-medium text-zinc-500">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100">
            {isLoading && (
              <tr><td colSpan={6} className="px-4 py-8 text-center text-zinc-400">Loading…</td></tr>
            )}
            {!isLoading && jobs.length === 0 && (
              <tr><td colSpan={6} className="px-4 py-8 text-center text-zinc-400">No jobs found</td></tr>
            )}
            {jobs.map((j) => (
              <tr key={j.id} className="hover:bg-zinc-50 transition-colors">
                <td className="px-4 py-3">
                  <Link href={`/jobs/${j.id}`} className="hover:underline">
                    <p className="font-medium text-zinc-800">{j.name ?? "Unnamed"}</p>
                    <p className="font-mono text-xs text-zinc-400">{j.id.slice(0, 8)}…</p>
                  </Link>
                </td>
                <td className="px-4 py-3">
                  <JobStatusBadge status={j.status as JobStatus} />
                </td>
                <td className="px-4 py-3 font-mono text-xs text-zinc-500 max-w-[160px] truncate">
                  {j.image_name}
                </td>
                <td className="px-4 py-3 text-zinc-500">{j.priority}</td>
                <td className="px-4 py-3 text-zinc-500">
                  {duration(j.started_at, j.completed_at ?? (j.status === "running" ? null : j.scheduled_at))}
                </td>
                <td className="px-4 py-3 text-zinc-400 text-xs">{ago(j.submitted_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
