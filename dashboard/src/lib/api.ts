import type { Job, JobEvent, MetricsSummary, Worker } from "./types";

const BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080";

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`API ${res.status}: ${res.statusText}`);
  return res.json() as Promise<T>;
}

export const api = {
  metrics: () => get<MetricsSummary>("/metrics/summary"),
  workers: () => get<Worker[]>("/workers"),
  jobs: (params?: { status?: string; limit?: number; offset?: number }) => {
    const q = new URLSearchParams();
    if (params?.status) q.set("status", params.status);
    if (params?.limit != null) q.set("limit", String(params.limit));
    if (params?.offset != null) q.set("offset", String(params.offset));
    const qs = q.toString();
    return get<Job[]>(`/jobs${qs ? `?${qs}` : ""}`);
  },
  job: (id: string) => get<{ job: Job; events: JobEvent[] }>(`/jobs/${id}`),
  jobArtifacts: (id: string) =>
    get<{ object_key: string; download_url: string; expires_in: string }>(
      `/jobs/${id}/artifacts`
    ),
};

export function wsUrl(): string {
  return BASE.replace(/^http/, "ws") + "/ws";
}
