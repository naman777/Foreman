#!/usr/bin/env python3
"""Benchmark script for the Foreman distributed job scheduler."""

import argparse
import time
import threading
import requests
from statistics import mean, median

COORDINATOR_URL = "http://localhost:8080"
DEFAULT_JOBS = 20
TEST_IMAGE = "python:3.11-slim"
TEST_COMMAND = 'python -c "import time; time.sleep(1); print(\'done\')"'


def submit_job(name: str) -> dict:
    resp = requests.post(f"{COORDINATOR_URL}/jobs", json={
        "name": name,
        "image_name": TEST_IMAGE,
        "command": TEST_COMMAND,
        "required_cpu": 1,
        "required_memory": 128,
        "priority": 5,
    })
    resp.raise_for_status()
    return resp.json()


def wait_for_job(job_id: str, timeout: int = 300) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        resp = requests.get(f"{COORDINATOR_URL}/jobs/{job_id}")
        job = resp.json()
        if job["status"] in ("completed", "failed", "timed_out", "cancelled"):
            return job
        time.sleep(1)
    raise TimeoutError(f"job {job_id} did not complete in {timeout}s")


def run_benchmark(n_jobs: int) -> None:
    print(f"\n=== Submitting {n_jobs} jobs ===")
    start = time.time()

    jobs = []
    for i in range(n_jobs):
        job = submit_job(f"bench-{i}")
        jobs.append(job["id"])
        print(f"  submitted {job['id']}")

    print(f"\nWaiting for all {n_jobs} jobs to complete...")
    results = []
    threads = []

    def collect(job_id: str) -> None:
        try:
            j = wait_for_job(job_id)
            duration = None
            if j.get("started_at") and j.get("completed_at"):
                t0 = j["started_at"]
                t1 = j["completed_at"]
                # crude parse — replace with dateutil in real use
                duration = 0
            results.append({"id": job_id, "status": j["status"], "duration": duration})
        except Exception as e:
            results.append({"id": job_id, "status": "error", "error": str(e)})

    for jid in jobs:
        t = threading.Thread(target=collect, args=(jid,))
        t.start()
        threads.append(t)

    for t in threads:
        t.join()

    elapsed = time.time() - start
    completed = sum(1 for r in results if r["status"] == "completed")
    failed = sum(1 for r in results if r["status"] == "failed")

    print(f"\n=== Results ===")
    print(f"Total wall time : {elapsed:.1f}s")
    print(f"Throughput      : {n_jobs / elapsed * 60:.1f} jobs/min")
    print(f"Completed       : {completed}/{n_jobs}")
    print(f"Failed          : {failed}/{n_jobs}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Foreman benchmark")
    parser.add_argument("--jobs", type=int, default=DEFAULT_JOBS)
    args = parser.parse_args()
    run_benchmark(args.jobs)
