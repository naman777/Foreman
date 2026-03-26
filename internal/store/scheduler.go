package store

import (
	"context"
	"encoding/json"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/namankundra/foreman/internal/models"
)

// WorkerWithLoad extends Worker with actual CPU/memory consumed by its
// currently running and scheduled jobs — used by the scheduler for accurate
// resource-aware scoring.
type WorkerWithLoad struct {
	ID            uuid.UUID           `db:"id"`
	Hostname      string              `db:"hostname"`
	Status        models.WorkerStatus `db:"status"`
	LastHeartbeat *time.Time          `db:"last_heartbeat"`
	CPUCores      int                 `db:"cpu_cores"`
	MemoryMB      int                 `db:"memory_mb"`
	Labels        json.RawMessage     `db:"labels"`
	CurrentLoad   int                 `db:"current_load"`
	RegisteredAt  time.Time           `db:"registered_at"`
	UsedCPU       int                 `db:"used_cpu"`
	UsedMemory    int                 `db:"used_memory"`
}

// GetQueuedJobs returns up to limit jobs with status='queued', ordered by
// priority ASC (1=highest) then submit time ASC (FIFO within same priority).
func (s *Store) GetQueuedJobs(ctx context.Context, limit int) ([]models.Job, error) {
	rows, err := s.db.Query(ctx, `
		SELECT `+jobCols+`
		FROM jobs
		WHERE status = 'queued'
		ORDER BY priority ASC, submitted_at ASC
		LIMIT $1
	`, limit)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowToStructByName[models.Job])
}

// GetEligibleWorkersWithLoad returns all online workers together with their
// currently consumed resources, computed by summing running/scheduled jobs.
func (s *Store) GetEligibleWorkersWithLoad(ctx context.Context) ([]WorkerWithLoad, error) {
	rows, err := s.db.Query(ctx, `
		SELECT
		    w.id, w.hostname, w.status, w.last_heartbeat,
		    w.cpu_cores, w.memory_mb, w.labels, w.current_load, w.registered_at,
		    COALESCE(SUM(j.required_cpu),    0)::int AS used_cpu,
		    COALESCE(SUM(j.required_memory), 0)::int AS used_memory
		FROM workers w
		LEFT JOIN jobs j
		       ON j.worker_id = w.id
		      AND j.status IN ('running', 'scheduled')
		WHERE w.status = 'online'
		GROUP BY w.id
		ORDER BY w.current_load ASC
	`)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowToStructByName[WorkerWithLoad])
}

// AssignJob atomically moves a job from queued→scheduled and increments the
// worker's current_load in a single transaction.
// Returns (false, nil) if the job was already claimed by another instance.
func (s *Store) AssignJob(ctx context.Context, jobID, workerID uuid.UUID) (bool, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer tx.Rollback(ctx)

	tag, err := tx.Exec(ctx, `
		UPDATE jobs
		SET status          = 'scheduled',
		    worker_id       = $2,
		    scheduled_at    = NOW(),
		    lock_expires_at = NOW() + INTERVAL '30 seconds'
		WHERE id = $1 AND status = 'queued'
	`, jobID, workerID)
	if err != nil {
		return false, err
	}
	if tag.RowsAffected() == 0 {
		return false, nil // race: already assigned
	}

	if _, err = tx.Exec(ctx,
		`UPDATE workers SET current_load = current_load + 1 WHERE id = $1`, workerID,
	); err != nil {
		return false, err
	}

	return true, tx.Commit(ctx)
}
