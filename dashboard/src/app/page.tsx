"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from "recharts";
import { api } from "@/lib/api";
import type { MetricsSummary, WSEvent, Worker } from "@/lib/types";
import { useWebSocket } from "@/hooks/useWebSocket";

const STATUS_COLORS: Record<string, string> = {
  Queued:    "#f59e0b",
  Scheduled: "#3b82f6",
  Running:   "#6366f1",
  Completed: "#10b981",
  Failed:    "#ef4444",
  Timed_out: "#dc2626",
  Cancelled: "#9ca3af",
};

function StatCard({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-5 shadow-sm">
      <p className="text-sm text-zinc-500">{label}</p>
      <p className={`mt-1 text-3xl font-semibold ${color}`}>{value}</p>
    </div>
  );
}

export default function OverviewPage() {
  const qc = useQueryClient();

  const { data: metrics } = useQuery<MetricsSummary>({
    queryKey: ["metrics"],
    queryFn: api.metrics,
    refetchInterval: 10_000,
  });

  const { data: workers } = useQuery<Worker[]>({
    queryKey: ["workers"],
    queryFn: api.workers,
    refetchInterval: 10_000,
  });

  useWebSocket((e: WSEvent) => {
    if (e.type === "job_updated") {
      qc.invalidateQueries({ queryKey: ["metrics"] });
      qc.invalidateQueries({ queryKey: ["jobs"] });
    }
    if (e.type === "worker_registered" || e.type === "worker_heartbeat") {
      qc.invalidateQueries({ queryKey: ["workers"] });
    }
  });

  const m = metrics;
  const activeWorkers = workers?.filter((w) => w.status === "online" || w.status === "busy").length ?? 0;

  const chartData = m
    ? [
        { name: "Queued",    count: m.queued },
        { name: "Scheduled", count: m.scheduled },
        { name: "Running",   count: m.running },
        { name: "Completed", count: m.completed },
        { name: "Failed",    count: m.failed },
        { name: "Timed_out", count: m.timed_out },
        { name: "Cancelled", count: m.cancelled },
      ].filter((d) => d.count > 0)
    : [];

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">Overview</h1>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
        <StatCard label="Total Jobs"  value={m?.total ?? 0}     color="text-zinc-900" />
        <StatCard label="Running"     value={m?.running ?? 0}   color="text-indigo-600" />
        <StatCard label="Queued"      value={m?.queued ?? 0}    color="text-amber-600" />
        <StatCard label="Completed"   value={m?.completed ?? 0} color="text-green-600" />
        <StatCard label="Failed"      value={m?.failed ?? 0}    color="text-red-600" />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="rounded-lg border border-zinc-200 bg-white p-5 shadow-sm">
          <p className="mb-4 text-sm font-medium text-zinc-700">Jobs by status</p>
          {chartData.length > 0 ? (
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={chartData} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
                <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
                <Tooltip />
                <Bar dataKey="count" radius={[3, 3, 0, 0]}>
                  {chartData.map((d) => (
                    <Cell key={d.name} fill={STATUS_COLORS[d.name] ?? "#6366f1"} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <p className="mt-8 text-center text-sm text-zinc-400">No jobs yet</p>
          )}
        </div>

        <div className="rounded-lg border border-zinc-200 bg-white p-5 shadow-sm">
          <p className="mb-2 text-sm font-medium text-zinc-700">Workers</p>
          <p className="text-3xl font-semibold text-zinc-900">{activeWorkers}</p>
          <p className="text-sm text-zinc-400">active of {workers?.length ?? 0} registered</p>
          <div className="mt-4 space-y-2">
            {workers?.slice(0, 5).map((w) => (
              <div key={w.id} className="flex items-center justify-between text-sm">
                <span className="truncate text-zinc-600">{w.hostname}</span>
                <span className="ml-2 text-zinc-400">load {w.current_load}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
