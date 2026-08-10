import React, { useEffect, useRef, useState, useCallback } from 'react'
import Join from './components/Join.jsx'
import Player from './components/Player.jsx'
import Playlist from './components/Playlist.jsx'
import Users from './components/Users.jsx'
import Chat from './components/Chat.jsx'
import Search from './components/Search.jsx'

// If the two players drift more than this many seconds, we hard-resync.
const SYNC_THRESHOLD = 0.6

export default function App() {
  const [joined, setJoined] = useState(false)
  const [room, setRoom] = useState('')
  const [name, setName] = useState('')

  const [connected, setConnected] = useState(false)
  const [tracks, setTracks] = useState([])
  const [users, setUsers] = useState([])
  const [messages, setMessages] = useState([])
  const [yandexEnabled, setYandexEnabled] = useState(false)

  // Authoritative shared state coming from the server.
  const [trackIndex, setTrackIndex] = useState(-1)
  const [playing, setPlaying] = useState(false)
  // Am I the room leader? The room creator (first joiner) drives playback;
  // everyone else follows the leader's audio clock.
  const [isLeader, setIsLeader] = useState(false)
  const isLeaderRef = useRef(false)

  const wsRef = useRef(null)
  const audioRef = useRef(null)
  // Guards to avoid echoing server-driven changes back to the server.
  const applyingRemote = useRef(false)
  // Latest authoritative state, used by the drift corrector.
  const lastState = useRef({ trackIndex: -1, position: 0, playing: false })
  // Mirrors `trackIndex` for stable callbacks (the WS onmessage closure holds
  // the first render's applyState, so reading React state there is stale).
  const trackIndexRef = useRef(-1)

  // ----- WebSocket connection -------------------------------------------
  const connect = useCallback((roomName, userName) => {
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const url = `${proto}://${window.location.host}/ws?room=${encodeURIComponent(
      roomName
    )}&name=${encodeURIComponent(userName)}`
    const ws = new WebSocket(url)
    wsRef.current = ws

    ws.onopen = () => setConnected(true)
    ws.onclose = () => {
      setConnected(false)
      setTimeout(() => connect(roomName, userName), 1500)
    }
    ws.onmessage = (ev) => handleMessage(JSON.parse(ev.data))
  }, [])

  const send = useCallback((type, data) => {
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type, data }))
    }
  }, [])

  // ----- Incoming server messages ---------------------------------------
  const handleMessage = useCallback((msg) => {
    switch (msg.type) {
      case 'playlist':
        setTracks(msg.data || [])
        break
      case 'users':
        setUsers(msg.data || [])
        break
      case 'chat':
        setMessages((m) => [...m, msg.data].slice(-100))
        break
      case 'role':
        isLeaderRef.current = !!(msg.data && msg.data.leader)
        setIsLeader(isLeaderRef.current)
        break
      case 'state':
        applyState(msg.data)
        break
      default:
        break
    }
  }, [])

  // Apply the authoritative playback state to the local <audio> element.
  const applyState = useCallback((state) => {
    // Capture a *client-local* reference timestamp. All forward projection is
    // done relative to this instead of the server's `updatedAt`, so clock skew
    // between the browser and the server can never leak into playback position.
    const receivedAt = Date.now()
    lastState.current = { ...state, receivedAt }
    const audio = audioRef.current
    applyingRemote.current = true

    // Compare against a ref, not React state: this callback is held by the
    // WebSocket onmessage closure, so state read here would always be the
    // first render's value (-1). That misreported *every* update as a track
    // change and forced a hard seek on each periodic sync, making playback
    // stutter and jump.
    const trackChanged = state.trackIndex !== trackIndexRef.current
    trackIndexRef.current = state.trackIndex
    setTrackIndex(state.trackIndex)
    setPlaying(state.playing)

    if (!audio) {
      applyingRemote.current = false
      return
    }

    // Native play/pause events are dispatched *asynchronously* after calling
    // play()/pause(). If the guard drops immediately, those events look like
    // user actions and get echoed back to the server with this client's local
    // position — every client then ping-pongs its own position into the room
    // and playback never settles. Keep the guard up until the events have
    // had time to fire.
    const releaseGuard = () => {
      setTimeout(() => {
        applyingRemote.current = false
      }, 250)
    }

    // Wait a tick so React swaps the <source> if the track changed.
    setTimeout(
      () => {
        if (!audio) return
        // Project the target forward by however long we waited so every client
        // lands on the same spot regardless of message/processing latency.
        const target = state.playing
          ? state.position + (Date.now() - receivedAt) / 1000
          : state.position
        const drift = Math.abs(audio.currentTime - target)
        // The leader never seeks to broadcast state (it originated from the
        // leader's own clock — seeking to a reflection of yourself only adds
        // jitter). Followers hard-seek on track change or noticeable drift.
        const shouldSeek = isLeaderRef.current
          ? trackChanged
          : drift > SYNC_THRESHOLD || Number.isNaN(audio.currentTime) || trackChanged
        if (shouldSeek) {
          try {
            audio.currentTime = target
          } catch (e) {
            /* seeking before metadata is ready — ignored */
          }
        }
        if (state.playing) {
          audio
            .play()
            .catch(() => {})
            .finally(releaseGuard)
        } else {
          audio.pause()
          releaseGuard()
        }
      },
      trackChanged ? 120 : 40
    )
  }, [])

  // ----- Load track list + initial connection ---------------------------
  const doJoin = (roomName, userName) => {
    setRoom(roomName)
    setName(userName)
    setJoined(true)

    fetch('/api/health')
      .then((r) => r.json())
      .then((d) => setYandexEnabled(!!d.yandex))
      .catch(() => {})

    // NOTE: we intentionally do NOT fetch('/api/tracks') here. That REST
    // endpoint only returns local files and would race with (and clobber) the
    // authoritative room queue that the server pushes over the WebSocket on
    // connect — which includes Yandex tracks added by others. The `playlist`
    // WS message is the single source of truth for the queue.
    connect(roomName, userName)
  }

  // Leader: push the real <audio> clock to the server every second. The
  // server rebroadcasts it to followers, so everyone tracks the leader's
  // actual playback (buffering stalls included) instead of wall-clock math.
  useEffect(() => {
    if (!joined || !isLeader) return
    const id = setInterval(() => {
      const audio = audioRef.current
      if (!audio || applyingRemote.current) return
      send('leader_pos', {
        position: audio.currentTime || 0,
        playing: !audio.paused && !audio.ended,
      })
    }, 1000)
    return () => clearInterval(id)
  }, [joined, isLeader, send])

  // Followers: periodically re-request the authoritative state as a fallback
  // (e.g. if the leader's tab is throttled and leader_pos stops flowing).
  useEffect(() => {
    if (!joined || isLeader) return
    const id = setInterval(() => send('sync'), 5000)
    return () => clearInterval(id)
  }, [joined, isLeader, send])

  // ----- User actions (broadcast to the room) ---------------------------
  // Playback control is leader-only; the server ignores it from followers.
  const onPlay = () => send('play', { position: audioRef.current?.currentTime || 0 })
  const onPause = () => send('pause', { position: audioRef.current?.currentTime || 0 })
  const onSeek = (position) => send('seek', { position })
  const onSelect = (index) => send('select', { trackIndex: index })
  const onEnded = () => send('ended')
  const onSendChat = (text) => send('chat', { text })
  const onAdd = (track) => send('add', track)

  const currentTrack =
    trackIndex >= 0 && trackIndex < tracks.length ? tracks[trackIndex] : null

  if (!joined) {
    return <Join onJoin={doJoin} />
  }

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">🎵 PartyMusic</div>
        <div className="room-info">
          Room <b>{room}</b>
          {isLeader && <span className="status online">DJ 🎛</span>}
          <span className={`status ${connected ? 'online' : 'offline'}`}>
            {connected ? 'connected' : 'reconnecting…'}
          </span>
        </div>
      </header>

      <div className="layout">
        <main className="main">
          <Player
            audioRef={audioRef}
            track={currentTrack}
            playing={playing}
            isLeader={isLeader}
            applyingRemote={applyingRemote}
            onPlay={onPlay}
            onPause={onPause}
            onSeek={onSeek}
            onEnded={onEnded}
          />
          <Search enabled={yandexEnabled} onAdd={onAdd} />
          <Playlist
            tracks={tracks}
            activeIndex={trackIndex}
            onSelect={isLeader ? onSelect : () => {}}
          />
        </main>

        <aside className="sidebar">
          <Users users={users} me={name} />
          <Chat messages={messages} me={name} onSend={onSendChat} />
        </aside>
      </div>
    </div>
  )
}
