"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell, CartesianGrid } from "recharts";
import { api } from "@/lib/api";
import type { MetricsSummary, WSEvent, Worker } from "@/lib/types";
import { useWebSocket } from "@/hooks/useWebSocket";
import { ago } from "@/lib/utils";

const STATUS_COLORS: Record<string, string> = {
  Queued: "#f59e0b",
  Scheduled: "#3b82f6",
  Running: "#818cf8",
  Completed: "#10b981",
  Failed: "#ef4444",
  Timed_out: "#dc2626",
  Cancelled: "#64748b",
};

const STAT_CARDS: {
  key: keyof MetricsSummary;
  label: string;
  gradient: string;
  iconColor: string;
  icon: React.ReactNode;
}[] = [
    {
      key: "total",
      label: "Total Jobs",
      gradient: "linear-gradient(135deg, rgba(99, 102, 241, 0.15), rgba(99, 102, 241, 0.05))",
      iconColor: "#818cf8",
      icon: (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
        </svg>
      ),
    },
    {
      key: "running",
      label: "Running",
      gradient: "linear-gradient(135deg, rgba(129, 140, 248, 0.15), rgba(6, 182, 212, 0.05))",
      iconColor: "#a5b4fc",
      icon: (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <polygon points="5 3 19 12 5 21 5 3" />
        </svg>
      ),
    },
    {
      key: "queued",
      label: "Queued",
      gradient: "linear-gradient(135deg, rgba(245, 158, 11, 0.15), rgba(245, 158, 11, 0.05))",
      iconColor: "#fbbf24",
      icon: (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10" />
          <polyline points="12 6 12 12 16 14" />
        </svg>
      ),
    },
    {
      key: "completed",
      label: "Completed",
      gradient: "linear-gradient(135deg, rgba(16, 185, 129, 0.15), rgba(16, 185, 129, 0.05))",
      iconColor: "#6ee7b7",
      icon: (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
          <polyline points="22 4 12 14.01 9 11.01" />
        </svg>
      ),
    },
    {
      key: "failed",
      label: "Failed",
      gradient: "linear-gradient(135deg, rgba(239, 68, 68, 0.15), rgba(239, 68, 68, 0.05))",
      iconColor: "#fca5a5",
      icon: (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10" />
          <line x1="15" y1="9" x2="9" y2="15" />
          <line x1="9" y1="9" x2="15" y2="15" />
        </svg>
      ),
    },
  ];

function StatCard({
  label,
  value,
  gradient,
  iconColor,
  icon,
  delay,
}: {
  label: string;
  value: number;
  gradient: string;
  iconColor: string;
  icon: React.ReactNode;
  delay: number;
}) {
  return (
    <div
      className="glass-card gradient-border-top p-5 animate-fade-in-up"
      style={{ animationDelay: `${delay}s`, background: gradient }}
    >
      <div className="flex items-start justify-between">
        <div>
          <p className="text-xs font-medium uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>
            {label}
          </p>
          <p className="mt-2 text-3xl font-bold tracking-tight" style={{ color: "var(--text-primary)" }}>
            {value.toLocaleString()}
          </p>
        </div>
        <div
          className="w-10 h-10 rounded-xl flex items-center justify-center"
          style={{ background: `${iconColor}15`, color: iconColor }}
        >
          {icon}
        </div>
      </div>
    </div>
  );
}

