# 🎵 PartyMusic — Synchronized Music Listening

Listen to music **together, perfectly in sync**. Anyone in a room can control
playback (play / pause / seek / track selection) and everyone in the same room
hears the same thing at the same moment — even if they join late. Includes
**Yandex Music search**, a shared per-room queue, a live listener list and chat.

- **Backend:** Go (`gorilla/websocket`) — authoritative playback state, rooms,
  track API, audio streaming with HTTP range support.
- **Frontend:** React + plain CSS (Vite build).
- **Delivery:** Docker Compose (nginx serves the SPA and reverse-proxies the API
  + WebSocket to the Go service).

---

## Quick start

1. Put some audio files into the [`music/`](music) folder
   (`.mp3`, `.ogg`, `.wav`, `.flac`, `.m4a`, `.aac`, `.opus`).
2. Start everything:

   ```bash
   bash run.sh
   ```

3. Open **http://localhost:8000** in your browser.
4. Share the room name with friends — everyone who joins the same room listens
   in sync.

To use a different host port:

```bash
PORT=9000 bash run.sh
```

---

## 🎧 Yandex Music search (where to get the token)

> **Important:** Yandex does **not** provide an official public Music API, and
> you **cannot create your own OAuth app** with Music scopes. Integration uses
> the same unofficial endpoint (`api.music.yandex.net`) that community clients
> use, authenticated with a **personal OAuth token from your own account**.
> Use it only for your personal account and at your own discretion — a Yandex
> Plus subscription is required to stream full tracks.

### How to get your token

Since you already have a Yandex account, pick any of these:

1. **Browser (no tools).** Open this URL while logged in to your Yandex account:

   ```
   https://oauth.yandex.ru/authorize?response_type=token&client_id=23cabbbdc6cd418abb4b39c32c41195d
   ```

   You'll be redirected to a `music.yandex.ru/#access_token=...` URL. Copy the
   value of the `access_token` parameter — that's your token. (Tip: open
   DevTools → Network and enable throttling, the redirect is fast.)

2. **Browser extension** "Yandex Music Token" (Chrome) — grabs the token for you.

3. **Python one-liner** (device flow, works for all accounts):

   ```bash
   pip install yandex-music
   python -c "from yandex_music import Client; \
   print(Client().device_auth(on_code=lambda c: print(c.verification_url, c.user_code)).access_token)"
   ```

The token is a long string. Keep it secret — it grants access to your account.

### Enable it

Put the token in a `.env` file next to `docker-compose.yml`:

```bash
echo "YANDEX_MUSIC_TOKEN=your_token_here" > .env
bash run.sh
```

When set, a **"Search Yandex Music"** box appears in the UI. Search, click ＋ to
add a track to the room queue, and it plays in sync for everyone. If the token
is not set, the app still works with local files from `music/`.

**Security note:** the token stays on the backend only. Audio is streamed
through the server's `/api/yandex/stream/<id>` proxy, so the token is never sent
to browsers.

---

## `run.sh` commands

| Command             | Description                                   |
| ------------------- | --------------------------------------------- |
| `bash run.sh`       | Build images and start (default: `up`)        |
| `bash run.sh down`  | Stop and remove the containers                |
| `bash run.sh logs`  | Follow the container logs                     |
| `bash run.sh restart` | Restart the service                         |
| `bash run.sh rebuild` | Rebuild images from scratch and start       |

---

## How synchronization works

The Go backend keeps the **authoritative playback state** for each room:

```
trackIndex, position, playing, updatedAt
```

- When any client plays / pauses / seeks / selects a track, it sends the action
  over WebSocket. The server updates the shared state and broadcasts a `state`
  message to everyone.
- While playing, the server **projects the position forward in time**
  (`position + elapsed`) so a late joiner starts exactly where the room is now.
- Each client periodically requests a `sync` and only re-seeks when local drift
  exceeds a threshold (0.75 s), keeping playback smooth.
- When a track ends, the server auto-advances the whole room to the next track.

### WebSocket message types

| Direction        | Type       | Payload                         |
| ---------------- | ---------- | ------------------------------- |
| client → server  | `play`     | `{ position }`                  |
| client → server  | `pause`    | `{ position }`                  |
| client → server  | `seek`     | `{ position }`                  |
| client → server  | `select`   | `{ trackIndex }`                |
| client → server  | `ended`    | —                               |
| client → server  | `sync`     | —                               |
| client → server  | `chat`     | `{ text }`                      |
| client → server  | `add`      | `Track` (from Yandex search)    |
| server → client  | `playlist` | `Track[]`                       |
| server → client  | `state`    | `{ trackIndex, position, playing, updatedAt }` |
| server → client  | `users`    | `string[]`                      |
| server → client  | `chat`     | `{ user, text, ts }`            |

---

## Project layout

```
.
├── backend/            # Go WebSocket sync server
│   ├── main.go         # HTTP routes, WS upgrade, track scan, audio serving
│   ├── hub.go          # Hub + Room: shared state and broadcasting
│   ├── client.go       # Per-connection read/write pumps
│   └── Dockerfile
├── frontend/           # React + CSS (Vite)
│   ├── src/
│   │   ├── App.jsx      # WS connection + sync logic
│   │   └── components/  # Join, Player, Playlist, Users, Chat
│   ├── nginx.conf      # SPA + reverse proxy to backend
│   └── Dockerfile
├── music/              # Drop your audio files here
├── docker-compose.yml
├── run.sh              # One-command launcher
└── README.md
```

---

## Local development (without Docker)

Backend:

```bash
cd backend
MUSIC_DIR=../music go run .
# listens on :8080
```

Frontend:

```bash
cd frontend
npm install
npm run dev
# opens on :5173 and proxies /api, /music, /ws to :8080
```

---

## Configuration

| Variable             | Component | Default      | Description                              |
| -------------------- | --------- | ------------ | ---------------------------------------- |
| `LISTEN_ADDR`        | backend   | `:8080`      | Address the Go server listens on         |
| `MUSIC_DIR`          | backend   | `/app/music` | Directory scanned for audio files        |
| `YANDEX_MUSIC_TOKEN` | backend   | _(unset)_    | Personal Yandex OAuth token for search   |
| `PORT`               | run.sh    | `8000`       | Host port for the web UI                 |
