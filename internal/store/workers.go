package store

import (
	"context"
	"encoding/json"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/namankundra/foreman/internal/models"
)

const workerCols = `id, hostname, status, last_heartbeat, cpu_cores, memory_mb, labels, current_load, registered_at`

type RegisterWorkerParams struct {
	Hostname string
	CPUCores int
	MemoryMB int
	Labels   json.RawMessage
}

func (s *Store) RegisterWorker(ctx context.Context, p RegisterWorkerParams) (models.Worker, error) {
	if p.Labels == nil {
		p.Labels = json.RawMessage("{}")
	}
	rows, err := s.db.Query(ctx, `
		INSERT INTO workers (hostname, cpu_cores, memory_mb, labels)
		VALUES ($1, $2, $3, $4)
		RETURNING `+workerCols,
		p.Hostname, p.CPUCores, p.MemoryMB, p.Labels,
	)
	if err != nil {
		return models.Worker{}, err
	}
	return pgx.CollectOneRow(rows, pgx.RowToStructByName[models.Worker])
}

type HeartbeatParams struct {
	WorkerID    uuid.UUID
	CurrentLoad int
}

func (s *Store) UpdateHeartbeat(ctx context.Context, p HeartbeatParams) error {
	tag, err := s.db.Exec(ctx,
		`UPDATE workers SET last_heartbeat = NOW(), current_load = $2 WHERE id = $1`,
		p.WorkerID, p.CurrentLoad,
	)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return pgx.ErrNoRows
	}
	return nil
}

func (s *Store) ListWorkers(ctx context.Context) ([]models.Worker, error) {
	rows, err := s.db.Query(ctx,
		`SELECT `+workerCols+` FROM workers ORDER BY registered_at DESC`,
	)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowToStructByName[models.Worker])
}

func (s *Store) GetWorker(ctx context.Context, id uuid.UUID) (models.Worker, error) {
	rows, err := s.db.Query(ctx,
		`SELECT `+workerCols+` FROM workers WHERE id = $1`, id,
	)
	if err != nil {
		return models.Worker{}, err
	}
	return pgx.CollectOneRow(rows, pgx.RowToStructByName[models.Worker])
}

// GetEligibleWorkers returns online workers ordered by available capacity (used by scheduler).
func (s *Store) GetEligibleWorkers(ctx context.Context) ([]models.Worker, error) {
	rows, err := s.db.Query(ctx,
		`SELECT `+workerCols+` FROM workers WHERE status = 'online' ORDER BY current_load ASC`,
	)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowToStructByName[models.Worker])
}
