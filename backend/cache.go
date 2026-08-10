package main

import (
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

// ----------------------------------------------------------------------------
// Shared audio cache
//
// Yandex Music permits only a *single* concurrent stream per account token.
// The previous implementation opened a fresh upstream connection to Yandex for
// every listener (one per browser), so when several devices played the same
// track only one of them actually received audio while the others stalled —
// "synchronized, but sound comes from a single device".
//
// This cache downloads each track from Yandex exactly once into a local file
// and then serves every client from that shared copy (with full HTTP range
// support). The number of connected devices no longer matters because there is
// never more than one upstream connection per track.
// ----------------------------------------------------------------------------

type audioCache struct {
	dir string

	mu      sync.Mutex
	entries map[string]*cacheEntry
}

type cacheEntry struct {
	once sync.Once
	path string
	err  error
}

func newAudioCache() *audioCache {
	dir, err := os.MkdirTemp("", "partymusic-cache-")
	if err != nil {
		dir = filepath.Join(os.TempDir(), "partymusic-cache")
		_ = os.MkdirAll(dir, 0o755)
	}
	return &audioCache{dir: dir, entries: make(map[string]*cacheEntry)}
}

// get returns the local file path for a track, downloading it (exactly once)
// via the provided resolver if it is not already cached. Concurrent callers for
// the same id all block on the single in-flight download instead of each
// starting their own upstream connection.
func (ac *audioCache) get(id string, resolve func() (string, error)) (string, error) {
	ac.mu.Lock()
	e, ok := ac.entries[id]
	if !ok {
		e = &cacheEntry{}
		ac.entries[id] = e
	}
	ac.mu.Unlock()

	e.once.Do(func() {
		e.path, e.err = ac.download(id, resolve)
		if e.err != nil {
			// Drop the failed entry so a later request can retry the download.
			ac.mu.Lock()
			delete(ac.entries, id)
			ac.mu.Unlock()
		}
	})
	return e.path, e.err
}

// download resolves the upstream URL, streams the whole track to a local file
// and returns its path. The download is done to a ".part" file and atomically
// renamed on success so a half-written file is never served.
func (ac *audioCache) download(id string, resolve func() (string, error)) (string, error) {
	streamURL, err := resolve()
	if err != nil {
		return "", err
	}

	req, err := http.NewRequest(http.MethodGet, streamURL, nil)
	if err != nil {
		return "", err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("upstream status %d", resp.StatusCode)
	}

	safe := sanitizeID(id)
	final := filepath.Join(ac.dir, safe)
	tmp := final + ".part"

	f, err := os.Create(tmp)
	if err != nil {
		return "", err
	}
	if _, err := io.Copy(f, resp.Body); err != nil {
		_ = f.Close()
		_ = os.Remove(tmp)
		return "", err
	}
	if err := f.Close(); err != nil {
		_ = os.Remove(tmp)
		return "", err
	}
	if err := os.Rename(tmp, final); err != nil {
		_ = os.Remove(tmp)
		return "", err
	}
	return final, nil
}

// sanitizeID keeps a track id safe to use as a filename.
func sanitizeID(id string) string {
	repl := func(r rune) rune {
		switch {
		case r >= '0' && r <= '9', r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z':
			return r
		default:
			return '_'
		}
	}
	return strings.Map(repl, id)
}
