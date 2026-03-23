package main

import (
	"context"
	"log/slog"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/joho/godotenv"
	"github.com/namankundra/foreman/internal/models"
	"github.com/namankundra/foreman/internal/worker"
)

func main() {
	_ = godotenv.Load()

	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: slog.LevelInfo,
	})))

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	coordinatorURL := mustEnv("COORDINATOR_URL")
	secret := mustEnv("COORDINATOR_SECRET")
	cpuCores := envInt("WORKER_CPU_CORES", 2)
	memoryMB := envInt("WORKER_MEMORY_MB", 1024)

	client := worker.NewClient(coordinatorURL, secret)
	executor := worker.NewExecutor()

	hostname, _ := os.Hostname()

	reg, err := client.Register(ctx, worker.RegisterParams{
		Hostname: hostname,
		CPUCores: cpuCores,
		MemoryMB: memoryMB,
	})
	if err != nil {
		slog.Error("registration failed", "coordinator", coordinatorURL, "error", err)
		os.Exit(1)
	}

	workerID := reg.ID.String()
	persistID(workerID)
	slog.Info("worker registered", "worker_id", workerID, "hostname", hostname,
		"cpu", cpuCores, "memory_mb", memoryMB)

	var currentLoad atomic.Int32

	// Heartbeat goroutine — tells the coordinator we are alive and reports load.
	go func() {
		tick := time.NewTicker(5 * time.Second)
		defer tick.Stop()
		for {
			select {
			case <-tick.C:
				if err := client.Heartbeat(ctx, workerID, int(currentLoad.Load())); err != nil {
					slog.Warn("heartbeat failed", "error", err)
				}
			case <-ctx.Done():
				return
			}
		}
	}()

	// Job poll goroutine — claims and dispatches jobs one at a time per goroutine.
	go func() {
		tick := time.NewTicker(3 * time.Second)
		defer tick.Stop()
		for {
			select {
			case <-tick.C:
				job, err := client.PollJob(ctx, workerID)
				if err != nil {
					slog.Warn("job poll failed", "error", err)
					continue
				}
				if job == nil {
					continue // 204 — queue empty
				}
				currentLoad.Add(1)
				go runJob(ctx, client, executor, workerID, *job, &currentLoad)
			case <-ctx.Done():
				return
			}
		}
	}()

	<-ctx.Done()
	slog.Info("worker shutting down", "worker_id", workerID)
}

func runJob(
	ctx context.Context,
	client *worker.Client,
	executor *worker.Executor,
	workerID string,
	job models.Job,
	load *atomic.Int32,
) {
	defer load.Add(-1)

	slog.Info("job received", "job_id", job.ID, "command", job.Command, "image", job.ImageName)

	// Notify coordinator we started executing.
	if err := client.ReportStatus(ctx, worker.ReportStatusParams{
		JobID:    job.ID.String(),
		Status:   models.JobRunning,
		WorkerID: workerID,
	}); err != nil {
		slog.Error("failed to report running", "job_id", job.ID, "error", err)
		return
	}

	result, execErr := executor.Run(ctx, job)

	finalStatus := models.JobCompleted
	switch {
	case execErr == context.DeadlineExceeded:
		finalStatus = models.JobTimedOut
	case execErr != nil || result.ExitCode != 0:
		finalStatus = models.JobFailed
	}

	slog.Info("job finished",
		"job_id", job.ID,
		"status", finalStatus,
		"exit_code", result.ExitCode,
		"duration_ms", result.Duration.Milliseconds(),
	)
	if result.Stdout != "" {
		slog.Info("job stdout", "job_id", job.ID, "output", result.Stdout)
	}
	if result.Stderr != "" {
		slog.Warn("job stderr", "job_id", job.ID, "output", result.Stderr)
	}

	// Use a fresh context for the final report — parent ctx may already be cancelled
	// on shutdown, but we still need the coordinator to record the result.
	reportCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	if err := client.ReportStatus(reportCtx, worker.ReportStatusParams{
		JobID:    job.ID.String(),
		Status:   finalStatus,
		WorkerID: workerID,
	}); err != nil {
		slog.Error("failed to report job result", "job_id", job.ID, "status", finalStatus, "error", err)
	}
}

// persistID writes the coordinator-assigned worker ID to ~/.foreman/worker_id
// so operator tooling can identify this machine across restarts.
func persistID(id string) {
	path := idFilePath()
	_ = os.MkdirAll(filepath.Dir(path), 0o700)
	_ = os.WriteFile(path, []byte(id), 0o600)
}

func idFilePath() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".foreman", "worker_id")
}

func mustEnv(key string) string {
	v := os.Getenv(key)
	if v == "" {
		slog.Error("required env var not set", "key", key)
		os.Exit(1)
	}
	return v
}

func envInt(key string, fallback int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return fallback
}
