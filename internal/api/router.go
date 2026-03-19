package api

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/namankundra/foreman/internal/store"
)

type Handler struct {
	store *store.Store
}

func NewRouter(s *store.Store) http.Handler {
	h := &Handler{store: s}
	r := chi.NewRouter()

	r.Use(middleware.Logger)
	r.Use(middleware.Recoverer)
	r.Use(middleware.RequestID)

	r.Get("/health", h.health)

	r.Route("/workers", func(r chi.Router) {
		r.Post("/register", h.registerWorker)
		r.Post("/heartbeat", h.workerHeartbeat)
		r.Get("/", h.listWorkers)
	})

	r.Route("/jobs", func(r chi.Router) {
		r.Post("/", h.submitJob)
		r.Get("/", h.listJobs)
		r.Get("/next", h.nextJob)
		r.Get("/{id}", h.getJob)
		r.Post("/{id}/status", h.updateJobStatus)
		r.Get("/{id}/artifacts", h.getJobArtifacts)
	})

	r.Get("/metrics/summary", h.metricsSummary)

	return r
}

func (h *Handler) health(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}
