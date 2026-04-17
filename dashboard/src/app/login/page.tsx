"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { api, setToken } from "@/lib/api";

export default function LoginPage() {
  const router = useRouter();
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      const token = await api.login(apiKey);
      setToken(token);
      router.replace("/");
    } catch {
      setError("Invalid API key — check COORDINATOR_SECRET.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div
      className="fixed inset-0 flex items-center justify-center overflow-hidden"
      style={{ background: "var(--bg-primary)" }}
    >
      {/* Animated orbs */}
      <div className="orb-1" style={{ top: "10%", left: "15%" }} />
      <div className="orb-2" style={{ bottom: "10%", right: "15%" }} />
      <div className="orb-1" style={{ top: "50%", right: "25%", width: "250px", height: "250px", animationDelay: "5s" }} />

      {/* Background grid pattern */}
      <div className="absolute inset-0 opacity-[0.03]"
        style={{
          backgroundImage: `linear-gradient(rgba(255,255,255,0.1) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.1) 1px, transparent 1px)`,
          backgroundSize: "60px 60px",
        }}
      />

      {/* Login card */}
      <div className="relative z-10 w-full max-w-[400px] mx-4 animate-fade-in-up">
        <div
          className="rounded-2xl p-8"
          style={{
            background: "rgba(17, 24, 39, 0.7)",
            backdropFilter: "blur(24px)",
            border: "1px solid rgba(255, 255, 255, 0.06)",
            boxShadow: "0 25px 50px rgba(0, 0, 0, 0.4), 0 0 80px rgba(99, 102, 241, 0.06)",
          }}
        >
          {/* Brand */}
          <div className="flex items-center gap-3 mb-2">
            <div
              className="w-11 h-11 rounded-xl flex items-center justify-center text-xl"
              style={{ background: "var(--accent-gradient)" }}
            >
              ⚙
            </div>
            <div>
              <h1 className="text-lg font-bold tracking-tight" style={{ color: "var(--text-primary)" }}>
                Foreman
              </h1>
              <p className="text-xs" style={{ color: "var(--text-muted)" }}>Job Scheduler</p>
            </div>
          </div>

          <p className="mt-5 mb-6 text-sm leading-relaxed" style={{ color: "var(--text-secondary)" }}>
            Enter your{" "}
            <code
              className="rounded px-1.5 py-0.5 text-xs font-mono"
              style={{ background: "rgba(255,255,255,0.06)", color: "var(--accent-primary)" }}
            >
              COORDINATOR_SECRET
            </code>{" "}
            to access the dashboard.
          </p>

          <form onSubmit={handleSubmit} className="space-y-5">
            <div>
              <label className="block text-xs font-medium uppercase tracking-wider mb-2"
                style={{ color: "var(--text-muted)" }}
              >
                API Key
              </label>
              <input
                type="password"
                placeholder="sk-••••••••••••••••"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                autoFocus
                className="w-full rounded-xl px-4 py-3 text-sm outline-none transition-all duration-300 placeholder:text-[var(--text-muted)]"
                style={{
                  background: "rgba(255, 255, 255, 0.04)",
                  border: "1px solid var(--border-subtle)",
                  color: "var(--text-primary)",
                }}
                onFocus={(e) => {
                  e.target.style.borderColor = "var(--accent-primary)";
                  e.target.style.boxShadow = "0 0 0 3px rgba(99, 102, 241, 0.15)";
                }}
                onBlur={(e) => {
                  e.target.style.borderColor = "var(--border-subtle)";
                  e.target.style.boxShadow = "none";
                }}
              />
            </div>

            {error && (
              <div
                className="flex items-center gap-2 rounded-xl px-4 py-3 text-sm animate-fade-in"
                style={{
                  background: "rgba(239, 68, 68, 0.08)",
                  border: "1px solid rgba(239, 68, 68, 0.15)",
                  color: "#fca5a5",
                }}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="15" y1="9" x2="9" y2="15" />
                  <line x1="9" y1="9" x2="15" y2="15" />
                </svg>
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading || !apiKey}
              className="btn-gradient w-full py-3 text-sm font-semibold flex items-center justify-center gap-2"
            >
              {loading ? (
                <>
                  <div className="w-4 h-4 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                  Signing in…
                </>
              ) : (
                <>
                  Sign in
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="5" y1="12" x2="19" y2="12" />
                    <polyline points="12 5 19 12 12 19" />
                  </svg>
                </>
              )}
            </button>
          </form>
        </div>

        {/* Subtle footer */}
        <p className="text-center mt-6 text-xs" style={{ color: "var(--text-muted)" }}>
          Foreman Distributed Job Scheduler
        </p>
      </div>
    </div>
  );
}
