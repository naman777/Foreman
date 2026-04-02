package api

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
)

// SessionStore holds in-memory dashboard session tokens.
// Tokens expire after 24 h; a background goroutine prunes stale entries hourly.
type SessionStore struct {
	mu       sync.RWMutex
	sessions map[string]time.Time
}

func newSessionStore() *SessionStore {
	s := &SessionStore{sessions: make(map[string]time.Time)}
	go s.pruneLoop()
	return s
}

func (s *SessionStore) Create() string {
	token := uuid.New().String()
	s.mu.Lock()
	s.sessions[token] = time.Now().Add(24 * time.Hour)
	s.mu.Unlock()
	return token
}

func (s *SessionStore) Valid(token string) bool {
	s.mu.RLock()
	expiry, ok := s.sessions[token]
	s.mu.RUnlock()
	return ok && time.Now().Before(expiry)
}

func (s *SessionStore) pruneLoop() {
	for range time.Tick(time.Hour) {
		now := time.Now()
		s.mu.Lock()
		for tok, exp := range s.sessions {
			if now.After(exp) {
				delete(s.sessions, tok)
			}
		}
		s.mu.Unlock()
	}
}

// TokenHash returns the SHA-256 hex digest of a raw token. Used to store a
// non-reversible record of which credential a worker registered with.
func TokenHash(token string) string {
	sum := sha256.Sum256([]byte(token))
	return fmt.Sprintf("%x", sum)
}

// bearerToken extracts the value from "Authorization: Bearer <token>".
func bearerToken(r *http.Request) string {
	auth := r.Header.Get("Authorization")
	if !strings.HasPrefix(auth, "Bearer ") {
		return ""
	}
	return strings.TrimPrefix(auth, "Bearer ")
}

// workerAuthMiddleware rejects requests that do not carry the coordinator secret.
func workerAuthMiddleware(secret string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if bearerToken(r) != secret {
				writeError(w, http.StatusUnauthorized, "invalid or missing bearer token")
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// dashboardAuthMiddleware rejects requests without a valid session token.
// WebSocket connections may pass the token via ?token= query parameter
// because browser WebSocket API does not support custom headers.
func dashboardAuthMiddleware(sessions *SessionStore) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			token := bearerToken(r)
			if token == "" {
				token = r.URL.Query().Get("token")
			}
			if !sessions.Valid(token) {
				writeError(w, http.StatusUnauthorized, "invalid or missing session token")
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// loginRequest / loginResponse for POST /auth/login.
type loginRequest struct {
	APIKey string `json:"api_key"`
}

func loginHandler(secret string, sessions *SessionStore) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req loginRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid request body")
			return
		}
		if req.APIKey != secret {
			writeError(w, http.StatusUnauthorized, "invalid api_key")
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"token": sessions.Create()})
	}
}