function WorkerRow({ worker }: { worker: Worker }) {
  const statusColors: Record<string, string> = {
    online: "#10b981",
    busy: "#3b82f6",
    unhealthy: "#f97316",
    offline: "#64748b",
  };
  const color = statusColors[worker.status] ?? "#64748b";

  return (
    <div className="flex items-center justify-between py-3 px-1 transition-colors duration-200 rounded-lg"
      style={{ borderBottom: "1px solid rgba(255,255,255,0.03)" }}
    >
      <div className="flex items-center gap-3">
        <div className="w-8 h-8 rounded-lg flex items-center justify-center text-xs font-bold"
          style={{ background: `${color}15`, color }}
        >
          {worker.hostname.charAt(0).toUpperCase()}
        </div>
        <div>
          <p className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>
            {worker.hostname}
          </p>
          <p className="text-[11px]" style={{ color: "var(--text-muted)" }}>
            {ago(worker.last_heartbeat)}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2">
          <div className="w-16 h-1.5 rounded-full overflow-hidden" style={{ background: "rgba(255,255,255,0.06)" }}>
            <div
              className="h-full rounded-full transition-all duration-500"
              style={{
                width: `${Math.min(100, (worker.current_load / 4) * 100)}%`,
                background: `linear-gradient(90deg, ${color}, ${color}80)`,
              }}
            />
          </div>
          <span className="text-xs tabular-nums" style={{ color: "var(--text-muted)" }}>{worker.current_load}</span>
        </div>
        <span className="status-dot status-dot-pulse" style={{ background: color, boxShadow: `0 0 6px ${color}50` }} />
      </div>
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
      { name: "Queued", count: m.queued },
      { name: "Scheduled", count: m.scheduled },
      { name: "Running", count: m.running },
      { name: "Completed", count: m.completed },
      { name: "Failed", count: m.failed },
      { name: "Timed_out", count: m.timed_out },
      { name: "Cancelled", count: m.cancelled },
    ].filter((d) => d.count > 0)
    : [];

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="animate-fade-in">
        <h1 className="text-2xl font-bold tracking-tight" style={{ color: "var(--text-primary)" }}>
          Overview
        </h1>
        <p className="mt-1 text-sm" style={{ color: "var(--text-muted)" }}>
          Monitor your distributed job scheduler at a glance
        </p>
      </div>

      {/* Stat Cards */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5 stagger-children">
        {STAT_CARDS.map((card, i) => (
          <StatCard
            key={card.key}
            label={card.label}
            value={m?.[card.key] ?? 0}
            gradient={card.gradient}
            iconColor={card.iconColor}
            icon={card.icon}
            delay={i * 0.06}
          />
        ))}
      </div>

      {/* Charts + Workers Row */}
      <div className="grid gap-6 lg:grid-cols-5">
        {/* Bar Chart - 3 cols */}
        <div className="lg:col-span-3 glass-card-static p-6 animate-fade-in-up" style={{ animationDelay: "0.2s" }}>
          <div className="flex items-center justify-between mb-6">
            <div>
              <p className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>Jobs by Status</p>
              <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>Distribution of current jobs</p>
            </div>
            <div className="text-xs px-2.5 py-1 rounded-full"
              style={{ background: "rgba(99, 102, 241, 0.1)", color: "var(--accent-primary)" }}
            >
              Live
            </div>
          </div>
          {chartData.length > 0 ? (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={chartData} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis
                  dataKey="name"
                  tick={{ fontSize: 11, fill: "#64748b" }}
                  axisLine={{ stroke: "rgba(255,255,255,0.06)" }}
                  tickLine={false}
                />
                <YAxis
                  allowDecimals={false}
                  tick={{ fontSize: 11, fill: "#64748b" }}
                  axisLine={false}
                  tickLine={false}
                />
                <Tooltip
                  contentStyle={{
                    background: "rgba(17, 24, 39, 0.95)",
                    border: "1px solid rgba(255,255,255,0.1)",
                    borderRadius: "10px",
                    boxShadow: "0 8px 32px rgba(0,0,0,0.3)",
                  }}
                  labelStyle={{ color: "#f1f5f9", fontWeight: 500 }}
                  itemStyle={{ color: "#94a3b8" }}
                  cursor={{ fill: "rgba(255,255,255,0.03)" }}
                />
                <Bar dataKey="count" radius={[6, 6, 0, 0]} barSize={36}>
                  {chartData.map((d) => (
                    <Cell key={d.name} fill={STATUS_COLORS[d.name] ?? "#818cf8"} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex flex-col items-center justify-center h-[220px]">
              <div className="w-12 h-12 rounded-2xl flex items-center justify-center mb-3"
                style={{ background: "rgba(99, 102, 241, 0.1)" }}
              >
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#818cf8" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
                </svg>
              </div>
              <p className="text-sm" style={{ color: "var(--text-muted)" }}>No jobs yet</p>
            </div>
          )}
        </div>

        {/* Workers Panel - 2 cols */}
        <div className="lg:col-span-2 glass-card-static p-6 animate-fade-in-up" style={{ animationDelay: "0.3s" }}>
          <div className="flex items-center justify-between mb-5">
            <div>
              <p className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>Workers</p>
              <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>Active fleet status</p>
            </div>
            <div className="flex items-baseline gap-1.5">
              <span className="text-2xl font-bold" style={{ color: "var(--text-primary)" }}>
                {activeWorkers}
              </span>
              <span className="text-xs" style={{ color: "var(--text-muted)" }}>
                / {workers?.length ?? 0}
              </span>
            </div>
          </div>

          {/* Mini progress */}
          <div className="w-full h-1.5 rounded-full mb-5 overflow-hidden" style={{ background: "rgba(255,255,255,0.06)" }}>
            <div
              className="h-full rounded-full transition-all duration-700"
              style={{
                width: `${workers?.length ? (activeWorkers / workers.length) * 100 : 0}%`,
                background: "var(--accent-gradient-success)",
              }}
            />
          </div>

          {/* Worker list */}
          <div className="space-y-1">
            {workers?.slice(0, 5).map((w) => (
              <WorkerRow key={w.id} worker={w} />
            ))}
            {(!workers || workers.length === 0) && (
              <p className="py-6 text-center text-sm" style={{ color: "var(--text-muted)" }}>
                No workers registered
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
