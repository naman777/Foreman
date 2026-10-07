import type { Job, JobEvent, MetricsSummary, Worker } from "./types";

const BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080";

async function send(path: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(`${BASE}/demo${path}`, { cache: "no-store", ...init });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(body?.error ?? `Request failed (${response.status})`);
  }
  return response;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  return (await send(path, init)).json() as Promise<T>;
}

export type DemoScenario = "artifact" | "failure" | "timeout" | "retry" | "priority";

export const api = {
  metrics: () => request<MetricsSummary>("/metrics/summary"),
  workers: () => request<Worker[]>("/workers"),
  jobs: (params?: { status?: string; limit?: number; offset?: number }) => {
    const q = new URLSearchParams();
    if (params?.status) q.set("status", params.status);
    if (params?.limit != null) q.set("limit", String(params.limit));
    if (params?.offset != null) q.set("offset", String(params.offset));
    const qs = q.toString();
    return request<Job[]>(`/jobs${qs ? `?${qs}` : ""}`).then((jobs) =>
      params?.status ? jobs.filter((job) => job.status === params.status) : jobs);
  },
  job: (id: string) => request<{ job: Job; events: JobEvent[] }>(`/jobs/${id}`),
  jobArtifacts: (id: string) =>
    request<{ object_key: string; download_url: string; expires_in: string }>(
      `/jobs/${id}/artifacts`
    ),
  cancelJob: (id: string) => request<Job>(`/jobs/${id}/cancel`, { method: "POST" }),
  jobLogs: async (id: string) => (await send(`/jobs/${id}/logs`)).text(),
  submitDemo: (scenario: DemoScenario) => request<Job>("/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scenario }),
  }),
};

export function wsUrl(): string {
  return BASE.replace(/^http/, "ws") + "/demo/ws";
}
