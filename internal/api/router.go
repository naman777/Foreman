package api

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/gorilla/websocket"
	"github.com/namankundra/foreman/internal/store"
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	// Allow all origins in development; tighten in production.
	CheckOrigin: func(r *http.Request) bool { return true },
}

type Handler struct {
	store     *store.Store
	artifacts store.ArtifactStore // nil when MinIO is not configured
	hub       *Hub
}

func NewRouter(s *store.Store, artifacts store.ArtifactStore, hub *Hub) http.Handler {
	h := &Handler{store: s, artifacts: artifacts, hub: hub}
	r := chi.NewRouter()

	r.Use(corsMiddleware)
	r.Use(middleware.Logger)
	r.Use(middleware.Recoverer)
	r.Use(middleware.RequestID)

	r.Get("/health", h.health)
	r.Get("/ws", h.wsHandler)

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

func (h *Handler) wsHandler(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	c := &wsClient{hub: h.hub, conn: conn, send: make(chan []byte, 64)}
	h.hub.register <- c
	go c.writePump()
	go c.readPump()
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

func corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}
