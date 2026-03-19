package scheduler

import (
	"context"
	"log/slog"
	"time"

	"github.com/namankundra/foreman/internal/store"
	"github.com/redis/go-redis/v9"
)

const maxParallelJobs = 4

type Scheduler struct {
	store  *store.Store
	locker *redis.Client
}

func New(s *store.Store, r *redis.Client) *Scheduler {
	return &Scheduler{store: s, locker: r}
}

func (s *Scheduler) Run(ctx context.Context) {
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			s.scheduleNextBatch(ctx)
		case <-ctx.Done():
			return
		}
	}
}

func (s *Scheduler) scheduleNextBatch(ctx context.Context) {
	// TODO: Phase 6
	slog.Debug("running scheduler tick")
}
