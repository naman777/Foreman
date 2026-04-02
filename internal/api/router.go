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
	CheckOrigin:     func(r *http.Request) bool { return true },
}

type Handler struct {
	store     *store.Store
	artifacts store.ArtifactStore
	hub       *Hub
	sessions  *SessionStore
}

// NewRouter wires up all routes with their respective auth middleware.
//
//	Public        — GET /health, POST /auth/login
//	Worker auth   — POST /workers/register, POST /workers/heartbeat,
//	                GET /jobs/next, POST /jobs/:id/status
//	Dashboard auth — everything else (GET /workers, GET /jobs, GET /ws, …)
func NewRouter(s *store.Store, artifacts store.ArtifactStore, hub *Hub, secret string) http.Handler {
	sessions := newSessionStore()
	h := &Handler{store: s, artifacts: artifacts, hub: hub, sessions: sessions}

	r := chi.NewRouter()
	r.Use(corsMiddleware)
	r.Use(middleware.Logger)
	r.Use(middleware.Recoverer)
	r.Use(middleware.RequestID)

	// Public
	r.Get("/health", h.health)
	r.Post("/auth/login", loginHandler(secret, sessions))

	// Worker auth — pre-shared COORDINATOR_SECRET
	r.Group(func(r chi.Router) {
		r.Use(workerAuthMiddleware(secret))
		r.Post("/workers/register", h.registerWorker)
		r.Post("/workers/heartbeat", h.workerHeartbeat)
		r.Get("/jobs/next", h.nextJob)
		r.Post("/jobs/{id}/status", h.updateJobStatus)
	})

	// Dashboard auth — session token from POST /auth/login
	r.Group(func(r chi.Router) {
		r.Use(dashboardAuthMiddleware(sessions))
		r.Get("/ws", h.wsHandler)
		r.Get("/workers", h.listWorkers)
		r.Get("/metrics/summary", h.metricsSummary)
		r.Route("/jobs", func(r chi.Router) {
			r.Post("/", h.submitJob)
			r.Get("/", h.listJobs)
			r.Get("/{id}", h.getJob)
			r.Get("/{id}/artifacts", h.getJobArtifacts)
		})
	})

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
