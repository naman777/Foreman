package store

import (
	"context"
	"encoding/json"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/namankundra/foreman/internal/models"
)

func (s *Store) CreateJobEvent(ctx context.Context, jobID uuid.UUID, eventType string, metadata json.RawMessage) error {
	if metadata == nil {
		metadata = json.RawMessage("{}")
	}
	_, err := s.db.Exec(ctx,
		`INSERT INTO job_events (job_id, event_type, metadata) VALUES ($1, $2, $3)`,
		jobID, eventType, metadata,
	)
	return err
}

func (s *Store) GetJobEvents(ctx context.Context, jobID uuid.UUID) ([]models.JobEvent, error) {
	rows, err := s.db.Query(ctx,
		`SELECT id, job_id, event_type, timestamp, metadata FROM job_events WHERE job_id = $1 ORDER BY timestamp ASC`,
		jobID,
	)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowToStructByName[models.JobEvent])
}
