package main

import (
	"encoding/json"
	"log"
	"sync"
	"time"
)

// ----------------------------------------------------------------------------
// Hub — manages a collection of rooms
// ----------------------------------------------------------------------------

type Hub struct {
	mu    sync.Mutex
	rooms map[string]*Room
}

func NewHub() *Hub {
	return &Hub{rooms: make(map[string]*Room)}
}

// GetRoom returns the room with the given name, creating it on first use.
func (h *Hub) GetRoom(name string) *Room {
	h.mu.Lock()
	defer h.mu.Unlock()
	room, ok := h.rooms[name]
	if !ok {
		room = NewRoom(name, h)
		h.rooms[name] = room
		go room.run()
		log.Printf("room created: %s", name)
	}
	return room
}

// removeRoom deletes an empty room from the hub.
func (h *Hub) removeRoom(name string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	delete(h.rooms, name)
	log.Printf("room removed: %s", name)
}

// ----------------------------------------------------------------------------
// Room — one synchronized listening session
// ----------------------------------------------------------------------------

type Room struct {
	name string
	hub  *Hub

	clients map[*Client]bool

	// leader is the client whose player clock is the room's source of truth.
	// The first client to join (i.e. the room creator) becomes the leader;
	// when they leave, another client is promoted.
	leader *Client

	register   chan *Client
	unregister chan *Client
	broadcast  chan inbound

	playlist []Track
	state    PlaybackState
}

// inbound couples a raw message with the client that sent it.
type inbound struct {
	client *Client
	msg    Message
}

func NewRoom(name string, hub *Hub) *Room {
	return &Room{
		name:       name,
		hub:        hub,
		clients:    make(map[*Client]bool),
		register:   make(chan *Client),
		unregister: make(chan *Client),
		broadcast:  make(chan inbound, 64),
		playlist:   scanTracks(),
		state:      PlaybackState{TrackIndex: -1, UpdatedAt: time.Now().UnixMilli()},
	}
}

func (r *Room) run() {
	for {
		select {
		case c := <-r.register:
			r.clients[c] = true
			// The room creator (first client) becomes the leader.
			if r.leader == nil {
				r.leader = c
			}
			// Tell the client its role, then send playlist + state.
			c.send <- newMessage("role", map[string]interface{}{"leader": c == r.leader})
			c.send <- newMessage("playlist", r.playlist)
			c.send <- r.stateMessage()
			r.broadcastUsers()
			log.Printf("[%s] %s joined (%d online, leader=%s)", r.name, c.name, len(r.clients), r.leader.name)

		case c := <-r.unregister:
			if _, ok := r.clients[c]; ok {
				delete(r.clients, c)
				close(c.send)
				log.Printf("[%s] %s left (%d online)", r.name, c.name, len(r.clients))
				if len(r.clients) == 0 {
					r.hub.removeRoom(r.name)
					return
				}
				// Promote a new leader if the leader left.
				if c == r.leader {
					r.leader = nil
					for other := range r.clients {
						r.leader = other
						break
					}
					if r.leader != nil {
						r.leader.send <- newMessage("role", map[string]interface{}{"leader": true})
						log.Printf("[%s] %s promoted to leader", r.name, r.leader.name)
					}
				}
				r.broadcastUsers()
			}

		case in := <-r.broadcast:
			r.handleMessage(in)
		}
	}
}

