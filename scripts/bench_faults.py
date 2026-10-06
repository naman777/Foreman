#!/usr/bin/env python3
"""
Foreman fault-tolerance benchmarks.

  recovery     Kill a worker mid-job; time until the job is requeued and finished.
  duplicates   Submit N jobs across all coordinators; count executions per job.
  throughput   Jobs/min and submit->start scheduling latency.
  capacity     Burst sweep: peak concurrent running jobs and when the queue builds.

Ground truth for "how many times did a job run" is a beacon: every job's command
calls back to a collector started by this script, so containers that outlive a
killed worker are counted too. Requires the stack to be up, e.g.

  docker compose -f docker-compose.yml -f docker-compose.bench.yml up -d --build

  python scripts/bench_faults.py duplicates --jobs 500 \
      --url http://localhost:8080 --url http://localhost:8081
  python scripts/bench_faults.py recovery --runs 3
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import threading
import time
from collections import Counter
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from itertools import cycle
from statistics import mean, median

import requests

SECRET = "dev-secret-change-in-prod"
IMAGE = "python:3.11-slim"
TERMINAL = {"completed", "failed", "timed_out", "cancelled"}


# ── Beacon collector ──────────────────────────────────────────────────────────

class Beacon:
    """Counts container executions: GET /<tag> is recorded with a timestamp."""

    def __init__(self, port: int):
        self.hits: dict[str, list[float]] = {}
        self._lock = threading.Lock()
        outer = self

        class H(BaseHTTPRequestHandler):
            def do_GET(self):
                with outer._lock:
                    outer.hits.setdefault(self.path.strip("/"), []).append(time.time())
                self.send_response(204)
                self.end_headers()

            def log_message(self, *_):
                pass

        self.server = ThreadingHTTPServer(("0.0.0.0", port), H)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.port = port

    def count(self, tag: str) -> int:
        with self._lock:
            return len(self.hits.get(tag, []))

    def times(self, tag: str) -> list[float]:
        with self._lock:
            return list(self.hits.get(tag, []))


def job_command(port: int, tag: str, sleep_s: float) -> str:
    # host.docker.internal reaches the benchmark host from sibling containers.
    return ("python -c \"import time,urllib.request as u;"
            f"u.urlopen('http://host.docker.internal:{port}/{tag}',timeout=5);"
            f"time.sleep({sleep_s})\"")


# ── API helpers ───────────────────────────────────────────────────────────────

class Api:
    def __init__(self, urls: list[str], secret: str):
        self.urls = urls
        self.sessions = []
        for url in urls:
            s = requests.Session()
            r = s.post(f"{url}/auth/login", json={"api_key": secret}, timeout=10)
            if r.status_code == 401:
                sys.exit(f"auth failed against {url}; check --secret")
            r.raise_for_status()
            s.headers["Authorization"] = f"Bearer {r.json()['token']}"
            self.sessions.append(s)
        self._rr = cycle(range(len(urls)))
        self._lock = threading.Lock()

    def _pick(self):
        with self._lock:
            i = next(self._rr)
        return self.urls[i], self.sessions[i]

    def submit(self, tag, command, **kw) -> str:
        url, s = self._pick()
        body = {"name": tag, "image_name": IMAGE, "command": command,
                "required_cpu": 1, "required_memory": 128, "timeout_seconds": 120,
                "max_retries": 0, **kw}
        r = s.post(f"{url}/jobs", json=body, timeout=15)
        r.raise_for_status()
        return r.json()["id"]

    def get(self, path):
        url, s = self.urls[0], self.sessions[0]
        r = s.get(f"{url}{path}", timeout=15)
        r.raise_for_status()
        return r.json()

    def job(self, jid):
        return self.get(f"/jobs/{jid}")["job"]

    def all_jobs(self, ids: set[str]) -> dict[str, dict]:
        out, offset = {}, 0
        while len(out) < len(ids):
            page = self.get(f"/jobs?limit=200&offset={offset}")
            if not page:
                break
            for j in page:
                if j["id"] in ids:
                    out[j["id"]] = j
            offset += 200
        return out

    def metrics(self):
        return self.get("/metrics/summary")

    def workers(self):
        return self.get("/workers")


def submit_parallel(api: Api, items: list[tuple[str, str]], **kw) -> dict[str, str]:
    """items: [(tag, command)] -> {tag: job_id}"""
    ids: dict[str, str] = {}
    lock = threading.Lock()
    it = iter(items)

    def work():
        while True:
            with lock:
                nxt = next(it, None)
            if nxt is None:
                return
            jid = api.submit(nxt[0], nxt[1], **kw)
            with lock:
                ids[nxt[0]] = jid

    threads = [threading.Thread(target=work) for _ in range(16)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    return ids


def wait_all(api: Api, ids: set[str], timeout: float) -> dict[str, dict]:
    deadline = time.monotonic() + timeout
    jobs: dict[str, dict] = {}
    while time.monotonic() < deadline:
        jobs = api.all_jobs(ids)
        if len(jobs) == len(ids) and all(j["status"] in TERMINAL for j in jobs.values()):
            return jobs
        time.sleep(2)
    print("  WARNING: timed out waiting for all jobs to finish")
    return jobs


def ts(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp() if s else None


def pct(xs, p):
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(len(xs) * p))] if xs else float("nan")


def active_workers(api):
    return [w for w in api.workers() if w["status"] in ("online", "busy")]


# ── 1. Recovery time ──────────────────────────────────────────────────────────

def worker_container(hostname: str) -> str:
    # Compose workers use the container id as hostname.
    return hostname


def recovery(api: Api, beacon: Beacon, args):
    results = []
    for run in range(args.runs):
        print(f"\n— recovery run {run + 1}/{args.runs}")
        ws = active_workers(api)
        if len(ws) < 2:
            sys.exit("need >= 2 online workers (one to kill, one to take over)")
        tag = f"rec-{int(time.time())}-{run}"
        jid = api.submit(tag, job_command(beacon.port, tag, args.sleep),
                         max_retries=2, timeout_seconds=args.sleep + 60)
        while api.job(jid)["status"] != "running":
            time.sleep(0.5)
        job = api.job(jid)
        victim = next(w for w in ws if w["id"] == job["worker_id"])
        print(f"  job running on worker {victim['id'][:8]} ({victim['hostname']}); killing it")
        t_kill = time.time()
        subprocess.run(["docker", "kill", victim["hostname"]], check=True,
                       capture_output=True)

        t_requeue = t_restart = t_done = None
        deadline = time.time() + args.sleep + 180
        while time.time() < deadline:
            j = api.job(jid)
            now = time.time()
            if t_requeue is None and j["retries"] > 0:
                t_requeue = now
            if t_restart is None and beacon.count(tag) >= 2:
                t_restart = beacon.times(tag)[1]
            if j["status"] in TERMINAL:
                t_done = ts(j["completed_at"]) or now
                break
            time.sleep(0.5)
        r = {"status": j["status"], "executions": beacon.count(tag),
             "requeue_s": t_requeue and t_requeue - t_kill,
             "restart_s": t_restart and t_restart - t_kill,
             "finish_s": t_done and t_done - t_kill}
        print("  ", json.dumps({k: (round(v, 1) if isinstance(v, float) else v)
                               for k, v in r.items()}))
        results.append(r)
        subprocess.run(["docker", "start", victim["hostname"]], capture_output=True)
        time.sleep(10)  # let the worker re-register before the next run

    ok = [r for r in results if r["finish_s"] and r["status"] == "completed"]
    print(f"\nRECOVERY: {len(ok)}/{len(results)} jobs recovered and completed")
    for key, label in [("requeue_s", "kill -> requeued"), ("restart_s", "kill -> restarted"),
                       ("finish_s", "kill -> finished")]:
        xs = [r[key] for r in ok if r[key]]
        if xs:
            print(f"  {label:18s} mean {mean(xs):.1f}s  min {min(xs):.1f}s  max {max(xs):.1f}s")
    print("  note: the killed worker's container keeps running (sibling container),"
          " so executions>=2 is expected here: Foreman is at-least-once.")


# ── 2. Zero double-assignment ─────────────────────────────────────────────────

def duplicates(api: Api, beacon: Beacon, args):
    n = args.jobs
    run = int(time.time())
    print(f"submitting {n} jobs through {len(api.urls)} coordinator(s), "
          f"{len(active_workers(api))} workers online")
    items = [(f"dup-{run}-{i}", job_command(beacon.port, f"dup-{run}-{i}", args.sleep))
             for i in range(n)]
    ids = submit_parallel(api, items)
    jobs = wait_all(api, set(ids.values()), args.timeout)
    time.sleep(3)  # late beacons

    execs = Counter({tag: beacon.count(tag) for tag in ids})
    dupes = {t: c for t, c in execs.items() if c > 1}
    missing = [t for t, c in execs.items() if c == 0]
    statuses = Counter(j["status"] for j in jobs.values())
    # Also check the DB-side invariant: a job must have exactly one worker_id and retries == 0.
    retried = [j["id"] for j in jobs.values() if j["retries"] > 0]
    print(f"\nDOUBLE-ASSIGNMENT: {len(dupes)} of {n} jobs executed more than once")
    print(f"  never executed : {len(missing)}")
    print(f"  final statuses : {dict(statuses)}")
    print(f"  jobs retried   : {len(retried)}")
    if dupes:
        print("  duplicates     :", dict(list(dupes.items())[:10]))


# ── 3. Throughput & scheduling latency ────────────────────────────────────────

def throughput(api: Api, beacon: Beacon, args):
    n = args.jobs
    run = int(time.time())
    workers = len(active_workers(api))
    items = [(f"tp-{run}-{i}", job_command(beacon.port, f"tp-{run}-{i}", args.sleep))
             for i in range(n)]
    t0 = time.time()
    ids = submit_parallel(api, items)
    jobs = wait_all(api, set(ids.values()), args.timeout)
    wall = time.time() - t0
    done = [j for j in jobs.values() if j["status"] == "completed"]
    lat = [ts(j["started_at"]) - ts(j["submitted_at"]) for j in done if j["started_at"]]
    first_lat = sorted(lat)[:max(1, workers * 2)]  # jobs that hit an idle cluster
    print(f"\nTHROUGHPUT: {len(done)}/{n} completed, {workers} workers, "
          f"{args.sleep}s jobs, wall {wall:.1f}s")
    print(f"  throughput           : {len(done) / wall * 60:.1f} jobs/min")
    print(f"  submit -> start      : median {median(lat):.1f}s  p95 {pct(lat, .95):.1f}s  "
          f"max {max(lat):.1f}s  (includes queue wait)")
    print(f"  idle-cluster latency : {mean(first_lat):.1f}s  "
          f"(best {len(first_lat)} jobs; floor = scheduler 2s tick + worker 3s poll)")


# ── 4. Max concurrency ────────────────────────────────────────────────────────

def capacity(api: Api, beacon: Beacon, args):
    ws = active_workers(api)
    theoretical = sum(min(w["cpu_cores"], w["memory_mb"] // 128) for w in ws)
    print(f"{len(ws)} workers; theoretical slots (1 cpu / 128MB jobs, before the "
          f"per-worker parallel cap): {theoretical}")
    for burst in args.bursts:
        run = int(time.time())
        items = [(f"cap-{run}-{i}", job_command(beacon.port, f"cap-{run}-{i}", args.sleep))
                 for i in range(burst)]
        peak_running = peak_queued = 0
        stop = threading.Event()

        def sample():
            nonlocal peak_running, peak_queued
            while not stop.is_set():
                m = api.metrics()
                peak_running = max(peak_running, m["running"] + m["scheduled"])
                peak_queued = max(peak_queued, m["queued"])
                time.sleep(0.5)

        th = threading.Thread(target=sample)
        th.start()
        ids = submit_parallel(api, items)
        jobs = wait_all(api, set(ids.values()), args.timeout)
        stop.set()
        th.join()
        lat = [ts(j["started_at"]) - ts(j["submitted_at"])
               for j in jobs.values() if j["started_at"]]
        print(f"  burst {burst:4d}: peak running+scheduled {peak_running:3d}  "
              f"peak queued {peak_queued:4d}  p95 start latency {pct(lat, .95):5.1f}s")
    print("  queue builds once burst exceeds peak running; that peak is the concurrency ceiling.")


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("experiment", choices=["recovery", "duplicates", "throughput", "capacity"])
    p.add_argument("--url", action="append", help="coordinator URL (repeat for several)")
    p.add_argument("--secret", default=SECRET)
    p.add_argument("--jobs", type=int, default=500)
    p.add_argument("--runs", type=int, default=3, help="recovery repetitions")
    p.add_argument("--sleep", type=float, default=None, help="seconds each job runs")
    p.add_argument("--bursts", type=int, nargs="+", default=[5, 10, 20, 40, 80])
    p.add_argument("--timeout", type=float, default=1800)
    p.add_argument("--beacon-port", type=int, default=9099)
    args = p.parse_args()
    if args.sleep is None:
        args.sleep = {"recovery": 90, "capacity": 20}.get(args.experiment, 2)
    api = Api(args.url or ["http://localhost:8080"], args.secret)
    beacon = Beacon(args.beacon_port)
    {"recovery": recovery, "duplicates": duplicates,
     "throughput": throughput, "capacity": capacity}[args.experiment](api, beacon, args)


if __name__ == "__main__":
    main()
