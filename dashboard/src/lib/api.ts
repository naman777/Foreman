import type { Job, JobEvent, MetricsSummary, Worker } from "./types";

const BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080";

// Token helpers — localStorage is only available in the browser.
export function getToken(): string {
  if (typeof window === "undefined") return "";
  return localStorage.getItem("foreman_token") ?? "";
}

export function setToken(token: string) {
  localStorage.setItem("foreman_token", token);
}

export function clearToken() {
  localStorage.removeItem("foreman_token");
}

function authHeaders(): Record<string, string> {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    cache: "no-store",
    headers: authHeaders(),
  });
  if (res.status === 401) {
    clearToken();
    if (typeof window !== "undefined") window.location.href = "/login";
    throw new Error("Unauthorized");
  }
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

  login: async (apiKey: string): Promise<string> => {
    const res = await fetch(`${BASE}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: apiKey }),
    });
    if (!res.ok) throw new Error("invalid api_key");
    const data = await res.json() as { token: string };
    return data.token;
  },
};

export function wsUrl(): string {
  const token = getToken();
  const base = BASE.replace(/^http/, "ws") + "/ws";
  return token ? `${base}?token=${encodeURIComponent(token)}` : base;
}
