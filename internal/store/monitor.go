package store

import (
	"context"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/namankundra/foreman/internal/models"
)

// RecoveredJob is returned by recovery methods so the monitor can emit job events.
type RecoveredJob struct {
	ID        uuid.UUID
	NewStatus models.JobStatus
	Retries   int
}

// MarkWorkersUnhealthy transitions online workers silent for 15s → unhealthy.
// Returns the IDs of workers that were just transitioned.
func (s *Store) MarkWorkersUnhealthy(ctx context.Context) ([]uuid.UUID, error) {
	rows, err := s.db.Query(ctx, `
		UPDATE workers
		SET status = 'unhealthy'
		WHERE status = 'online'
		  AND last_heartbeat < NOW() - INTERVAL '15 seconds'
		RETURNING id
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return collectUUIDs(rows)
}

// MarkWorkersOffline transitions online/unhealthy workers silent for 30s → offline.
// Returns the IDs of workers that were just transitioned.
func (s *Store) MarkWorkersOffline(ctx context.Context) ([]uuid.UUID, error) {
	rows, err := s.db.Query(ctx, `
		UPDATE workers
		SET status = 'offline', current_load = 0
		WHERE status IN ('online', 'unhealthy')
		  AND last_heartbeat < NOW() - INTERVAL '30 seconds'
		RETURNING id
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return collectUUIDs(rows)
}

// RecoverJobsForWorkers requeues or permanently fails running/scheduled jobs
// whose worker just went offline. One SQL statement, no per-row round-trips.
func (s *Store) RecoverJobsForWorkers(ctx context.Context, workerIDs []uuid.UUID) ([]RecoveredJob, error) {
	if len(workerIDs) == 0 {
		return nil, nil
	}
	ids := uuidStrings(workerIDs)
	rows, err := s.db.Query(ctx, `
		UPDATE jobs
		SET retries         = retries + 1,
		    status          = CASE WHEN retries + 1 <= max_retries THEN 'queued' ELSE 'failed' END,
		    worker_id       = CASE WHEN retries + 1 <= max_retries THEN NULL    ELSE worker_id END,
		    scheduled_at    = CASE WHEN retries + 1 <= max_retries THEN NULL    ELSE scheduled_at END,
		    started_at      = CASE WHEN retries + 1 <= max_retries THEN NULL    ELSE started_at END,
		    lock_expires_at = NULL,
		    completed_at    = CASE WHEN retries + 1 > max_retries  THEN NOW()   ELSE completed_at END
		WHERE worker_id = ANY($1::uuid[])
		  AND status IN ('running', 'scheduled')
		RETURNING id, status, retries
	`, ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return collectRecoveredJobs(rows)
}

// RecoverStaleJobs finds running/scheduled jobs whose lock expired (coordinator
// restart or missed renewals) and requeues or permanently fails them.
func (s *Store) RecoverStaleJobs(ctx context.Context) ([]RecoveredJob, error) {
	rows, err := s.db.Query(ctx, `
		UPDATE jobs
		SET retries         = retries + 1,
		    status          = CASE WHEN retries + 1 <= max_retries THEN 'queued' ELSE 'failed' END,
		    worker_id       = CASE WHEN retries + 1 <= max_retries THEN NULL    ELSE worker_id END,
		    scheduled_at    = CASE WHEN retries + 1 <= max_retries THEN NULL    ELSE scheduled_at END,
		    started_at      = CASE WHEN retries + 1 <= max_retries THEN NULL    ELSE started_at END,
		    lock_expires_at = NULL,
		    completed_at    = CASE WHEN retries + 1 > max_retries  THEN NOW()   ELSE completed_at END
		WHERE status IN ('running', 'scheduled')
		  AND lock_expires_at < NOW()
		RETURNING id, status, retries
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return collectRecoveredJobs(rows)
}

func collectUUIDs(rows pgx.Rows) ([]uuid.UUID, error) {
	var ids []uuid.UUID
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

func collectRecoveredJobs(rows pgx.Rows) ([]RecoveredJob, error) {
	var jobs []RecoveredJob
	for rows.Next() {
		var j RecoveredJob
		var status string
		if err := rows.Scan(&j.ID, &status, &j.Retries); err != nil {
			return nil, err
		}
		j.NewStatus = models.JobStatus(status)
		jobs = append(jobs, j)
	}
	return jobs, rows.Err()
}

func uuidStrings(ids []uuid.UUID) []string {
	s := make([]string, len(ids))
	for i, id := range ids {
		s[i] = id.String()
	}
	return s
}
