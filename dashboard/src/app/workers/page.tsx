"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { Worker, WSEvent } from "@/lib/types";
import { WorkerStatusBadge } from "@/components/StatusBadge";
import { Progress } from "@/components/ui/progress";
import { Spinner } from "@/components/ui/spinner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useWebSocket } from "@/hooks/useWebSocket";
import { ago, cn } from "@/lib/utils";

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
      <header className="space-y-3">
        <h1 className="text-2xl font-medium sm:text-center sm:text-3xl">Workers</h1>
        <p className="mx-auto max-w-3xl text-base text-neutral-700 sm:text-center sm:text-lg md:text-xl dark:text-neutral-400">
          Monitor the compute fleet, with <span className="highlight">heartbeats in real time</span>.
        </p>
      </header>

      {/* Toolbar */}
      <div className="flex items-center gap-3">
        <p className="text-sm text-gray-500 dark:text-gray-400">
          Showing <span className="font-semibold text-gray-900 dark:text-gray-100">{workers.length}</span> workers
        </p>
        <span className="h-4 w-px bg-gray-300 dark:bg-gray-700" />
        <p className="text-sm text-gray-500 dark:text-gray-400">
          <span className="font-semibold text-green-700 dark:text-green-400">{activeCount}</span> active
        </p>
      </div>

      {/* Workers table */}
      <Table>
        <TableHeader>
          <TableRow>
            {["Hostname", "Status", "CPU cores", "Memory", "Load", "Last heartbeat", "Registered"].map((h) => (
              <TableHead key={h}>{h}</TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {isLoading && (
            <TableRow>
              <TableCell colSpan={7} className="py-12 text-center text-muted-foreground">
                <span className="inline-flex items-center gap-2">
                  <Spinner label="Loading workers" />
                  Loading workers
                </span>
              </TableCell>
            </TableRow>
          )}
          {!isLoading && workers.length === 0 && (
            <TableRow>
              <TableCell colSpan={7} className="py-12 text-center text-muted-foreground">
                No workers registered yet
              </TableCell>
            </TableRow>
          )}
          {workers.map((w) => {
            const capacity = Math.max(w.cpu_cores, 4);
            const loadPercent = Math.min(100, (w.current_load / capacity) * 100);

            return (
              <TableRow key={w.id}>
                <TableCell className="font-mono text-xs whitespace-nowrap">{w.hostname}</TableCell>
                <TableCell><WorkerStatusBadge status={w.status} /></TableCell>
                <TableCell className="tabular-nums">{w.cpu_cores}</TableCell>
                <TableCell className="whitespace-nowrap tabular-nums">
                  {(w.memory_mb / 1024).toFixed(1)} GB
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-3">
                    <Progress
                      value={Math.min(capacity, w.current_load)}
                      max={capacity}
                      aria-label={`Load on ${w.hostname}`}
                      className="w-20"
                    />
                    <span
                      className={cn(
                        "w-4 text-xs tabular-nums",
                        loadPercent > 80
                          ? "text-red-700 dark:text-red-400"
                          : loadPercent > 50
                            ? "text-yellow-800 dark:text-yellow-200"
                            : "text-muted-foreground",
                      )}
                    >
                      {w.current_load}
                    </span>
                  </div>
                </TableCell>
                <TableCell className="text-xs whitespace-nowrap">{ago(w.last_heartbeat)}</TableCell>
                <TableCell className="text-xs whitespace-nowrap text-muted-foreground">{ago(w.registered_at)}</TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
