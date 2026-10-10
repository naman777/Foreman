"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { api } from "@/lib/api";
import type { Job, JobStatus, WSEvent } from "@/lib/types";
import { JobStatusBadge } from "@/components/StatusBadge";
import { Button } from "@/components/ui/button";
import { Segmented } from "@/components/ui/segmented";
import { Spinner } from "@/components/ui/spinner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useWebSocket } from "@/hooks/useWebSocket";
import { ago, cn, duration } from "@/lib/utils";

const STATUSES = [
  { value: "all", label: "All" },
  { value: "queued", label: "Queued" },
  { value: "running", label: "Running" },
  { value: "completed", label: "Completed" },
  { value: "failed", label: "Failed" },
  { value: "timed_out", label: "Timed out" },
] as const;

type Filter = (typeof STATUSES)[number]["value"];

export default function JobsPage() {
  const qc = useQueryClient();
  const [status, setStatus] = useState<Filter>("all");

  const { data: jobs = [], isLoading } = useQuery<Job[]>({
    queryKey: ["jobs", status],
    queryFn: () => api.jobs({ status: status === "all" ? undefined : status, limit: 100 }),
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
      <header className="space-y-3">
        <h1 className="text-2xl font-medium sm:text-center sm:text-3xl">Jobs</h1>
        <p className="mx-auto max-w-3xl text-base text-neutral-700 sm:text-center sm:text-lg md:text-xl dark:text-neutral-400">
          Browse every job the scheduler has seen, with <span className="highlight">live status updates</span>.
        </p>
      </header>

      {/* Toolbar */}
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="flex items-center gap-3">
          <p className="text-sm text-gray-500 dark:text-gray-400">
            {isLoading ? "Loading jobs" : <>Showing <span className="font-semibold text-gray-900 dark:text-gray-100">{jobs.length}</span> jobs</>}
          </p>
          <span className="hidden h-4 w-px bg-gray-300 sm:block dark:bg-gray-700" />
          <span className="hidden text-sm text-gray-500 sm:inline dark:text-gray-400">Newest first</span>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Segmented options={STATUSES} value={status} onChange={setStatus} label="Filter by status" />
          <Button asChild variant="solid">
            <Link href="/playground">Run a demo</Link>
          </Button>
        </div>
      </div>

      {/* Jobs table */}
      <Table>
        <TableHeader>
          <TableRow>
            {["Name / ID", "Status", "Image", "Priority", "Duration", "Submitted"].map((h) => (
              <TableHead key={h}>{h}</TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {isLoading && (
            <TableRow>
              <TableCell colSpan={6} className="py-12 text-center text-muted-foreground">
                <span className="inline-flex items-center gap-2">
                  <Spinner label="Loading jobs" />
                  Loading jobs
                </span>
              </TableCell>
            </TableRow>
          )}
          {!isLoading && jobs.length === 0 && (
            <TableRow>
              <TableCell colSpan={6} className="py-12 text-center text-muted-foreground">
                No jobs found
              </TableCell>
            </TableRow>
          )}
          {jobs.map((j) => (
            <TableRow key={j.id}>
              <TableCell>
                <Link href={`/jobs/${j.id}`} className="group block outline-none">
                  <span className="block font-medium transition-colors duration-200 group-hover:text-brand group-focus-visible:text-brand">
                    {j.name ?? "Unnamed"}
                  </span>
                  <span className="mt-0.5 block font-mono text-xs text-muted-foreground">
                    {j.id.slice(0, 8)}
                  </span>
                </Link>
              </TableCell>
              <TableCell>
                <JobStatusBadge status={j.status as JobStatus} />
              </TableCell>
              <TableCell className="max-w-[160px] truncate font-mono text-xs text-muted-foreground">
                {j.image_name}
              </TableCell>
              <TableCell
                className={cn(
                  "font-semibold tabular-nums",
                  j.priority >= 8
                    ? "text-red-700 dark:text-red-400"
                    : j.priority >= 5
                      ? "text-yellow-800 dark:text-yellow-200"
                      : "text-muted-foreground",
                )}
              >
                {j.priority}
              </TableCell>
              <TableCell className="whitespace-nowrap tabular-nums">
                {duration(j.started_at, j.completed_at ?? (j.status === "running" ? null : j.scheduled_at))}
              </TableCell>
              <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{ago(j.submitted_at)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
