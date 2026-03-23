package store

import (
	"context"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/namankundra/foreman/internal/models"
)

const jobCols = `id, name, status, submitted_at, scheduled_at, started_at, completed_at,
	retries, max_retries, timeout_seconds, required_cpu, required_memory, worker_id,
	image_name, command, logs_path, artifact_path, lock_expires_at, priority`

type CreateJobParams struct {
	Name           *string
	ImageName      string
	Command        string
	RequiredCPU    int
	RequiredMemory int
	MaxRetries     int
	TimeoutSeconds int
	Priority       int
}

func (s *Store) CreateJob(ctx context.Context, p CreateJobParams) (models.Job, error) {
	rows, err := s.db.Query(ctx, `
		INSERT INTO jobs (name, image_name, command, required_cpu, required_memory, max_retries, timeout_seconds, priority)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
		RETURNING `+jobCols,
		p.Name, p.ImageName, p.Command, p.RequiredCPU, p.RequiredMemory,
		p.MaxRetries, p.TimeoutSeconds, p.Priority,
	)
	if err != nil {
		return models.Job{}, err
	}
	return pgx.CollectOneRow(rows, pgx.RowToStructByName[models.Job])
}

type ListJobsParams struct {
	Status   string
	WorkerID *uuid.UUID
	Limit    int
	Offset   int
}

func (s *Store) ListJobs(ctx context.Context, p ListJobsParams) ([]models.Job, error) {
	if p.Limit <= 0 || p.Limit > 200 {
		p.Limit = 50
	}

	query := `SELECT ` + jobCols + ` FROM jobs WHERE 1=1`
	args := []any{}
	n := 1

	if p.Status != "" {
		query += fmt.Sprintf(" AND status = $%d", n)
		args = append(args, p.Status)
		n++
	}
	if p.WorkerID != nil {
		query += fmt.Sprintf(" AND worker_id = $%d", n)
		args = append(args, *p.WorkerID)
		n++
	}

	query += fmt.Sprintf(" ORDER BY submitted_at DESC LIMIT $%d OFFSET $%d", n, n+1)
	args = append(args, p.Limit, p.Offset)

	rows, err := s.db.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowToStructByName[models.Job])
}

func (s *Store) GetJob(ctx context.Context, id uuid.UUID) (models.Job, error) {
	rows, err := s.db.Query(ctx,
		`SELECT `+jobCols+` FROM jobs WHERE id = $1`, id,
	)
	if err != nil {
		return models.Job{}, err
	}
	return pgx.CollectOneRow(rows, pgx.RowToStructByName[models.Job])
}

type UpdateJobStatusParams struct {
	JobID    uuid.UUID
	Status   models.JobStatus
	WorkerID *uuid.UUID
}

func (s *Store) UpdateJobStatus(ctx context.Context, p UpdateJobStatusParams) (models.Job, error) {
	var query string
	var args []any

	switch p.Status {
	case models.JobScheduled:
		query = `UPDATE jobs
			SET status = $2, worker_id = $3, scheduled_at = NOW(), lock_expires_at = NOW() + INTERVAL '30 seconds'
			WHERE id = $1 RETURNING ` + jobCols
		args = []any{p.JobID, p.Status, p.WorkerID}
	case models.JobRunning:
		// Use the job's own timeout so the monitor doesn't recover a legitimately running job.
		query = `UPDATE jobs
			SET status = $2, started_at = NOW(),
			    lock_expires_at = NOW() + (timeout_seconds * INTERVAL '1 second')
			WHERE id = $1 RETURNING ` + jobCols
		args = []any{p.JobID, p.Status}
	case models.JobCompleted, models.JobFailed, models.JobTimedOut, models.JobCancelled:
		query = `UPDATE jobs
			SET status = $2, completed_at = NOW(), lock_expires_at = NULL
			WHERE id = $1 RETURNING ` + jobCols
		args = []any{p.JobID, p.Status}
	default:
		query = `UPDATE jobs SET status = $2 WHERE id = $1 RETURNING ` + jobCols
		args = []any{p.JobID, p.Status}
	}

	rows, err := s.db.Query(ctx, query, args...)
	if err != nil {
		return models.Job{}, err
	}
	return pgx.CollectOneRow(rows, pgx.RowToStructByName[models.Job])
}

// GetNextJob atomically claims the next available queued job for a worker.
// Uses SELECT FOR UPDATE SKIP LOCKED to prevent double-assignment under concurrency.
func (s *Store) GetNextJob(ctx context.Context, workerID uuid.UUID) (*models.Job, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)

	rows, err := tx.Query(ctx, `
		SELECT `+jobCols+`
		FROM jobs
		WHERE status = 'queued'
		ORDER BY priority ASC, submitted_at ASC
		LIMIT 1
		FOR UPDATE SKIP LOCKED
	`)
	if err != nil {
		return nil, err
	}

	job, err := pgx.CollectOneRow(rows, pgx.RowToStructByName[models.Job])
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}

	_, err = tx.Exec(ctx, `
		UPDATE jobs
		SET status = 'scheduled', worker_id = $2, scheduled_at = NOW(), lock_expires_at = NOW() + INTERVAL '30 seconds'
		WHERE id = $1
	`, job.ID, workerID)
	if err != nil {
		return nil, err
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}

	job.Status = models.JobScheduled
	job.WorkerID = &workerID
	return &job, nil
}

type MetricsSummary struct {
	Queued    int `json:"queued"`
	Scheduled int `json:"scheduled"`
	Running   int `json:"running"`
	Completed int `json:"completed"`
	Failed    int `json:"failed"`
	TimedOut  int `json:"timed_out"`
	Cancelled int `json:"cancelled"`
	Total     int `json:"total"`
}

func (s *Store) GetMetricsSummary(ctx context.Context) (MetricsSummary, error) {
	rows, err := s.db.Query(ctx, `SELECT status, COUNT(*) FROM jobs GROUP BY status`)
	if err != nil {
		return MetricsSummary{}, err
	}
	defer rows.Close()

	var m MetricsSummary
	for rows.Next() {
		var status string
		var count int
		if err := rows.Scan(&status, &count); err != nil {
			return MetricsSummary{}, err
		}
		switch models.JobStatus(status) {
		case models.JobQueued:
			m.Queued = count
		case models.JobScheduled:
			m.Scheduled = count
		case models.JobRunning:
			m.Running = count
		case models.JobCompleted:
			m.Completed = count
		case models.JobFailed:
			m.Failed = count
		case models.JobTimedOut:
			m.TimedOut = count
		case models.JobCancelled:
			m.Cancelled = count
		}
		m.Total += count
	}
	return m, rows.Err()
}
