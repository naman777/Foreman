package api

import (
	"context"
	"encoding/json"
	"log/slog"
	"sync"

	"github.com/gorilla/websocket"
)

// WSEvent is the envelope broadcast to all connected dashboard clients.
type WSEvent struct {
	Type    string `json:"type"`
	Payload any    `json:"payload"`
}

// Hub manages active WebSocket clients and fan-out broadcasts.
type Hub struct {
	mu         sync.RWMutex
	clients    map[*wsClient]struct{}
	broadcast  chan []byte
	register   chan *wsClient
	unregister chan *wsClient
}

type wsClient struct {
	hub  *Hub
	conn *websocket.Conn
	send chan []byte
}

func NewHub() *Hub {
	return &Hub{
		clients:    make(map[*wsClient]struct{}),
		broadcast:  make(chan []byte, 256),
		register:   make(chan *wsClient, 16),
		unregister: make(chan *wsClient, 16),
	}
}

func (h *Hub) Run(ctx context.Context) {
	for {
		select {
		case c := <-h.register:
			h.mu.Lock()
			h.clients[c] = struct{}{}
			h.mu.Unlock()

		case c := <-h.unregister:
			h.mu.Lock()
			if _, ok := h.clients[c]; ok {
				delete(h.clients, c)
				close(c.send)
			}
			h.mu.Unlock()

		case msg := <-h.broadcast:
			h.mu.RLock()
			for c := range h.clients {
				select {
				case c.send <- msg:
				default:
					// Slow client — drop it.
					go func(c *wsClient) { h.unregister <- c }(c)
				}
			}
			h.mu.RUnlock()

		case <-ctx.Done():
			return
		}
	}
}

// Broadcast serialises event and sends it to every connected client.
func (h *Hub) Broadcast(event WSEvent) {
	data, err := json.Marshal(event)
	if err != nil {
		slog.Error("ws broadcast marshal", "error", err)
		return
	}
	select {
	case h.broadcast <- data:
	default: // drop if channel is full
	}
}

// writePump pumps outbound messages from the hub to the WebSocket connection.
func (c *wsClient) writePump() {
	defer c.conn.Close()
	for msg := range c.send {
		if err := c.conn.WriteMessage(websocket.TextMessage, msg); err != nil {
			return
		}
	}
}

// readPump drains incoming frames so the connection stays healthy and
// disconnect events propagate back to the hub.
func (c *wsClient) readPump() {
	defer func() { c.hub.unregister <- c }()
	c.conn.SetReadLimit(512)
	for {
		if _, _, err := c.conn.ReadMessage(); err != nil {
			return
		}
	}
}
