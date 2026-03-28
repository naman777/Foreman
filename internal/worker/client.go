package worker

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/namankundra/foreman/internal/models"
)

// Client is a typed HTTP client for talking to the coordinator.
type Client struct {
	baseURL string
	secret  string
	http    *http.Client
}

func NewClient(baseURL, secret string) *Client {
	return &Client{
		baseURL: baseURL,
		secret:  secret,
		http:    &http.Client{Timeout: 10 * time.Second},
	}
}

type RegisterParams struct {
	Hostname string
	CPUCores int
	MemoryMB int
}

func (c *Client) Register(ctx context.Context, p RegisterParams) (models.Worker, error) {
	body, _ := json.Marshal(map[string]any{
		"hostname":  p.Hostname,
		"cpu_cores": p.CPUCores,
		"memory_mb": p.MemoryMB,
	})
	var w models.Worker
	err := c.do(ctx, http.MethodPost, "/workers/register", body, &w)
	return w, err
}

func (c *Client) Heartbeat(ctx context.Context, workerID string, load int) error {
	body, _ := json.Marshal(map[string]any{
		"worker_id":    workerID,
		"current_load": load,
	})
	return c.do(ctx, http.MethodPost, "/workers/heartbeat", body, nil)
}

// PollJob asks the coordinator for the next available job for this worker.
// Returns nil, nil when there is nothing queued (HTTP 204).
func (c *Client) PollJob(ctx context.Context, workerID string) (*models.Job, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet,
		fmt.Sprintf("%s/jobs/next?worker_id=%s", c.baseURL, workerID), nil)
	if err != nil {
		return nil, err
	}
	c.setHeaders(req)

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusNoContent {
		return nil, nil
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("coordinator returned %d on /jobs/next", resp.StatusCode)
	}

	var job models.Job
	if err := json.NewDecoder(resp.Body).Decode(&job); err != nil {
		return nil, err
	}
	return &job, nil
}

type ReportStatusParams struct {
	JobID        string
	Status       models.JobStatus
	WorkerID     string
	LogsPath     string
	ArtifactPath string
}

func (c *Client) ReportStatus(ctx context.Context, p ReportStatusParams) error {
	payload := map[string]any{
		"status":    p.Status,
		"worker_id": p.WorkerID,
	}
	if p.LogsPath != "" {
		payload["logs_path"] = p.LogsPath
	}
	if p.ArtifactPath != "" {
		payload["artifact_path"] = p.ArtifactPath
	}
	body, _ := json.Marshal(payload)
	return c.do(ctx, http.MethodPost, fmt.Sprintf("/jobs/%s/status", p.JobID), body, nil)
}

func (c *Client) do(ctx context.Context, method, path string, body []byte, out any) error {
	req, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, bytes.NewReader(body))
	if err != nil {
		return err
	}
	c.setHeaders(req)

	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 400 {
		return fmt.Errorf("coordinator returned %d for %s %s", resp.StatusCode, method, path)
	}
	if out != nil {
		return json.NewDecoder(resp.Body).Decode(out)
	}
	return nil
}

func (c *Client) setHeaders(req *http.Request) {
	req.Header.Set("Content-Type", "application/json")
	if c.secret != "" {
		req.Header.Set("Authorization", "Bearer "+c.secret)
	}
}
