package worker

import (
	"bytes"
	"context"
	"os/exec"
	"runtime"
	"strings"
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

// Run executes a job's command as a shell process with a hard timeout derived
// from job.TimeoutSeconds. Phase 5 replaces this with Docker container execution.
func (e *Executor) Run(ctx context.Context, job models.Job) (ExecResult, error) {
	timeout := time.Duration(job.TimeoutSeconds) * time.Second
	execCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	var cmd *exec.Cmd
	if runtime.GOOS == "windows" {
		cmd = exec.CommandContext(execCtx, "cmd", "/C", job.Command)
	} else {
		cmd = exec.CommandContext(execCtx, "sh", "-c", job.Command)
	}

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	start := time.Now()
	runErr := cmd.Run()
	duration := time.Since(start)

	result := ExecResult{
		Stdout:   strings.TrimSpace(stdout.String()),
		Stderr:   strings.TrimSpace(stderr.String()),
		Duration: duration,
	}

	if runErr != nil {
		if execCtx.Err() == context.DeadlineExceeded {
			result.ExitCode = -1
			return result, context.DeadlineExceeded
		}
		if exitErr, ok := runErr.(*exec.ExitError); ok {
			result.ExitCode = exitErr.ExitCode()
			return result, nil // non-zero exit is reported as JobFailed by caller
		}
		return result, runErr
	}

	return result, nil
}
