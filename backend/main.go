package main

import (
	"encoding/json"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/gorilla/websocket"
)

// ----------------------------------------------------------------------------
// Configuration
// ----------------------------------------------------------------------------

var (
	listenAddr   = envOr("LISTEN_ADDR", ":8080")
	musicDir     = envOr("MUSIC_DIR", "./music")
	yandexToken  = os.Getenv("YANDEX_MUSIC_TOKEN")
	yandexClient *YandexClient
	yandexCache  *audioCache
)

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

// ----------------------------------------------------------------------------
// Track model
// ----------------------------------------------------------------------------

// Track describes a single playable item — either a local file exposed under
// /music/ or a Yandex Music track streamed through our proxy.
type Track struct {
	ID       string  `json:"id"`
	Title    string  `json:"title"`
	URL      string  `json:"url"`
	Artist   string  `json:"artist,omitempty"`
	Cover    string  `json:"cover,omitempty"`
	Duration float64 `json:"duration,omitempty"`
	Source   string  `json:"source,omitempty"` // "local" | "yandex"
}

var audioExts = map[string]bool{
	".mp3":  true,
	".ogg":  true,
	".wav":  true,
	".flac": true,
	".m4a":  true,
	".aac":  true,
	".opus": true,
}

// scanTracks lists all audio files inside musicDir.
func scanTracks() []Track {
	var tracks []Track
	entries, err := os.ReadDir(musicDir)
	if err != nil {
		log.Printf("cannot read music dir %q: %v", musicDir, err)
		return tracks
	}
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		name := e.Name()
		ext := strings.ToLower(filepath.Ext(name))
		if !audioExts[ext] {
			continue
		}
		title := strings.TrimSuffix(name, filepath.Ext(name))
		tracks = append(tracks, Track{
			ID:     name,
			Title:  title,
			URL:    "/music/" + name,
			Source: "local",
		})
	}
	sort.Slice(tracks, func(i, j int) bool {
		return tracks[i].Title < tracks[j].Title
	})
	return tracks
}

// ----------------------------------------------------------------------------
// Playback state — shared per room
// ----------------------------------------------------------------------------

// PlaybackState is the authoritative synchronized state of a room.
type PlaybackState struct {
	TrackIndex int     `json:"trackIndex"` // index into the playlist, -1 = none
	Position   float64 `json:"position"`   // seconds into the current track
	Playing    bool    `json:"playing"`    // is it currently playing
	UpdatedAt  int64   `json:"updatedAt"`  // unix millis when Position was captured
}

// effectivePosition projects Position forward to "now" while playing so late
// joiners land at the correct spot.
func (s PlaybackState) effectivePosition() float64 {
	if !s.Playing {
		return s.Position
	}
	elapsed := float64(time.Now().UnixMilli()-s.UpdatedAt) / 1000.0
	return s.Position + elapsed
}

// ----------------------------------------------------------------------------
// Message envelope used on the WebSocket
// ----------------------------------------------------------------------------

type Message struct {
	Type string          `json:"type"`
	Data json.RawMessage `json:"data,omitempty"`
}

// helper to build an outgoing message with an arbitrary payload
func newMessage(t string, payload interface{}) []byte {
	raw, _ := json.Marshal(payload)
	b, _ := json.Marshal(Message{Type: t, Data: raw})
	return b
}

func main() {
	hub := NewHub()

	yandexClient = NewYandexClient(yandexToken)
	yandexCache = newAudioCache()
	if yandexClient.enabled() {
		log.Printf("Yandex Music search enabled")
	} else {
		log.Printf("Yandex Music disabled (set YANDEX_MUSIC_TOKEN to enable search)")
	}

	mux := http.NewServeMux()

	// REST: list local tracks
	mux.HandleFunc("/api/tracks", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(scanTracks())
	})

	// REST: simple health check + feature flags
	mux.HandleFunc("/api/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"status": "ok",
			"yandex": yandexClient.enabled(),
		})
	})

	// REST: Yandex Music search -> /api/yandex/search?q=...
	mux.HandleFunc("/api/yandex/search", func(w http.ResponseWriter, r *http.Request) {
		if !yandexClient.enabled() {
			http.Error(w, `{"error":"yandex music not configured"}`, http.StatusServiceUnavailable)
			return
		}
		q := strings.TrimSpace(r.URL.Query().Get("q"))
		if q == "" {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte("[]"))
			return
		}
		limit := atoiDefault(r.URL.Query().Get("limit"), 20)
		tracks, err := yandexClient.Search(q, limit)
		if err != nil {
			log.Printf("yandex search error: %v", err)
			http.Error(w, `{"error":"search failed"}`, http.StatusBadGateway)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(tracks)
	})

	// Audio proxy: /api/yandex/stream/<trackID> — downloads the track from
	// Yandex exactly once into a local cache and then serves every client from
	// that shared copy (with native HTTP range support). Yandex only allows one
	// concurrent stream per account, so fetching per-client would let only a
	// single device actually receive audio; caching removes that bottleneck.
	mux.HandleFunc("/api/yandex/stream/", func(w http.ResponseWriter, r *http.Request) {
		if !yandexClient.enabled() {
			http.Error(w, "yandex music not configured", http.StatusServiceUnavailable)
			return
		}
		trackID := strings.TrimPrefix(r.URL.Path, "/api/yandex/stream/")
		if trackID == "" {
			http.Error(w, "missing track id", http.StatusBadRequest)
			return
		}
		path, err := yandexCache.get(trackID, func() (string, error) {
			return yandexClient.ResolveStreamURL(trackID)
		})
		if err != nil {
			log.Printf("cache stream %s: %v", trackID, err)
			http.Error(w, "cannot resolve stream", http.StatusBadGateway)
			return
		}
		w.Header().Set("Content-Type", "audio/mpeg")
		w.Header().Set("Accept-Ranges", "bytes")
		// http.ServeFile handles Range requests, conditional headers and lets
		// multiple clients read the same file concurrently without contention.
		http.ServeFile(w, r, path)
	})

	// WebSocket endpoint: /ws?room=<name>&name=<user>
	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		serveWS(hub, w, r)
	})

	// Serve raw audio files with range support (http.FileServer supports ranges).
	mux.Handle("/music/", http.StripPrefix("/music/", http.FileServer(http.Dir(musicDir))))

	log.Printf("partymusic backend listening on %s (music dir: %s)", listenAddr, musicDir)
	if err := http.ListenAndServe(listenAddr, corsMiddleware(mux)); err != nil {
		log.Fatalf("server error: %v", err)
	}
}

// corsMiddleware allows the frontend (served from a different origin during dev)
// to talk to the API.
func corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// ----------------------------------------------------------------------------
// WebSocket upgrade
// ----------------------------------------------------------------------------

var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	CheckOrigin:     func(r *http.Request) bool { return true },
}

func serveWS(hub *Hub, w http.ResponseWriter, r *http.Request) {
	roomName := r.URL.Query().Get("room")
	if roomName == "" {
		roomName = "lobby"
	}
	userName := r.URL.Query().Get("name")
	if userName == "" {
		userName = "guest"
	}

	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("ws upgrade error: %v", err)
		return
	}

	room := hub.GetRoom(roomName)
	client := NewClient(room, conn, userName)
	room.register <- client

	go client.writePump()
	go client.readPump()
}