// handleMessage applies a client action to the shared state and re-broadcasts.
// Playback control (play/pause/seek/select/ended) and position reports are
// only honored when they come from the room leader — every other client is a
// follower that merely mirrors the leader's clock.
func (r *Room) handleMessage(in inbound) {
	switch in.msg.Type {
	case "play":
		if in.client != r.leader {
			return
		}
		var p struct {
			Position float64 `json:"position"`
		}
		_ = json.Unmarshal(in.msg.Data, &p)
		r.state.Playing = true
		r.state.Position = p.Position
		r.state.UpdatedAt = time.Now().UnixMilli()
		r.broadcastState()

	case "pause":
		if in.client != r.leader {
			return
		}
		var p struct {
			Position float64 `json:"position"`
		}
		_ = json.Unmarshal(in.msg.Data, &p)
		r.state.Playing = false
		r.state.Position = p.Position
		r.state.UpdatedAt = time.Now().UnixMilli()
		r.broadcastState()

	case "seek":
		if in.client != r.leader {
			return
		}
		var p struct {
			Position float64 `json:"position"`
		}
		_ = json.Unmarshal(in.msg.Data, &p)
		r.state.Position = p.Position
		r.state.UpdatedAt = time.Now().UnixMilli()
		r.broadcastState()

	case "leader_pos":
		// Periodic ground-truth position report from the leader's <audio>
		// clock. This is what keeps followers in sync with the actual
		// playback rather than a wall-clock projection.
		if in.client != r.leader {
			return
		}
		var p struct {
			Position float64 `json:"position"`
			Playing  bool    `json:"playing"`
			At       int64   `json:"at"` // leader's estimate of SERVER time at capture
		}
		_ = json.Unmarshal(in.msg.Data, &p)
		r.state.Position = p.Position
		r.state.Playing = p.Playing
		// Anchor the sample at the moment the leader CAPTURED it (expressed
		// on the server clock via the leader's NTP offset), not the moment it
		// arrived here — that removes the leader's uplink latency from the
		// shared timeline. Guard against garbage stamps.
		now := time.Now().UnixMilli()
		if p.At > 0 && p.At <= now && now-p.At < 5000 {
			r.state.UpdatedAt = p.At
		} else {
			r.state.UpdatedAt = now
		}
		// Fan out to followers only — the leader IS the source of truth.
		raw := r.stateMessage()
		for c := range r.clients {
			if c == r.leader {
				continue
			}
			select {
			case c.send <- raw:
			default:
				close(c.send)
				delete(r.clients, c)
			}
		}

	case "select":
		if in.client != r.leader {
			return
		}
		var p struct {
			TrackIndex int `json:"trackIndex"`
		}
		_ = json.Unmarshal(in.msg.Data, &p)
		if p.TrackIndex < 0 || p.TrackIndex >= len(r.playlist) {
			return
		}
		r.state.TrackIndex = p.TrackIndex
		r.state.Position = 0
		r.state.Playing = true
		r.state.UpdatedAt = time.Now().UnixMilli()
		r.broadcastState()

	case "add":
		// A client adds a track (e.g. from Yandex search) to the room queue.
		var t Track
		if err := json.Unmarshal(in.msg.Data, &t); err != nil || t.ID == "" || t.URL == "" {
			return
		}
		// Avoid duplicates by ID.
		for _, existing := range r.playlist {
			if existing.ID == t.ID {
				return
			}
		}
		r.playlist = append(r.playlist, t)
		r.broadcastAll(newMessage("playlist", r.playlist))
		// If nothing is selected yet, auto-select and play the new track.
		if r.state.TrackIndex < 0 {
			r.state.TrackIndex = len(r.playlist) - 1
			r.state.Position = 0
			r.state.Playing = true
			r.state.UpdatedAt = time.Now().UnixMilli()
			r.broadcastState()
		}

	case "ended":
		// Auto-advance to the next track when the current one finishes.
		// Only the leader's "ended" counts — followers may hit the end of
		// their buffer slightly earlier or later.
		if in.client != r.leader {
			return
		}
		next := r.state.TrackIndex + 1
		if next >= len(r.playlist) {
			r.state.Playing = false
			r.state.Position = 0
			r.state.UpdatedAt = time.Now().UnixMilli()
			r.broadcastState()
			return
		}
		r.state.TrackIndex = next
		r.state.Position = 0
		r.state.Playing = true
		r.state.UpdatedAt = time.Now().UnixMilli()
		r.broadcastState()

	case "sync":
		// A client explicitly asks for the authoritative state.
		in.client.send <- r.stateMessage()

	case "chat":
		var p struct {
			Text string `json:"text"`
		}
		_ = json.Unmarshal(in.msg.Data, &p)
		if p.Text == "" {
			return
		}
		payload := map[string]interface{}{
			"user": in.client.name,
			"text": p.Text,
			"ts":   time.Now().UnixMilli(),
		}
		r.broadcastAll(newMessage("chat", payload))
	}
}

// stateMessage produces a "state" message with the position projected to now.
func (r *Room) stateMessage() []byte {
	s := r.state
	s.Position = r.state.effectivePosition()
	s.UpdatedAt = time.Now().UnixMilli()
	return newMessage("state", s)
}

func (r *Room) broadcastState() {
	r.broadcastAll(r.stateMessage())
}

func (r *Room) broadcastUsers() {
	names := make([]string, 0, len(r.clients))
	for c := range r.clients {
		names = append(names, c.name)
	}
	r.broadcastAll(newMessage("users", names))
}

// broadcastAll fans a raw message out to every connected client.
func (r *Room) broadcastAll(raw []byte) {
	for c := range r.clients {
		select {
		case c.send <- raw:
		default:
			// Slow client — drop it to avoid blocking the room loop.
			close(c.send)
			delete(r.clients, c)
		}
	}
}
