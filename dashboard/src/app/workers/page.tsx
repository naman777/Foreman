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

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Workers</h1>
        <span className="text-sm text-zinc-400">{workers.length} registered</span>
      </div>

      <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white shadow-sm">
        <table className="w-full text-sm">
          <thead className="border-b border-zinc-100 bg-zinc-50">
            <tr>
              {["Hostname", "Status", "CPU cores", "Memory", "Load", "Last heartbeat", "Registered"].map((h) => (
                <th key={h} className="px-4 py-3 text-left font-medium text-zinc-500">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100">
            {isLoading && (
              <tr><td colSpan={7} className="px-4 py-8 text-center text-zinc-400">Loading…</td></tr>
            )}
            {!isLoading && workers.length === 0 && (
              <tr><td colSpan={7} className="px-4 py-8 text-center text-zinc-400">No workers registered yet</td></tr>
            )}
            {workers.map((w) => (
              <tr key={w.id} className="hover:bg-zinc-50 transition-colors">
                <td className="px-4 py-3 font-mono text-xs text-zinc-700">{w.hostname}</td>
                <td className="px-4 py-3"><WorkerStatusBadge status={w.status} /></td>
                <td className="px-4 py-3 text-zinc-600">{w.cpu_cores}</td>
                <td className="px-4 py-3 text-zinc-600">{(w.memory_mb / 1024).toFixed(1)} GB</td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    <div className="h-1.5 w-16 overflow-hidden rounded-full bg-zinc-200">
                      <div
                        className="h-full rounded-full bg-indigo-500 transition-all"
                        style={{ width: `${Math.min(100, (w.current_load / 4) * 100)}%` }}
                      />
                    </div>
                    <span className="text-zinc-500">{w.current_load}</span>
                  </div>
                </td>
                <td className="px-4 py-3 text-zinc-500">{ago(w.last_heartbeat)}</td>
                <td className="px-4 py-3 text-zinc-400 text-xs">{ago(w.registered_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
