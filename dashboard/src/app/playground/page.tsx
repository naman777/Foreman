"use client";

import { useState } from "react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type DemoScenario } from "@/lib/api";
import type { Job, JobEvent, WSEvent, Worker } from "@/lib/types";
import { JobStatusBadge } from "@/components/StatusBadge";
import { useWebSocket } from "@/hooks/useWebSocket";
import { ago } from "@/lib/utils";

const scenarios: Array<{ id: DemoScenario; title: string; detail: string; tone: string }> = [
  { id: "artifact", title: "Complete + download", detail: "Run a job on a worker, store its result, and download the artifact.", tone: "#34d399" },
  { id: "failure", title: "Handle failure", detail: "See how a worker reports a command with a nonzero exit code.", tone: "#fb7185" },
  { id: "timeout", title: "Enforce timeout", detail: "Watch Foreman stop a job that exceeds its two-second limit.", tone: "#fbbf24" },
  { id: "retry", title: "Exercise retries", detail: "Follow a failed run through its one-retry policy.", tone: "#a78bfa" },
  { id: "priority", title: "Priority scheduling", detail: "Queue a priority-nine job and inspect its assignment.", tone: "#60a5fa" },
];

export default function PlaygroundPage() {
  const client = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState<DemoScenario | null>(null);
  const [message, setMessage] = useState("");
  const [artifactUrl, setArtifactUrl] = useState("");
  const { data: workers = [] } = useQuery<Worker[]>({ queryKey: ["workers"], queryFn: api.workers, refetchInterval: 5000 });
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
    setMessage("");
    setArtifactUrl("");
    try {
      const job = await api.submitDemo(scenario);
      setSelected(job.id);
      setMessage(`${job.name} was added to the queue.`);
      client.invalidateQueries({ queryKey: ["jobs"] });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not start the demo.");
    } finally {
      setSubmitting(null);
    }
  }

  async function downloadArtifact() {
    if (!selected) return;
    try {
      setArtifactUrl((await api.jobArtifacts(selected)).download_url);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Artifact unavailable.");
    }
  }

  const job = detail?.job;
  const activeWorkers = workers.filter((worker) => worker.status === "online" || worker.status === "busy").length;
  return (
    <div className="space-y-8">
      <div className="glass-card-static overflow-hidden p-7 md:p-9 relative">
        <div className="absolute -right-20 -top-28 h-72 w-72 rounded-full blur-3xl opacity-20" style={{ background: "#6366f1" }} />
        <div className="relative">
          <span className="text-xs font-semibold uppercase tracking-[0.18em]" style={{ color: "#a5b4fc" }}>Interactive project demo</span>
          <h1 className="mt-3 text-3xl md:text-4xl font-bold tracking-tight" style={{ color: "var(--text-primary)" }}>Run Foreman yourself</h1>
          <p className="mt-3 max-w-2xl text-sm md:text-base leading-7" style={{ color: "var(--text-secondary)" }}>Launch a real container job, watch the scheduler assign it to a worker, and inspect its result. No account is needed.</p>
          <div className="mt-6 flex flex-wrap gap-3 text-xs">
            <span className="rounded-full border px-3 py-1.5" style={{ borderColor: "var(--border-accent)", color: "#c7d2fe" }}>{activeWorkers} workers online</span>
            <span className="rounded-full border px-3 py-1.5" style={{ borderColor: "var(--border-subtle)", color: "var(--text-secondary)" }}>Live job events</span>
            <span className="rounded-full border px-3 py-1.5" style={{ borderColor: "var(--border-subtle)", color: "var(--text-secondary)" }}>Bounded demo jobs</span>
          </div>
        </div>
      </div>
      <section>
        <div className="mb-4 flex items-end justify-between gap-4">
          <div><h2 className="text-xl font-semibold" style={{ color: "var(--text-primary)" }}>Choose a scenario</h2><p className="mt-1 text-sm" style={{ color: "var(--text-muted)" }}>Each action starts a real job with fixed resource limits.</p></div>
          <Link href="/workers" className="text-sm hover:underline" style={{ color: "#a5b4fc" }}>View workers →</Link>
        </div>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {scenarios.map((scenario) => <div key={scenario.id} className="glass-card p-5 flex flex-col">
            <span className="h-2 w-2 rounded-full" style={{ background: scenario.tone, boxShadow: `0 0 14px ${scenario.tone}` }} />
            <p className="mt-4 text-xs font-medium uppercase tracking-widest" style={{ color: scenario.tone }}>{scenario.id}</p>
            <h3 className="mt-2 text-lg font-semibold" style={{ color: "var(--text-primary)" }}>{scenario.title}</h3>
            <p className="mt-2 mb-5 text-sm leading-6 flex-1" style={{ color: "var(--text-secondary)" }}>{scenario.detail}</p>
            <button type="button" onClick={() => launch(scenario.id)} disabled={!!submitting} className="btn-gradient w-fit disabled:opacity-50 disabled:cursor-wait">{submitting === scenario.id ? "Starting…" : "Run this demo →"}</button>
          </div>)}
        </div>
        {message && <p className="mt-4 text-sm" role="status" style={{ color: "#c7d2fe" }}>{message}</p>}
      </section>
      <section className="grid gap-5 lg:grid-cols-[1.4fr_1fr]">
        <div className="glass-card-static p-6">
          <div className="flex items-center justify-between gap-3"><h2 className="text-lg font-semibold" style={{ color: "var(--text-primary)" }}>Live job trace</h2>{job && <JobStatusBadge status={job.status} />}</div>
          {!job ? <p className="mt-5 text-sm leading-6" style={{ color: "var(--text-muted)" }}>Start a scenario or select a recent job to see its status and events here.</p> : <>
            <p className="mt-5 text-base font-medium" style={{ color: "var(--text-primary)" }}>{job.name}</p><p className="mt-1 text-xs font-mono" style={{ color: "var(--text-muted)" }}>{job.id}</p>
            <div className="mt-5 grid grid-cols-3 gap-3 text-xs">{[["Priority", job.priority], ["Retries", `${job.retries}/${job.max_retries}`], ["Timeout", `${job.timeout_seconds}s`]].map(([label, value]) => <div key={label} className="rounded-xl p-3" style={{ background: "var(--bg-glass)" }}><p style={{ color: "var(--text-muted)" }}>{label}</p><p className="mt-1 text-lg font-semibold" style={{ color: "var(--text-primary)" }}>{value}</p></div>)}</div>
            <ol className="mt-6 space-y-3 border-l pl-5" style={{ borderColor: "var(--border-accent)" }}>{(detail?.events ?? []).map((event) => <li key={event.id} className="relative text-sm" style={{ color: "var(--text-secondary)" }}><span className="absolute -left-[25px] top-1.5 h-2 w-2 rounded-full" style={{ background: "#818cf8" }} /><span className="capitalize" style={{ color: "var(--text-primary)" }}>{event.event_type.replaceAll("_", " ")}</span><span className="ml-2 text-xs" style={{ color: "var(--text-muted)" }}>{ago(event.timestamp)}</span></li>)}</ol>
            <div className="mt-6 flex flex-wrap items-center gap-3"><Link href={`/jobs/${job.id}`} className="text-sm hover:underline" style={{ color: "#a5b4fc" }}>Full job details →</Link>{job.artifact_path && (artifactUrl ? <a href={artifactUrl} target="_blank" rel="noopener noreferrer" className="text-sm hover:underline" style={{ color: "#6ee7b7" }}>Download result ↗</a> : <button type="button" onClick={downloadArtifact} className="text-sm hover:underline cursor-pointer" style={{ color: "#6ee7b7" }}>Get artifact link ↗</button>)}</div>
          </>}
        </div>
        <div className="glass-card-static p-6"><h2 className="text-lg font-semibold" style={{ color: "var(--text-primary)" }}>Recent demo jobs</h2><p className="mt-1 text-xs" style={{ color: "var(--text-muted)" }}>Select one to inspect its live trace.</p><div className="mt-5 space-y-2">{recent.slice(0, 8).map((item) => <button type="button" key={item.id} onClick={() => { setSelected(item.id); setArtifactUrl(""); }} className="w-full rounded-xl border p-3 text-left transition-colors hover:bg-white/5 cursor-pointer" style={{ borderColor: selected === item.id ? "var(--border-accent)" : "var(--border-subtle)" }}><span className="flex items-center justify-between gap-2"><span className="truncate text-sm" style={{ color: "var(--text-primary)" }}>{item.name}</span><JobStatusBadge status={item.status} /></span><span className="mt-1 block text-xs" style={{ color: "var(--text-muted)" }}>{ago(item.submitted_at)}</span></button>)}{recent.length === 0 && <p className="text-sm" style={{ color: "var(--text-muted)" }}>No demo jobs yet. Run the first one above.</p>}</div></div>
      </section>
    </div>
  );
}
