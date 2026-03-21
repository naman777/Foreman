package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/namankundra/foreman/internal/models"
	"github.com/namankundra/foreman/internal/store"
)

type submitJobRequest struct {
	Name           *string `json:"name"`
	ImageName      string  `json:"image_name"`
	Command        string  `json:"command"`
	RequiredCPU    int     `json:"required_cpu"`
	RequiredMemory int     `json:"required_memory"`
	MaxRetries     int     `json:"max_retries"`
	TimeoutSeconds int     `json:"timeout_seconds"`
	Priority       int     `json:"priority"`
}

func (h *Handler) submitJob(w http.ResponseWriter, r *http.Request) {
	var req submitJobRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.ImageName == "" {
		writeError(w, http.StatusBadRequest, "image_name is required")
		return
	}
	if req.Command == "" {
		writeError(w, http.StatusBadRequest, "command is required")
		return
	}
	if req.RequiredCPU <= 0 {
		req.RequiredCPU = 1
	}
	if req.RequiredMemory <= 0 {
		req.RequiredMemory = 256
	}
	if req.TimeoutSeconds <= 0 {
		req.TimeoutSeconds = 300
	}
	if req.Priority < 1 || req.Priority > 10 {
		req.Priority = 5
	}

	job, err := h.store.CreateJob(r.Context(), store.CreateJobParams{
		Name:           req.Name,
		ImageName:      req.ImageName,
		Command:        req.Command,
		RequiredCPU:    req.RequiredCPU,
		RequiredMemory: req.RequiredMemory,
		MaxRetries:     req.MaxRetries,
		TimeoutSeconds: req.TimeoutSeconds,
		Priority:       req.Priority,
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to create job")
		return
	}

	_ = h.store.CreateJobEvent(r.Context(), job.ID, "submitted", nil)

	writeJSON(w, http.StatusCreated, job)
}

func (h *Handler) listJobs(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	p := store.ListJobsParams{Status: q.Get("status")}

	if s := q.Get("worker_id"); s != "" {
		wid, err := parseUUID(s)
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid worker_id")
			return
		}
		p.WorkerID = &wid
	}
	if s := q.Get("limit"); s != "" {
		if n, err := strconv.Atoi(s); err == nil {
			p.Limit = n
		}
	}
	if s := q.Get("offset"); s != "" {
		if n, err := strconv.Atoi(s); err == nil {
			p.Offset = n
		}
	}

	jobs, err := h.store.ListJobs(r.Context(), p)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list jobs")
		return
	}
	writeJSON(w, http.StatusOK, jobs)
}

func (h *Handler) getJob(w http.ResponseWriter, r *http.Request) {
	jobID, err := parseUUID(chi.URLParam(r, "id"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid job id")
		return
	}

	job, err := h.store.GetJob(r.Context(), jobID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(w, http.StatusNotFound, "job not found")
			return
		}
		writeError(w, http.StatusInternalServerError, "failed to get job")
		return
	}

	events, err := h.store.GetJobEvents(r.Context(), jobID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to get events")
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{"job": job, "events": events})
}

func (h *Handler) nextJob(w http.ResponseWriter, r *http.Request) {
	workerID, err := parseUUID(r.URL.Query().Get("worker_id"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid worker_id")
		return
	}

	job, err := h.store.GetNextJob(r.Context(), workerID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to get next job")
		return
	}
	if job == nil {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	writeJSON(w, http.StatusOK, job)
}

type updateJobStatusRequest struct {
	Status   models.JobStatus `json:"status"`
	WorkerID *string          `json:"worker_id"`
}

func (h *Handler) updateJobStatus(w http.ResponseWriter, r *http.Request) {
	jobID, err := parseUUID(chi.URLParam(r, "id"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid job id")
		return
	}

	var req updateJobStatusRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	valid := map[models.JobStatus]bool{
		models.JobScheduled: true, models.JobRunning: true,
		models.JobCompleted: true, models.JobFailed: true,
		models.JobTimedOut: true, models.JobCancelled: true,
	}
	if !valid[req.Status] {
		writeError(w, http.StatusBadRequest, "invalid status value")
		return
	}

	p := store.UpdateJobStatusParams{JobID: jobID, Status: req.Status}
	if req.WorkerID != nil {
		wid, err := parseUUID(*req.WorkerID)
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid worker_id")
			return
		}
		p.WorkerID = &wid
	}

	job, err := h.store.UpdateJobStatus(r.Context(), p)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(w, http.StatusNotFound, "job not found")
			return
		}
		writeError(w, http.StatusInternalServerError, "failed to update job status")
		return
	}

	meta, _ := json.Marshal(map[string]string{"status": string(req.Status)})
	_ = h.store.CreateJobEvent(r.Context(), jobID, "status_changed", meta)

	writeJSON(w, http.StatusOK, job)
}

func (h *Handler) getJobArtifacts(w http.ResponseWriter, r *http.Request) {
	writeError(w, http.StatusNotImplemented, "artifact storage not yet implemented (Phase 7)")
}
