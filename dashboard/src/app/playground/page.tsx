"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type DemoScenario } from "@/lib/api";
import type { Job, JobEvent, WSEvent, Worker } from "@/lib/types";
import { SectionHead } from "@/components/section-head";
import { JobStatusBadge } from "@/components/StatusBadge";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardFooter, CardText, CardTitle } from "@/components/ui/card";
import { Chip } from "@/components/ui/chip";
import { LiveDot } from "@/components/ui/live-dot";
import { useWebSocket } from "@/hooks/useWebSocket";
import { ago, cn } from "@/lib/utils";

type ChipTone = "default" | "success" | "danger" | "special";

const scenarios: Array<{ id: DemoScenario; title: string; detail: string; tone: ChipTone }> = [
  { id: "artifact", title: "Complete and download", detail: "Run a job on a worker, store its result, and download the artifact.", tone: "success" },
  { id: "failure", title: "Handle failure", detail: "See how a worker reports a command with a nonzero exit code.", tone: "danger" },
  { id: "timeout", title: "Enforce timeout", detail: "Watch Foreman stop a job that exceeds its two-second limit.", tone: "danger" },
  { id: "retry", title: "Exercise retries", detail: "Follow a failed run through its one-retry policy.", tone: "default" },
  { id: "priority", title: "Priority scheduling", detail: "Queue a priority-nine job and inspect its assignment.", tone: "special" },
];

const TEXT_LINK = "inline-flex cursor-pointer items-center gap-1 text-sm transition-colors duration-200 hover:text-brand";

