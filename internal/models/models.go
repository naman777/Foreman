package models

import (
	"encoding/json"
	"time"

	"github.com/google/uuid"
)

type WorkerStatus string

const (
	WorkerOnline    WorkerStatus = "online"
	WorkerBusy      WorkerStatus = "busy"
	WorkerOffline   WorkerStatus = "offline"
	WorkerUnhealthy WorkerStatus = "unhealthy"
)

type JobStatus string

const (
	JobQueued     JobStatus = "queued"
	JobScheduled  JobStatus = "scheduled"
	JobRunning    JobStatus = "running"
	JobCompleted  JobStatus = "completed"
	JobFailed     JobStatus = "failed"
	JobRetrying   JobStatus = "retrying"
	JobTimedOut   JobStatus = "timed_out"
	JobCancelled  JobStatus = "cancelled"
)

type Worker struct {
	ID            uuid.UUID    `db:"id"             json:"id"`
	Hostname      string       `db:"hostname"       json:"hostname"`
	Status        WorkerStatus `db:"status"         json:"status"`
	LastHeartbeat *time.Time   `db:"last_heartbeat" json:"last_heartbeat"`
	CPUCores      int          `db:"cpu_cores"      json:"cpu_cores"`
	MemoryMB      int          `db:"memory_mb"      json:"memory_mb"`
	Labels        json.RawMessage `db:"labels"         json:"labels"`
	CurrentLoad   int          `db:"current_load"   json:"current_load"`
	RegisteredAt  time.Time    `db:"registered_at"  json:"registered_at"`
}

type Job struct {
	ID             uuid.UUID  `db:"id"              json:"id"`
	Name           *string    `db:"name"            json:"name"`
	Status         JobStatus  `db:"status"          json:"status"`
	SubmittedAt    time.Time  `db:"submitted_at"    json:"submitted_at"`
	ScheduledAt    *time.Time `db:"scheduled_at"    json:"scheduled_at"`
	StartedAt      *time.Time `db:"started_at"      json:"started_at"`
	CompletedAt    *time.Time `db:"completed_at"    json:"completed_at"`
	Retries        int        `db:"retries"         json:"retries"`
	MaxRetries     int        `db:"max_retries"     json:"max_retries"`
	TimeoutSeconds int        `db:"timeout_seconds" json:"timeout_seconds"`
	RequiredCPU    int        `db:"required_cpu"    json:"required_cpu"`
	RequiredMemory int        `db:"required_memory" json:"required_memory"`
	WorkerID       *uuid.UUID `db:"worker_id"       json:"worker_id"`
	ImageName      string     `db:"image_name"      json:"image_name"`
	Command        string     `db:"command"         json:"command"`
	LogsPath       *string    `db:"logs_path"       json:"logs_path"`
	ArtifactPath   *string    `db:"artifact_path"   json:"artifact_path"`
	LockExpiresAt  *time.Time `db:"lock_expires_at" json:"lock_expires_at"`
	Priority       int        `db:"priority"        json:"priority"`
}

type JobEvent struct {
	ID        uuid.UUID `db:"id"         json:"id"`
	JobID     uuid.UUID `db:"job_id"     json:"job_id"`
	EventType string    `db:"event_type" json:"event_type"`
	Timestamp time.Time `db:"timestamp"  json:"timestamp"`
	Metadata  json.RawMessage `db:"metadata"   json:"metadata"`
}
