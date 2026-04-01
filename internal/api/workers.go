package api

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/jackc/pgx/v5"
	"github.com/namankundra/foreman/internal/store"
)

type registerWorkerRequest struct {
	Hostname string          `json:"hostname"`
	CPUCores int             `json:"cpu_cores"`
	MemoryMB int             `json:"memory_mb"`
	Labels   json.RawMessage `json:"labels"`
}

func (h *Handler) registerWorker(w http.ResponseWriter, r *http.Request) {
	var req registerWorkerRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.Hostname == "" {
		writeError(w, http.StatusBadRequest, "hostname is required")
		return
	}
	if req.CPUCores <= 0 {
		req.CPUCores = 1
	}
	if req.MemoryMB <= 0 {
		req.MemoryMB = 512
	}

	worker, err := h.store.RegisterWorker(r.Context(), store.RegisterWorkerParams{
		Hostname: req.Hostname,
		CPUCores: req.CPUCores,
		MemoryMB: req.MemoryMB,
		Labels:   req.Labels,
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to register worker")
		return
	}
	h.hub.Broadcast(WSEvent{Type: "worker_registered", Payload: worker})
	writeJSON(w, http.StatusCreated, worker)
}

type heartbeatRequest struct {
	WorkerID    string `json:"worker_id"`
	CurrentLoad int    `json:"current_load"`
}

func (h *Handler) workerHeartbeat(w http.ResponseWriter, r *http.Request) {
	var req heartbeatRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	workerID, err := parseUUID(req.WorkerID)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid worker_id")
		return
	}

	err = h.store.UpdateHeartbeat(r.Context(), store.HeartbeatParams{
		WorkerID:    workerID,
		CurrentLoad: req.CurrentLoad,
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(w, http.StatusNotFound, "worker not found")
			return
		}
		writeError(w, http.StatusInternalServerError, "failed to update heartbeat")
		return
	}

	h.hub.Broadcast(WSEvent{Type: "worker_heartbeat", Payload: map[string]any{
		"worker_id": req.WorkerID, "current_load": req.CurrentLoad,
	}})
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (h *Handler) listWorkers(w http.ResponseWriter, r *http.Request) {
	workers, err := h.store.ListWorkers(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list workers")
		return
	}
	writeJSON(w, http.StatusOK, workers)
}
