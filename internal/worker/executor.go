package worker

import (
	"context"
	"time"

	"github.com/namankundra/foreman/internal/models"
)

type ExecResult struct {
	ExitCode int
	Stdout   string
	Stderr   string
	Duration time.Duration
}

type Executor struct{}

func NewExecutor() *Executor {
	return &Executor{}
}

// Run executes a job inside a Docker container (Phase 5).
func (e *Executor) Run(ctx context.Context, job models.Job) (ExecResult, error) {
	// TODO: Phase 5 — Docker SDK execution
	panic("executor not yet implemented")
}
