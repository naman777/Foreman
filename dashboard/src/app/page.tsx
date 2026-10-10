"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { api } from "@/lib/api";
import type { MetricsSummary, WSEvent, Worker } from "@/lib/types";
import { useWebSocket } from "@/hooks/useWebSocket";
import { ago } from "@/lib/utils";
import { StatStrip } from "@/components/stat-strip";
import { WorkerStatusBadge } from "@/components/StatusBadge";
import { Button } from "@/components/ui/button";
import { LiveDot } from "@/components/ui/live-dot";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";

const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });

// A dash stands in until the first response arrives.
function count(n: number | undefined): string {
  if (n == null) return "-";
  return n >= 10_000 ? compact.format(n) : n.toLocaleString("en");
}

function WorkerRow({ worker }: { worker: Worker }) {
  return (
    <li className="flex items-center justify-between gap-3 border-b border-border py-3 last:border-0">
      <div className="min-w-0">
        <p className="truncate font-mono text-xs">{worker.hostname}</p>
        <p className="mt-0.5 text-[11px] text-muted-foreground">{ago(worker.last_heartbeat)}</p>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <Progress
          value={Math.min(4, worker.current_load)}
          max={4}
          aria-label={`Load on ${worker.hostname}`}
          className="w-14"
        />
        <span className="w-3 text-xs text-muted-foreground tabular-nums">{worker.current_load}</span>
        <WorkerStatusBadge status={worker.status} />
      </div>
    </li>
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

  const statusRows = m
    ? [
      { name: "Queued", count: m.queued },
      { name: "Scheduled", count: m.scheduled },
      { name: "Running", count: m.running },
      { name: "Completed", count: m.completed },
      { name: "Failed", count: m.failed },
      { name: "Timed out", count: m.timed_out },
      { name: "Cancelled", count: m.cancelled },
    ]
    : [];
  const largest = Math.max(1, ...statusRows.map((d) => d.count));

  return (
    <div className="space-y-8">
      {/* Header */}
      <header className="space-y-3">
        <h1 className="text-2xl font-medium sm:text-center sm:text-3xl">Overview</h1>
        <p className="mx-auto max-w-3xl text-base text-neutral-700 sm:text-center sm:text-lg md:text-xl dark:text-neutral-400">
          Explore a live TypeScript job scheduler, <span className="highlight">no sign in needed</span>.
        </p>
        <div className="flex pt-2 sm:justify-center">
          <Button asChild variant="solid">
            <Link href="/playground">Run a live job</Link>
          </Button>
        </div>
      </header>

      {/* Stats */}
      <section aria-label="Job counts" className="card-chai p-6">
        <StatStrip
          stats={[
            { value: count(m?.total), label: "Total jobs" },
            { value: count(m?.running), label: "Running" },
            { value: count(m?.completed), label: "Completed" },
            { value: count(m?.failed), label: "Failed" },
          ]}
        />
      </section>

      {/* Chart + workers */}
      <div className="grid gap-6 lg:grid-cols-5">
        <section className="card-chai p-6 lg:col-span-3">
          <div className="mb-6 flex items-start justify-between gap-4">
            <div>
              <h2 className="font-montserrat text-base font-semibold">Jobs by status</h2>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {count(m?.queued)} queued right now
              </p>
            </div>
            <LiveDot tone="success">Live</LiveDot>
          </div>
          {!m ? (
            <div className="space-y-3.5" role="status" aria-label="Loading job counts">
              {Array.from({ length: 7 }, (_, i) => <Skeleton key={i} className="h-5" />)}
            </div>
          ) : m.total > 0 ? (
            <ul className="space-y-3.5">
              {statusRows.map((d) => (
                <li key={d.name} className="grid grid-cols-[5.5rem_1fr_3rem] items-center gap-3 text-sm">
                  <span className="text-muted-foreground">{d.name}</span>
                  <Progress value={d.count} max={largest} aria-label={`${d.name} jobs`} />
                  <span className="text-right font-medium tabular-nums">{count(d.count)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="flex h-[220px] items-center justify-center text-sm text-muted-foreground">
              No jobs yet
            </p>
          )}
        </section>

        <section className="card-chai p-6 lg:col-span-2">
          <div className="mb-4 flex items-start justify-between gap-4">
            <div>
              <h2 className="font-montserrat text-base font-semibold">Workers</h2>
              <p className="mt-0.5 text-xs text-muted-foreground">Active fleet status</p>
            </div>
            <p className="flex items-baseline gap-1.5">
              <span className="font-montserrat text-2xl font-semibold tabular-nums">{workers ? activeWorkers : "-"}</span>
              <span className="text-xs text-muted-foreground">of {workers?.length ?? "-"}</span>
            </p>
          </div>

          <Progress value={activeWorkers} max={workers?.length || 1} aria-label="Active workers" />

          <ul className="mt-2">
            {workers?.slice(0, 5).map((w) => (
              <WorkerRow key={w.id} worker={w} />
            ))}
          </ul>
          {!workers && <Skeleton className="mt-4 h-24" />}
          {workers?.length === 0 && (
            <p className="py-6 text-center text-sm text-muted-foreground">No workers registered</p>
          )}
        </section>
      </div>
    </div>
  );
}
