package api

import (
	"net/http"
)

// Workers
func (h *Handler) registerWorker(w http.ResponseWriter, r *http.Request)  { writeError(w, http.StatusNotImplemented, "not implemented") }
func (h *Handler) workerHeartbeat(w http.ResponseWriter, r *http.Request) { writeError(w, http.StatusNotImplemented, "not implemented") }
func (h *Handler) listWorkers(w http.ResponseWriter, r *http.Request)     { writeError(w, http.StatusNotImplemented, "not implemented") }

// Jobs
func (h *Handler) submitJob(w http.ResponseWriter, r *http.Request)      { writeError(w, http.StatusNotImplemented, "not implemented") }
func (h *Handler) listJobs(w http.ResponseWriter, r *http.Request)       { writeError(w, http.StatusNotImplemented, "not implemented") }
func (h *Handler) nextJob(w http.ResponseWriter, r *http.Request)        { writeError(w, http.StatusNotImplemented, "not implemented") }
func (h *Handler) getJob(w http.ResponseWriter, r *http.Request)         { writeError(w, http.StatusNotImplemented, "not implemented") }
func (h *Handler) updateJobStatus(w http.ResponseWriter, r *http.Request){ writeError(w, http.StatusNotImplemented, "not implemented") }
func (h *Handler) getJobArtifacts(w http.ResponseWriter, r *http.Request){ writeError(w, http.StatusNotImplemented, "not implemented") }

// Metrics
func (h *Handler) metricsSummary(w http.ResponseWriter, r *http.Request) { writeError(w, http.StatusNotImplemented, "not implemented") }
