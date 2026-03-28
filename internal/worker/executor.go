package worker

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"time"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/image"
	"github.com/docker/docker/client"
	"github.com/docker/docker/pkg/stdcopy"
	"github.com/namankundra/foreman/internal/models"
)

type ExecResult struct {
	ExitCode    int
	Stdout      string
	Stderr      string
	LogsPath    string
	ArtifactDir string // host path bound to /output inside the container
	Duration    time.Duration
}

type Executor struct {
	docker *client.Client
}

func NewExecutor() (*Executor, error) {
	cli, err := client.NewClientWithOpts(
		client.FromEnv,
		client.WithAPIVersionNegotiation(),
	)
	if err != nil {
		return nil, fmt.Errorf("docker client init failed: %w", err)
	}
	return &Executor{docker: cli}, nil
}

func (e *Executor) Close() error {
	return e.docker.Close()
}

// Run executes job.Command inside a Docker container with enforced CPU, memory,
// and timeout limits. Stdout/stderr are captured, written to disk, and the path
// is returned in ExecResult.LogsPath.
func (e *Executor) Run(ctx context.Context, job models.Job) (ExecResult, error) {
	timeout := time.Duration(job.TimeoutSeconds) * time.Second
	execCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	if err := e.ensureImage(execCtx, job.ImageName); err != nil {
		return ExecResult{}, fmt.Errorf("image pull: %w", err)
	}

	// Create a host-side directory bound to /output so the job can write
	// output files that survive container removal.
	artifactDir := filepath.Join(os.TempDir(), "foreman", "artifacts", job.ID.String())
	if err := os.MkdirAll(artifactDir, 0o755); err != nil {
		return ExecResult{}, fmt.Errorf("artifact dir: %w", err)
	}

	resp, err := e.docker.ContainerCreate(
		execCtx,
		&container.Config{
			Image: job.ImageName,
			Cmd:   []string{"sh", "-c", job.Command},
		},
		&container.HostConfig{
			Binds: []string{fmt.Sprintf("%s:/output:rw", artifactDir)},
			Resources: container.Resources{
				Memory:   int64(job.RequiredMemory) * 1024 * 1024,
				NanoCPUs: int64(job.RequiredCPU) * 1_000_000_000,
			},
		},
		nil, nil, "",
	)
	if err != nil {
		return ExecResult{}, fmt.Errorf("container create: %w", err)
	}
	// Always remove the container when we're done, even on error paths.
	defer e.docker.ContainerRemove(
		context.Background(), resp.ID, container.RemoveOptions{Force: true},
	)

	start := time.Now()

	if err := e.docker.ContainerStart(execCtx, resp.ID, container.StartOptions{}); err != nil {
		return ExecResult{}, fmt.Errorf("container start: %w", err)
	}

	statusCh, errCh := e.docker.ContainerWait(execCtx, resp.ID, container.WaitConditionNotRunning)

	exitCode := 0
	timedOut := false

	select {
	case status := <-statusCh:
		exitCode = int(status.StatusCode)
	case waitErr := <-errCh:
		if execCtx.Err() != nil {
			timedOut = execCtx.Err() == context.DeadlineExceeded
			stopCtx, stopCancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer stopCancel()
			_ = e.docker.ContainerStop(stopCtx, resp.ID, container.StopOptions{})
			exitCode = -1
		} else if waitErr != nil {
			return ExecResult{Duration: time.Since(start)},
				fmt.Errorf("container wait: %w", waitErr)
		}
	}

	duration := time.Since(start)

	// Collect logs with a background context — execCtx may already be expired.
	logsReader, err := e.docker.ContainerLogs(
		context.Background(), resp.ID,
		container.LogsOptions{ShowStdout: true, ShowStderr: true},
	)
	if err != nil {
		slog.Warn("failed to collect container logs", "job_id", job.ID, "error", err)
	}

	var stdout, stderr bytes.Buffer
	if logsReader != nil {
		defer logsReader.Close()
		if _, err := stdcopy.StdCopy(&stdout, &stderr, logsReader); err != nil {
			slog.Warn("log demux error", "job_id", job.ID, "error", err)
		}
	}

	logsPath, _ := writeLogs(job.ID.String(), stdout.String(), stderr.String())

	result := ExecResult{
		ExitCode:    exitCode,
		Stdout:      stdout.String(),
		Stderr:      stderr.String(),
		LogsPath:    logsPath,
		ArtifactDir: artifactDir,
		Duration:    duration,
	}

	if timedOut {
		return result, context.DeadlineExceeded
	}
	return result, nil
}

// ensureImage pulls the image if it is not already present on the local daemon.
func (e *Executor) ensureImage(ctx context.Context, imageName string) error {
	_, _, err := e.docker.ImageInspectWithRaw(ctx, imageName)
	if err == nil {
		return nil // already present
	}
	slog.Info("pulling docker image", "image", imageName)
	reader, err := e.docker.ImagePull(ctx, imageName, image.PullOptions{})
	if err != nil {
		return err
	}
	defer reader.Close()
	_, _ = io.Copy(io.Discard, reader) // must drain for pull to complete
	return nil
}

// writeLogs writes stdout/stderr to <tmpdir>/foreman/jobs/<jobID>/logs.txt
// and returns the absolute path.
func writeLogs(jobID, stdout, stderr string) (string, error) {
	dir := filepath.Join(os.TempDir(), "foreman", "jobs", jobID)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	path := filepath.Join(dir, "logs.txt")
	content := "=== STDOUT ===\n" + stdout + "\n\n=== STDERR ===\n" + stderr + "\n"
	return path, os.WriteFile(path, []byte(content), 0o644)
}
