package scheduler

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/google/uuid"
	"github.com/namankundra/foreman/internal/models"
	"github.com/namankundra/foreman/internal/store"
	"github.com/redis/go-redis/v9"
)

type Scheduler struct {
	store       *store.Store
	locker      *redis.Client
	instanceID  string
	maxParallel int
}

func New(s *store.Store, r *redis.Client, maxParallel int) *Scheduler {
	return &Scheduler{
		store:       s,
		locker:      r,
		instanceID:  uuid.New().String(),
		maxParallel: maxParallel,
	}
}

func (s *Scheduler) Run(ctx context.Context) {
	slog.Info("scheduler starting", "instance_id", s.instanceID, "max_parallel", s.maxParallel)
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			s.scheduleNextBatch(ctx)
		case <-ctx.Done():
			slog.Info("scheduler stopped")
			return
		}
	}
}

func (s *Scheduler) scheduleNextBatch(ctx context.Context) {
	jobs, err := s.store.GetQueuedJobs(ctx, 10)
	if err != nil {
		slog.Error("scheduler: fetch queued jobs", "error", err)
		return
	}
	if len(jobs) == 0 {
		return
	}

	workers, err := s.store.GetEligibleWorkersWithLoad(ctx)
	if err != nil {
		slog.Error("scheduler: fetch eligible workers", "error", err)
		return
	}
	if len(workers) == 0 {
		return
	}

	for _, job := range jobs {
		w := s.selectWorker(job, workers)
		if w == nil {
			slog.Debug("no eligible worker for job",
				"job_id", job.ID,
				"required_cpu", job.RequiredCPU,
				"required_memory_mb", job.RequiredMemory,
			)
			continue
		}

		if s.assignJob(ctx, job, w) {
			// Update the local snapshot so the remaining jobs in this batch
			// see up-to-date load without a second DB round-trip.
			w.UsedCPU += job.RequiredCPU
			w.UsedMemory += job.RequiredMemory
			w.CurrentLoad++

			slog.Info("job scheduled",
				"job_id", job.ID,
				"worker_id", w.ID,
				"worker", w.Hostname,
				"score", fmt.Sprintf("%.3f", s.score(*w, job)),
			)
		}
	}
}

// selectWorker filters workers that can satisfy the job's resource requirements
// and returns the one with the highest fitness score. Returns nil if none qualify.
func (s *Scheduler) selectWorker(job models.Job, workers []store.WorkerWithLoad) *store.WorkerWithLoad {
	var best *store.WorkerWithLoad
	bestScore := -1.0

	for i := range workers {
		w := &workers[i]

		availCPU := w.CPUCores - w.UsedCPU
		availMem := w.MemoryMB - w.UsedMemory

		if availCPU < job.RequiredCPU    { continue }
		if availMem < job.RequiredMemory { continue }
		if w.CurrentLoad >= s.maxParallel { continue }

		if sc := s.score(*w, job); sc > bestScore {
			bestScore = sc
			best = w
		}
	}
	return best
}

// score computes a fitness value in [0, 1] for a worker–job pair.
//
//	score = 0.4 * (free_cpu  / total_cpu)
//	      + 0.4 * (free_mem  / total_mem)
//	      - 0.2 * (load      / max_parallel)
//
// Higher score means a better match (more headroom, lower contention).
func (s *Scheduler) score(w store.WorkerWithLoad, _ models.Job) float64 {
	if w.CPUCores == 0 || w.MemoryMB == 0 {
		return 0
	}
	freeCPUFrac := float64(w.CPUCores-w.UsedCPU) / float64(w.CPUCores)
	freeMemFrac := float64(w.MemoryMB-w.UsedMemory) / float64(w.MemoryMB)
	loadFrac    := float64(w.CurrentLoad) / float64(s.maxParallel)

	return 0.4*freeCPUFrac + 0.4*freeMemFrac - 0.2*loadFrac
}

// assignJob acquires a per-job Redis NX lock (30 s TTL) to guard against
// double-assignment when multiple coordinator instances run simultaneously,
// then delegates the actual DB update to the store.
// Returns true only when this instance wins the race and the commit succeeds.
func (s *Scheduler) assignJob(ctx context.Context, job models.Job, w *store.WorkerWithLoad) bool {
	lockKey := fmt.Sprintf("scheduler:job:%s", job.ID)

	ok, err := s.locker.SetNX(ctx, lockKey, s.instanceID, 30*time.Second).Result()
	if err != nil {
		slog.Warn("scheduler: redis lock failed, falling back to DB guard",
			"job_id", job.ID, "error", err)
		// Redis unavailable: the DB's WHERE status='queued' still prevents double-assignment.
	} else if !ok {
		return false // another instance already holds the lock
	}

	assigned, err := s.store.AssignJob(ctx, job.ID, w.ID)
	if err != nil {
		slog.Error("scheduler: db assign failed", "job_id", job.ID, "worker_id", w.ID, "error", err)
		return false
	}
	return assigned
}
