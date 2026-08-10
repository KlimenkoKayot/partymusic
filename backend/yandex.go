package main

import (
	"crypto/md5"
	"encoding/hex"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// ----------------------------------------------------------------------------
// Yandex Music integration.
//
// IMPORTANT: Yandex does NOT provide an official public Music API. This uses the
// same unofficial endpoint (api.music.yandex.net) that the community libraries
// use, authenticated with a personal OAuth token taken from your own account.
// See README for exactly where to get the token. If YANDEX_MUSIC_TOKEN is not
// set, all Yandex endpoints return 503 and only local files are served.
// ----------------------------------------------------------------------------

const (
	ymAPIBase = "https://api.music.yandex.net"
	// Well-known salt used to sign direct download URLs (reverse-engineered,
	// same value used by every community client).
	ymSignSalt = "XGRlBW9FXlekgbPrRHuSiA"
)

// YandexClient talks to the unofficial Yandex Music API.
type YandexClient struct {
	token string
	http  *http.Client
}

func NewYandexClient(token string) *YandexClient {
	return &YandexClient{
		token: token,
		http:  &http.Client{Timeout: 20 * time.Second},
	}
}

func (c *YandexClient) enabled() bool { return c != nil && c.token != "" }

// do performs an authenticated request against the Yandex Music API.
func (c *YandexClient) do(method, path string, query url.Values) ([]byte, error) {
	u := ymAPIBase + path
	if len(query) > 0 {
		u += "?" + query.Encode()
	}
	req, err := http.NewRequest(method, u, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "OAuth "+c.token)
	req.Header.Set("Accept-Language", "ru")
	req.Header.Set("User-Agent", "PartyMusic/1.0")

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("yandex api %s -> %d: %s", path, resp.StatusCode, truncate(string(body), 200))
	}
	return body, nil
}

// ----------------------------------------------------------------------------
// Search
// ----------------------------------------------------------------------------

type ymSearchResponse struct {
	Result struct {
		Tracks struct {
			Results []ymTrack `json:"results"`
		} `json:"tracks"`
	} `json:"result"`
}

type ymTrack struct {
	ID         json.Number `json:"id"`
	Title      string      `json:"title"`
	DurationMs int64       `json:"durationMs"`
	CoverURI   string      `json:"coverUri"`
	Artists    []ymArtist  `json:"artists"`
	Albums     []ymAlbum   `json:"albums"`
	Available  bool        `json:"available"`
}

type ymArtist struct {
	Name string `json:"name"`
}

type ymAlbum struct {
	ID json.Number `json:"id"`
}

// Search returns up to `limit` tracks matching the query, converted to our
// Track model with URLs that point back at our own streaming proxy.
func (c *YandexClient) Search(query string, limit int) ([]Track, error) {
	if !c.enabled() {
		return nil, errors.New("yandex music is not configured")
	}
	q := url.Values{}
	q.Set("text", query)
	q.Set("type", "track")
	q.Set("page", "0")
	q.Set("nocorrect", "false")

	body, err := c.do(http.MethodGet, "/search", q)
	if err != nil {
		return nil, err
	}
	var sr ymSearchResponse
	if err := json.Unmarshal(body, &sr); err != nil {
		return nil, err
	}

	var out []Track
	for _, t := range sr.Result.Tracks.Results {
		if limit > 0 && len(out) >= limit {
			break
		}
		if t.ID.String() == "" {
			continue
		}
		artist := ""
		names := make([]string, 0, len(t.Artists))
		for _, a := range t.Artists {
			names = append(names, a.Name)
		}
		artist = strings.Join(names, ", ")

		cover := ""
		if t.CoverURI != "" {
			// coverUri looks like "avatars.yandex.net/.../%%"; request 200x200.
			cover = "https://" + strings.Replace(t.CoverURI, "%%", "200x200", 1)
		}

		out = append(out, Track{
			ID:       "ym:" + t.ID.String(),
			Title:    t.Title,
			Artist:   artist,
			Cover:    cover,
			Duration: float64(t.DurationMs) / 1000.0,
			Source:   "yandex",
			// Stream through our own proxy so the OAuth token never leaks.
			URL: "/api/yandex/stream/" + t.ID.String(),
		})
	}
	return out, nil
}

// ----------------------------------------------------------------------------
// Stream URL resolution
// ----------------------------------------------------------------------------

type ymDownloadInfoResponse struct {
	Result []ymDownloadInfo `json:"result"`
}

type ymDownloadInfo struct {
	Codec           string `json:"codec"`
	BitrateInKbps   int    `json:"bitrateInKbps"`
	DownloadInfoURL string `json:"downloadInfoUrl"`
}

type ymDownloadInfoXML struct {
	Host string `xml:"host"`
	Path string `xml:"path"`
	TS   string `xml:"ts"`
	S    string `xml:"s"`
}

// ResolveStreamURL returns a direct, time-limited MP3 URL for a track ID.
func (c *YandexClient) ResolveStreamURL(trackID string) (string, error) {
	if !c.enabled() {
		return "", errors.New("yandex music is not configured")
	}

	body, err := c.do(http.MethodGet, "/tracks/"+trackID+"/download-info", nil)
	if err != nil {
		return "", err
	}
	var di ymDownloadInfoResponse
	if err := json.Unmarshal(body, &di); err != nil {
		return "", err
	}
	if len(di.Result) == 0 {
		return "", errors.New("no download info (track may be unavailable in your region/subscription)")
	}

	// Pick the highest-bitrate mp3 variant.
	best := -1
	for i, v := range di.Result {
		if v.Codec != "mp3" {
			continue
		}
		if best == -1 || v.BitrateInKbps > di.Result[best].BitrateInKbps {
			best = i
		}
	}
	if best == -1 {
		best = 0
	}

	// Fetch the XML that contains host/path/ts/s.
	req, _ := http.NewRequest(http.MethodGet, di.Result[best].DownloadInfoURL, nil)
	req.Header.Set("Authorization", "OAuth "+c.token)
	resp, err := c.http.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	xmlBody, _ := io.ReadAll(resp.Body)

	var info ymDownloadInfoXML
	if err := xml.Unmarshal(xmlBody, &info); err != nil {
		return "", err
	}
	if info.Host == "" || info.Path == "" {
		return "", errors.New("incomplete download info")
	}

	// sign = md5(salt + path[1:] + s)
	sig := md5.Sum([]byte(ymSignSalt + info.Path[1:] + info.S))
	sign := hex.EncodeToString(sig[:])

	return fmt.Sprintf("https://%s/get-mp3/%s/%s%s", info.Host, sign, info.TS, info.Path), nil
}

// ----------------------------------------------------------------------------
// helpers
// ----------------------------------------------------------------------------

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

func atoiDefault(s string, def int) int {
	if v, err := strconv.Atoi(s); err == nil {
		return v
	}
	return def
}
