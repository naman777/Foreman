package monitor

import (
	"context"
	"log/slog"
	"time"

	"github.com/namankundra/foreman/internal/store"
)

type Monitor struct {
	store *store.Store
}

func New(s *store.Store) *Monitor {
	return &Monitor{store: s}
}

func (m *Monitor) Run(ctx context.Context) {
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			m.checkWorkerHealth(ctx)
			m.recoverStaleJobs(ctx)
		case <-ctx.Done():
			return
		}
	}
}

func (m *Monitor) checkWorkerHealth(ctx context.Context) {
	// TODO: Phase 3
	slog.Debug("checking worker health")
}

func (m *Monitor) recoverStaleJobs(ctx context.Context) {
	// TODO: Phase 3
	slog.Debug("checking stale jobs")
}
