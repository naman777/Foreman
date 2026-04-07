#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Foreman Benchmark Suite
=======================
Three experiments:

  throughput   Submit N jobs, measure wall time / throughput / per-job latency.
               Run multiple times (1 worker, 2 workers, 4 workers) and compare.

  recovery     Submit long-running jobs, kill a worker mid-run, verify that
               orphaned jobs are requeued automatically within 30 s.

  resource     Submit a job whose required_memory exceeds every worker's
               capacity; verify the scheduler leaves it queued (not failed).

Usage examples
--------------
  # Run with current worker count (coordinator must be running):
  python scripts/benchmark.py --experiment throughput --jobs 20

  # Full suite — prompts between throughput runs to change worker count:
  python scripts/benchmark.py --full --jobs 20

  # Use non-default URL / secret:
  python scripts/benchmark.py --url http://coordinator:8080 --secret my-secret
"""

from __future__ import annotations

import argparse
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from statistics import mean, median
from typing import Optional

try:
    import requests
except ImportError:
    sys.exit("Install requests first:  pip install requests")


# ── Configuration ─────────────────────────────────────────────────────────────

BASE         = "http://localhost:8080"
SECRET       = "dev-secret-change-in-prod"
TEST_IMAGE   = "python:3.11-slim"
JOB_SLEEP_S  = 2          # seconds each benchmarked job sleeps
RECOVERY_SLEEP_S = 30     # seconds recovery jobs sleep (long enough to be interrupted)


# ── Auth ──────────────────────────────────────────────────────────────────────

_token: Optional[str] = None

def session() -> requests.Session:
    """Return an authenticated requests.Session, logging in if needed."""
    global _token
    s = requests.Session()
    s.headers["Content-Type"] = "application/json"
    if _token is None:
        resp = s.post(f"{BASE}/auth/login", json={"api_key": SECRET}, timeout=10)
        if resp.status_code == 401:
            sys.exit("Auth failed — check --secret / COORDINATOR_SECRET.")
        resp.raise_for_status()
        _token = resp.json()["token"]
    s.headers["Authorization"] = f"Bearer {_token}"
    return s


# ── Low-level API helpers ──────────────────────────────────────────────────────

def submit_job(
    s: requests.Session,
    name: str,
    command: str,
    *,
    image: str = TEST_IMAGE,
    required_cpu: int = 1,
    required_memory: int = 128,
    priority: int = 5,
    timeout_seconds: int = 120,
) -> str:
    resp = s.post(f"{BASE}/jobs", json={
        "name": name,
        "image_name": image,
        "command": command,
        "required_cpu": required_cpu,
        "required_memory": required_memory,
        "priority": priority,
        "timeout_seconds": timeout_seconds,
    }, timeout=10)
    resp.raise_for_status()
    return resp.json()["id"]


def fetch_job(s: requests.Session, job_id: str) -> dict:
    resp = s.get(f"{BASE}/jobs/{job_id}", timeout=10)
    resp.raise_for_status()
    return resp.json()["job"]


def fetch_metrics(s: requests.Session) -> dict:
    return s.get(f"{BASE}/metrics/summary", timeout=10).json()


def fetch_workers(s: requests.Session) -> list[dict]:
    return s.get(f"{BASE}/workers", timeout=10).json()


def wait_terminal(s: requests.Session, job_id: str, timeout: int = 600) -> dict:
    """Block until job is in a terminal state or timeout is reached."""
    terminal = {"completed", "failed", "timed_out", "cancelled"}
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        job = fetch_job(s, job_id)
        if job["status"] in terminal:
            return job
        time.sleep(1)
    raise TimeoutError(f"job {job_id} did not finish in {timeout}s")


def parse_iso(ts: Optional[str]) -> Optional[datetime]:
    if not ts:
        return None
    return datetime.fromisoformat(ts.replace("Z", "+00:00"))


def latency_ms(job: dict) -> Optional[float]:
    """Wall time between started_at and completed_at in milliseconds."""
    s = parse_iso(job.get("started_at"))
    e = parse_iso(job.get("completed_at"))
    if s and e:
        return (e - s).total_seconds() * 1000
    return None


# ── Display helpers ────────────────────────────────────────────────────────────

W = 62

def rule(char="─"): print(char * W)
def header(t): rule("═"); print(f"  {t}"); rule("═")
def section(t): print(f"\n  ── {t}")


def progress(done: int, total: int, label: str = ""):
    sys.stdout.write(f"\r  {label}{done}/{total}")
    sys.stdout.flush()


def fmt_pct(num: int, denom: int) -> str:
    return f"{num}/{denom}  ({100 * num // denom if denom else 0}%)"


# ── Experiment 1: Throughput ───────────────────────────────────────────────────

def run_throughput(n_jobs: int) -> dict:
    s = session()
    workers = fetch_workers(s)
    active  = [w for w in workers if w["status"] in ("online", "busy")]

    print(f"  Active workers : {len(active)}")
    print(f"  Job count      : {n_jobs}")
    print(f"  Image          : {TEST_IMAGE}")
    print(f"  Job duration   : ~{JOB_SLEEP_S}s each")

    if not active:
        print("\n  ⚠  No online workers — start at least one and re-run.")
        return {}

    section("Submitting jobs")
    wall_start = time.monotonic()
    job_ids = []
    for i in range(n_jobs):
        jid = submit_job(
            s, f"bench-tp-{i}",
            f'python -c "import time; time.sleep({JOB_SLEEP_S}); print(1)"',
        )
        job_ids.append(jid)
        progress(i + 1, n_jobs, "  Submitted ")
    print()

    section("Waiting for completion")
    results: dict[str, dict] = {}

    def collect(jid: str):
        try:
            return jid, wait_terminal(s, jid, timeout=600)
        except TimeoutError as e:
            return jid, {"status": "benchmark_timeout", "id": jid}

    with ThreadPoolExecutor(max_workers=min(n_jobs, 64)) as pool:
        futs = {pool.submit(collect, jid): jid for jid in job_ids}
        done = 0
        for fut in as_completed(futs):
            jid, job = fut.result()
            results[jid] = job
            done += 1
            progress(done, n_jobs, "  Completed ")
    print()

    wall_time   = time.monotonic() - wall_start
    completed   = [j for j in results.values() if j["status"] == "completed"]
    failed      = [j for j in results.values() if j["status"] == "failed"]
    latencies   = [ms for j in completed if (ms := latency_ms(j)) is not None]
    throughput  = n_jobs / wall_time * 60

    section("Results")
    rule()
    print(f"  Workers            : {len(active)}")
    print(f"  Completed          : {fmt_pct(len(completed), n_jobs)}")
    print(f"  Failed             : {len(failed)}")
    print(f"  Wall time          : {wall_time:.1f}s")
    print(f"  Throughput         : {throughput:.1f} jobs/min")
    if latencies:
        lats_s = [ms / 1000 for ms in latencies]
        p95    = sorted(lats_s)[max(0, int(len(lats_s) * 0.95) - 1)]
        print(f"  Latency avg        : {mean(lats_s):.2f}s")
        print(f"  Latency median     : {median(lats_s):.2f}s")
        print(f"  Latency p95        : {p95:.2f}s")
    rule()

    return {
        "workers":     len(active),
        "n_jobs":      n_jobs,
        "completed":   len(completed),
        "wall_time":   wall_time,
        "throughput":  throughput,
        "latencies_s": [ms / 1000 for ms in latencies],
    }


# ── Experiment 2: Failure recovery ────────────────────────────────────────────

def run_recovery(n_jobs: int = 10) -> dict:
    s = session()
    workers = fetch_workers(s)
    active  = [w for w in workers if w["status"] in ("online", "busy")]

    print(f"  Active workers : {len(active)}")
    print(f"  Job count      : {n_jobs}")

    if len(active) < 2:
        print("\n  ⚠  Recovery test needs ≥ 2 workers (one to kill, one to take over).")
        return {}

    section("Submitting long-running jobs")
    job_ids = []
    for i in range(n_jobs):
        jid = submit_job(
            s, f"bench-rec-{i}",
            f'python -c "import time; time.sleep({RECOVERY_SLEEP_S})"',
            timeout_seconds=120,
        )
        job_ids.append(jid)
    print(f"  Submitted {n_jobs} jobs  (each sleeps {RECOVERY_SLEEP_S}s)")

    section("Waiting for jobs to be running")
    deadline = time.monotonic() + 90
    while time.monotonic() < deadline:
        m = fetch_metrics(s)
        running = m.get("running", 0) + m.get("scheduled", 0)
        sys.stdout.write(f"\r  running/scheduled={running}  queued={m.get('queued',0)}  ")
        sys.stdout.flush()
        if running >= max(1, n_jobs // 2):
            break
        time.sleep(2)
    print()

    m = fetch_metrics(s)
    running_before = m.get("running", 0)
    print(f"\n  {running_before} job(s) are running.")

    print(f"""
  ┌─────────────────────────────────────────────────────────┐
  │  ACTION REQUIRED                                        │
  │  Kill ONE worker process now, then press Enter.         │
  │  (Ctrl-C in the worker terminal or use: kill <PID>)     │
  └─────────────────────────────────────────────────────────┘""")
    try:
        input("\n  Press Enter after killing the worker... ")
    except (EOFError, KeyboardInterrupt):
        print()

    kill_t = time.monotonic()
    print("\n  Monitoring recovery for up to 90s...")

    first_requeue_t: Optional[float] = None
    deadline = kill_t + 90

    while time.monotonic() < deadline:
        time.sleep(3)
        m  = fetch_metrics(s)
        elapsed = time.monotonic() - kill_t
        sys.stdout.write(
            f"\r  t={elapsed:.0f}s  queued={m.get('queued',0)}"
            f"  running={m.get('running',0)}"
            f"  completed={m.get('completed',0)}"
            f"  failed={m.get('failed',0)}    "
        )
        sys.stdout.flush()
        if m.get("queued", 0) > 0 and first_requeue_t is None:
            first_requeue_t = elapsed
        if (m.get("running", 0) == 0 and m.get("queued", 0) == 0
                and m.get("scheduled", 0) == 0):
            break

    print()

    final     = [fetch_job(s, jid) for jid in job_ids]
    completed = sum(1 for j in final if j["status"] == "completed")
    failed    = sum(1 for j in final if j["status"] == "failed")
    retried   = sum(1 for j in final if j.get("retries", 0) > 0)

    section("Results")
    rule()
    print(f"  Total jobs             : {n_jobs}")
    print(f"  Orphaned & requeued    : {fmt_pct(retried, n_jobs)}")
    print(f"  Eventually completed   : {completed}")
    print(f"  Eventually failed      : {failed}")
    if first_requeue_t is not None:
        print(f"  First requeue at       : {first_requeue_t:.1f}s after worker killed")
        verdict = "✓ within 30s" if first_requeue_t <= 30 else f"✗ {first_requeue_t:.0f}s (expected ≤30s)"
        print(f"  Recovery SLA (≤30s)    : {verdict}")
    rule()

    return {
        "n_jobs":          n_jobs,
        "retried":         retried,
        "completed":       completed,
        "failed":          failed,
        "first_requeue_s": first_requeue_t,
    }


# ── Experiment 3: Resource limit enforcement ───────────────────────────────────

def run_resource_limit() -> dict:
    s = session()
    section("Submitting job with 999,999 MB required_memory")
    jid = submit_job(
        s, "bench-resource-limit",
        'python -c "print(\'should not run\')"',
        required_memory=999_999,
        required_cpu=1,
    )
    print(f"  Job ID : {jid}")
    print(f"  Polling for 20s — expecting status to stay 'queued'...")

    snapshots = []
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        job = fetch_job(s, jid)
        snapshots.append(job["status"])
        sys.stdout.write(f"\r  status={job['status']}  worker_id={job.get('worker_id','—')}  ")
        sys.stdout.flush()
        time.sleep(2)
    print()

    stayed_queued  = all(st == "queued" for st in snapshots)
    final_status   = fetch_job(s, jid)["status"]

    section("Results")
    rule()
    print(f"  Final status    : {final_status}")
    print(f"  Stayed queued   : {'✓ YES — scheduler correctly skipped this job' if stayed_queued else '✗ NO'}")
    print(f"  Expected        : queued indefinitely (no worker has enough memory)")
    rule()

    return {"job_id": jid, "final_status": final_status, "stayed_queued": stayed_queued}


# ── Speedup summary table ──────────────────────────────────────────────────────

def print_speedup(runs: list[dict]) -> None:
    valid = sorted([r for r in runs if r.get("wall_time")], key=lambda r: r["workers"])
    if len(valid) < 2:
        return
    baseline = next((r for r in valid if r["workers"] == 1), valid[0])

    section("Speedup vs single-worker baseline")
    rule()
    print(f"  {'Workers':>8}  {'Wall time':>11}  {'Throughput':>14}  {'Speedup':>9}  {'Efficiency':>11}")
    rule("-")
    for r in valid:
        speedup    = baseline["wall_time"] / r["wall_time"]
        efficiency = speedup / r["workers"] * 100
        print(
            f"  {r['workers']:>8}"
            f"  {r['wall_time']:>10.1f}s"
            f"  {r['throughput']:>12.1f}/m"
            f"  {speedup:>8.2f}×"
            f"  {efficiency:>9.0f}%"
        )
    rule()


# ── Entry point ────────────────────────────────────────────────────────────────

def main() -> None:
    p = argparse.ArgumentParser(
        description="Foreman benchmark suite",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    p.add_argument("--experiment", choices=["throughput", "recovery", "resource"],
                   default="throughput", metavar="EXP",
                   help="throughput | recovery | resource  (default: throughput)")
    p.add_argument("--jobs",   type=int,   default=20,
                   help="Number of jobs for throughput test (default: 20)")
    p.add_argument("--url",    default=BASE,   help="Coordinator URL")
    p.add_argument("--secret", default=SECRET, help="COORDINATOR_SECRET")
    p.add_argument("--sleep",  type=float, default=JOB_SLEEP_S,
                   help="Seconds each throughput job sleeps (default: 2)")
    p.add_argument("--full",   action="store_true",
                   help="Run all three experiments (prompts between throughput runs)")
    args = p.parse_args()

    global BASE, SECRET, JOB_SLEEP_S, _token
    BASE        = args.url
    SECRET      = args.secret
    JOB_SLEEP_S = args.sleep
    _token      = None

    if args.full:
        header("Foreman Full Benchmark Suite")

        tp_results = []
        worker_counts = [1, 2, 4]
        for n in worker_counts:
            print(f"\n  ── Throughput run — {n} worker(s) ─────────────────────────────")
            print(f"  Set up {n} worker(s), then press Enter to run this batch.")
            try:
                input("  (Enter) ")
            except (EOFError, KeyboardInterrupt):
                print()
            _token = None  # fresh login for each run
            r = run_throughput(args.jobs)
            if r:
                tp_results.append(r)

        print_speedup(tp_results)

        print("\n")
        header("Recovery Experiment")
        run_recovery()

        print("\n")
        header("Resource Limit Experiment")
        run_resource_limit()

    elif args.experiment == "throughput":
        header("Throughput Benchmark")
        run_throughput(args.jobs)

    elif args.experiment == "recovery":
        header("Recovery Benchmark")
        run_recovery()

    elif args.experiment == "resource":
        header("Resource Limit Test")
        run_resource_limit()


if __name__ == "__main__":
    main()
