package monitor

import (
	"context"
	"encoding/json"
	"log/slog"
	"time"

	"github.com/namankundra/foreman/internal/models"
	"github.com/namankundra/foreman/internal/store"
)

type Monitor struct {
	store *store.Store
}

func New(s *store.Store) *Monitor {
	return &Monitor{store: s}
}

// Run starts the monitor loop. It runs an initial pass immediately on startup
// so coordinator restarts recover orphaned jobs without waiting for the first tick.
func (m *Monitor) Run(ctx context.Context) {
	slog.Info("monitor starting")
	m.checkWorkerHealth(ctx)
	m.recoverStaleJobs(ctx)

	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			m.checkWorkerHealth(ctx)
			m.recoverStaleJobs(ctx)
		case <-ctx.Done():
			slog.Info("monitor stopped")
			return
		}
	}
}

// checkWorkerHealth marks stale workers unhealthy/offline and triggers job recovery
// for any workers that just transitioned to offline.
func (m *Monitor) checkWorkerHealth(ctx context.Context) {
	unhealthy, err := m.store.MarkWorkersUnhealthy(ctx)
	if err != nil {
		slog.Error("heartbeat monitor: mark unhealthy failed", "error", err)
		return
	}
	for _, id := range unhealthy {
		slog.Warn("worker became unhealthy (no heartbeat >15s)", "worker_id", id)
	}

	offline, err := m.store.MarkWorkersOffline(ctx)
	if err != nil {
		slog.Error("heartbeat monitor: mark offline failed", "error", err)
		return
	}
	for _, id := range offline {
		slog.Warn("worker went offline (no heartbeat >30s)", "worker_id", id)
	}

	if len(offline) == 0 {
		return
	}

	recovered, err := m.store.RecoverJobsForWorkers(ctx, offline)
	if err != nil {
		slog.Error("heartbeat monitor: job recovery for offline workers failed", "error", err)
		return
	}
	m.emitRecoveryEvents(ctx, recovered, "worker_offline")
}

// recoverStaleJobs handles jobs whose coordinator-issued lock expired — caused by
// coordinator restarts or a worker that stopped renewing without properly disconnecting.
func (m *Monitor) recoverStaleJobs(ctx context.Context) {
	recovered, err := m.store.RecoverStaleJobs(ctx)
	if err != nil {
		slog.Error("job recovery: stale lock scan failed", "error", err)
		return
	}
	m.emitRecoveryEvents(ctx, recovered, "lock_expired")
}

func (m *Monitor) emitRecoveryEvents(ctx context.Context, jobs []store.RecoveredJob, reason string) {
	for _, j := range jobs {
		eventType := "auto_recovered"
		if j.NewStatus == models.JobFailed {
			eventType = "auto_failed"
		}

		meta, _ := json.Marshal(map[string]any{
			"new_status": string(j.NewStatus),
			"retries":    j.Retries,
			"reason":     reason,
		})

		if err := m.store.CreateJobEvent(ctx, j.ID, eventType, meta); err != nil {
			slog.Error("failed to emit recovery event", "job_id", j.ID, "error", err)
		}

		slog.Info("job auto-recovered",
			"job_id", j.ID,
			"new_status", j.NewStatus,
			"retries", j.Retries,
			"reason", reason,
		)
	}
}
