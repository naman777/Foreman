"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { Worker, WSEvent } from "@/lib/types";
import { WorkerStatusBadge } from "@/components/StatusBadge";
import { useWebSocket } from "@/hooks/useWebSocket";
import { ago } from "@/lib/utils";

export default function WorkersPage() {
  const qc = useQueryClient();

  const { data: workers = [], isLoading } = useQuery<Worker[]>({
    queryKey: ["workers"],
    queryFn: api.workers,
    refetchInterval: 10_000,
  });

  useWebSocket((e: WSEvent) => {
    if (e.type === "worker_registered" || e.type === "worker_heartbeat") {
      qc.invalidateQueries({ queryKey: ["workers"] });
    }
  });

  const activeCount = workers.filter(w => w.status === "online" || w.status === "busy").length;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-end justify-between animate-fade-in">
        <div>
          <h1 className="text-2xl font-bold tracking-tight" style={{ color: "var(--text-primary)" }}>
            Workers
          </h1>
          <p className="mt-1 text-sm" style={{ color: "var(--text-muted)" }}>
            Monitor your compute fleet in real-time
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs px-2.5 py-1 rounded-full"
            style={{ background: "rgba(16, 185, 129, 0.1)", color: "#6ee7b7" }}
          >
            {activeCount} active
          </span>
          <span className="text-xs px-2.5 py-1 rounded-full"
            style={{ background: "rgba(100, 116, 139, 0.1)", color: "var(--text-muted)" }}
          >
            {workers.length} total
          </span>
        </div>
      </div>

      {/* Workers Table */}
      <div className="glass-table animate-fade-in-up" style={{ animationDelay: "0.1s" }}>
        <table className="w-full text-sm">
          <thead>
            <tr>
              {["Hostname", "Status", "CPU Cores", "Memory", "Load", "Last Heartbeat", "Registered"].map((h) => (
                <th key={h} className="text-left">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <tr>
                <td colSpan={7} className="!py-12 text-center">
                  <div className="flex flex-col items-center gap-3">
                    <div className="w-6 h-6 rounded-full border-2 border-t-transparent animate-spin"
                      style={{ borderColor: "var(--accent-primary)", borderTopColor: "transparent" }}
                    />
                    <span style={{ color: "var(--text-muted)" }}>Loading workers…</span>
                  </div>
                </td>
              </tr>
            )}
            {!isLoading && workers.length === 0 && (
              <tr>
                <td colSpan={7} className="!py-12 text-center">
                  <div className="flex flex-col items-center gap-2">
                    <div className="w-12 h-12 rounded-2xl flex items-center justify-center"
                      style={{ background: "rgba(99, 102, 241, 0.1)" }}
                    >
                      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#818cf8" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                        <rect x="2" y="6" width="20" height="12" rx="2" />
                        <path d="M6 12h.01M10 12h.01M14 12h.01M18 12h.01" />
                      </svg>
                    </div>
                    <p className="text-sm" style={{ color: "var(--text-muted)" }}>No workers registered yet</p>
                  </div>
                </td>
              </tr>
            )}
            {workers.map((w, i) => {
              const loadPercent = Math.min(100, (w.current_load / Math.max(w.cpu_cores, 4)) * 100);
              const loadColor = loadPercent > 80 ? "#ef4444" : loadPercent > 50 ? "#f59e0b" : "#10b981";

              return (
                <tr key={w.id} className="animate-fade-in-up" style={{ animationDelay: `${Math.min(i * 0.04, 0.3)}s` }}>
                  <td>
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-lg flex items-center justify-center text-xs font-bold"
                        style={{
                          background: w.status === "online" ? "rgba(16, 185, 129, 0.1)"
                            : w.status === "busy" ? "rgba(59, 130, 246, 0.1)"
                              : "rgba(100, 116, 139, 0.1)",
                          color: w.status === "online" ? "#6ee7b7"
                            : w.status === "busy" ? "#60a5fa"
                              : "#94a3b8",
                        }}
                      >
                        {w.hostname.charAt(0).toUpperCase()}
                      </div>
                      <span className="font-mono text-xs" style={{ color: "var(--text-primary)" }}>{w.hostname}</span>
                    </div>
                  </td>
                  <td><WorkerStatusBadge status={w.status} /></td>
                  <td>
                    <span className="inline-flex items-center gap-1.5">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ color: "var(--text-muted)" }}>
                        <rect x="4" y="4" width="16" height="16" rx="2" />
                        <rect x="9" y="9" width="6" height="6" />
                        <path d="M15 2v2M9 2v2M15 20v2M9 20v2M2 15h2M2 9h2M20 15h2M20 9h2" />
                      </svg>
                      <span style={{ color: "var(--text-secondary)" }}>{w.cpu_cores}</span>
                    </span>
                  </td>
                  <td style={{ color: "var(--text-secondary)" }}>
                    {(w.memory_mb / 1024).toFixed(1)} GB
                  </td>
                  <td>
                    <div className="flex items-center gap-3">
                      <div className="w-20 h-2 rounded-full overflow-hidden" style={{ background: "rgba(255,255,255,0.06)" }}>
                        <div
                          className="h-full rounded-full transition-all duration-700"
                          style={{
                            width: `${loadPercent}%`,
                            background: `linear-gradient(90deg, ${loadColor}, ${loadColor}90)`,
                            boxShadow: `0 0 8px ${loadColor}40`,
                          }}
                        />
                      </div>
                      <span className="text-xs tabular-nums w-4" style={{ color: "var(--text-muted)" }}>{w.current_load}</span>
                    </div>
                  </td>
                  <td className="text-xs" style={{ color: "var(--text-secondary)" }}>{ago(w.last_heartbeat)}</td>
                  <td className="text-xs" style={{ color: "var(--text-muted)" }}>{ago(w.registered_at)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