export default function PlaygroundPage() {
  const client = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState<DemoScenario | null>(null);
  const [message, setMessage] = useState<{ text: string; tone: "info" | "danger" } | null>(null);
  const [artifactUrl, setArtifactUrl] = useState("");
  const { data: workers = [], isSuccess: workersLoaded } = useQuery<Worker[]>({ queryKey: ["workers"], queryFn: api.workers, refetchInterval: 5000 });
  const { data: recent = [] } = useQuery<Job[]>({ queryKey: ["jobs"], queryFn: () => api.jobs(), refetchInterval: 5000 });
  const { data: detail } = useQuery<{ job: Job; events: JobEvent[] }>({
    queryKey: ["job", selected], queryFn: () => api.job(selected!), enabled: !!selected, refetchInterval: 2000,
  });
  useWebSocket((event: WSEvent) => {
    if (event.type === "job_updated") {
      client.invalidateQueries({ queryKey: ["jobs"] });
      client.invalidateQueries({ queryKey: ["job", selected] });
      client.invalidateQueries({ queryKey: ["metrics"] });
    }
  });

  async function launch(scenario: DemoScenario) {
    setSubmitting(scenario);
    setMessage(null);
    setArtifactUrl("");
    try {
      const job = await api.submitDemo(scenario);
      setSelected(job.id);
      setMessage({ text: `${job.name} was added to the queue.`, tone: "info" });
      client.invalidateQueries({ queryKey: ["jobs"] });
    } catch (error) {
      setMessage({ text: error instanceof Error ? error.message : "Could not start the demo.", tone: "danger" });
    } finally {
      setSubmitting(null);
    }
  }

  async function downloadArtifact() {
    if (!selected) return;
    try {
      setArtifactUrl((await api.jobArtifacts(selected)).download_url);
    } catch (error) {
      setMessage({ text: error instanceof Error ? error.message : "Artifact unavailable.", tone: "danger" });
    }
  }

  const job = detail?.job;
  const activeWorkers = workers.filter((worker) => worker.status === "online" || worker.status === "busy").length;
  return (
    <div className="space-y-12 sm:space-y-16">
      {/* Hero */}
      <section className="flex flex-col gap-y-2.5 sm:gap-y-4">
        <h1 className="text-[42px] font-semibold tracking-tight max-md:leading-11 md:text-6xl lg:text-7xl">
          Run Foreman yourself
        </h1>
        <p className="mt-4 max-w-3xl text-base text-neutral-700 sm:mt-6 md:text-xl dark:text-neutral-400">
          Launch a real container job, watch the scheduler assign it to a worker, and{" "}
          <span className="highlight">inspect its result</span>. No account is needed.
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2">
          {workersLoaded && <LiveDot tone="success">{activeWorkers} workers online</LiveDot>}
          <Chip>Live job events</Chip>
          <Chip>Bounded demo jobs</Chip>
        </div>
      </section>

      {/* Scenarios */}
      <section aria-labelledby="scenarios">
        <SectionHead id="scenarios" title="Choose a scenario" action={{ label: "View workers", href: "/workers" }}>
          Each action starts a <span className="highlight">real job</span> with fixed resource limits.
        </SectionHead>
        <div className="mt-6 grid gap-6 md:grid-cols-2 lg:grid-cols-3">
          {scenarios.map((scenario) => (
            <Card key={scenario.id}>
              <CardBody className="gap-2 p-5">
                <Chip tone={scenario.tone} className="w-fit capitalize">{scenario.id}</Chip>
                <CardTitle className="mt-2 text-lg">{scenario.title}</CardTitle>
                <CardText className="line-clamp-none text-sm">{scenario.detail}</CardText>
                <CardFooter className="justify-start">
                  <Button type="button" onClick={() => launch(scenario.id)} disabled={!!submitting}>
                    {submitting === scenario.id ? "Starting" : "Run this demo"}
                  </Button>
                </CardFooter>
              </CardBody>
            </Card>
          ))}
        </div>
        {message && <Alert tone={message.tone} className="mt-6">{message.text}</Alert>}
      </section>

      {/* Trace + recent */}
      <section className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
        <div className="card-chai min-w-0 p-6">
          <div className="flex items-center justify-between gap-3">
            <h2 className="font-montserrat text-base font-semibold">Live job trace</h2>
            {job && <JobStatusBadge status={job.status} />}
          </div>
          {!job ? (
            <p className="mt-5 text-sm leading-6 text-muted-foreground">
              Start a scenario or select a recent job to see its status and events here.
            </p>
          ) : (
            <>
              <p className="mt-5 text-base font-medium">{job.name}</p>
              <p className="mt-1 font-mono text-xs break-all text-muted-foreground">{job.id}</p>
              <dl className="mt-5 grid grid-cols-3 divide-x divide-card-edge">
                {[["Priority", job.priority], ["Retries", `${job.retries}/${job.max_retries}`], ["Timeout", `${job.timeout_seconds}s`]].map(([label, value]) => (
                  <div key={label} className="flex flex-col-reverse gap-1 px-4 first:pl-0">
                    <dt className="text-xs text-muted-foreground">{label}</dt>
                    <dd className="font-montserrat text-xl font-semibold tabular-nums">{value}</dd>
                  </div>
                ))}
              </dl>
              <ol className="mt-6 ml-1 space-y-3 border-l border-card-edge">
                {(detail?.events ?? []).map((event) => (
                  <li key={event.id} className="relative pl-5 text-sm">
                    <span className="absolute top-1.5 -left-[4.5px] size-2 rounded-full border border-card-edge-hover bg-background" aria-hidden="true" />
                    <span className="inline-block first-letter:uppercase">{event.event_type.replace(/^job_/, "").replaceAll("_", " ")}</span>
                    <span className="ml-2 text-xs text-muted-foreground">{ago(event.timestamp)}</span>
                  </li>
                ))}
              </ol>
              <div className="mt-6 flex flex-wrap items-center gap-x-5 gap-y-2">
                <Link href={`/jobs/${job.id}`} className={TEXT_LINK}>
                  Full job details <ArrowUpRight className="size-4" aria-hidden="true" />
                </Link>
                {job.artifact_path && (artifactUrl ? (
                  <a href={artifactUrl} target="_blank" rel="noopener noreferrer" className={cn(TEXT_LINK, "text-green-700 dark:text-green-400")}>
                    Download result <ArrowUpRight className="size-4" aria-hidden="true" />
                  </a>
                ) : (
                  <button type="button" onClick={downloadArtifact} className={TEXT_LINK}>
                    Get artifact link <ArrowUpRight className="size-4" aria-hidden="true" />
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        <div className="card-chai min-w-0 p-6">
          <h2 className="font-montserrat text-base font-semibold">Recent demo jobs</h2>
          <p className="mt-1 text-xs text-muted-foreground">Select one to inspect its live trace.</p>
          <div className="mt-5 space-y-2">
            {recent.slice(0, 8).map((item) => (
              <button
                type="button"
                key={item.id}
                aria-pressed={selected === item.id}
                onClick={() => { setSelected(item.id); setArtifactUrl(""); }}
                className="w-full cursor-pointer rounded-lg border border-border p-3 text-left transition-colors duration-200 outline-none hover:border-card-edge-hover focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-pressed:border-card-edge-hover aria-pressed:bg-black/[0.03] dark:aria-pressed:bg-white/[0.04]"
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm">{item.name}</span>
                  <JobStatusBadge status={item.status} />
                </span>
                <span className="mt-1 block text-xs text-muted-foreground">{ago(item.submitted_at)}</span>
              </button>
            ))}
            {recent.length === 0 && (
              <p className="text-sm text-muted-foreground">No demo jobs yet. Run the first one above.</p>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
