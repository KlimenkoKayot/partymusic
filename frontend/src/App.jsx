import React, { useEffect, useRef, useState, useCallback } from 'react'
import Join from './components/Join.jsx'
import Player from './components/Player.jsx'
import Playlist from './components/Playlist.jsx'
import Users from './components/Users.jsx'
import Chat from './components/Chat.jsx'
import Search from './components/Search.jsx'

// ---------------------------------------------------------------------------
// Sync tuning
// ---------------------------------------------------------------------------
// Drift beyond this => hard seek (rare; e.g. after a buffering stall).
const HARD_SEEK_THRESHOLD = 0.3
// Drift below this is considered "in sync" — leave playbackRate at 1.
const RATE_DEADBAND = 0.02
// Maximum playback-rate deviation used for soft correction (±5% is inaudible
// with pitch preservation and converges 0.3 s of drift in ~6 s).
const MAX_RATE_ADJUST = 0.05
// How often the drift corrector runs.
const CORRECTOR_INTERVAL_MS = 250

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
  // Browsers block audio.play() without a user gesture. When that happens on
  // a follower we must surface a button so the user can unlock audio.
  const [needsGesture, setNeedsGesture] = useState(false)

  const wsRef = useRef(null)
  const audioRef = useRef(null)
  // Guards to avoid echoing server-driven changes back to the server.
  const applyingRemote = useRef(false)
  // Latest authoritative state; `updatedAt` is a SERVER-clock timestamp.
  const lastState = useRef({ trackIndex: -1, position: 0, playing: false, updatedAt: 0 })
  // Mirrors `trackIndex` for stable callbacks (the WS onmessage closure holds
  // the first render's applyState, so reading React state there is stale).
  const trackIndexRef = useRef(-1)

  // -------------------------------------------------------------------------
  // Shared clock (NTP-style over the WebSocket)
  // -------------------------------------------------------------------------
  // Every client continuously estimates `serverTime - localTime`. All sync
  // targets are computed on the SERVER clock, so two devices standing next to
  // each other resolve the exact same target position at the same physical
  // moment — regardless of how different their pings are.
  const rttRef = useRef(0) // smoothed round-trip time, ms
  const clockOffsetRef = useRef(0) // smoothed serverTime - localTime, ms
  const clockReadyRef = useRef(false)

  const serverNow = useCallback(() => Date.now() + clockOffsetRef.current, [])

  const onPong = useCallback((data) => {
    if (!data || !data.t || !data.serverTime) return
    const now = Date.now()
    const rtt = now - data.t
    if (rtt < 0 || rtt > 10000) return // nonsense sample
    // offset = server clock at the midpoint of the round trip minus our clock.
    const offset = data.serverTime - (data.t + rtt / 2)
    if (!clockReadyRef.current) {
      rttRef.current = rtt
      clockOffsetRef.current = offset
      clockReadyRef.current = true
      return
    }
    rttRef.current = rttRef.current * 0.8 + rtt * 0.2
    // Only trust offset samples taken over a "clean" round trip: congested
    // packets have asymmetric delays and would poison the clock estimate.
    if (rtt <= rttRef.current * 1.5 + 5) {
      clockOffsetRef.current = clockOffsetRef.current * 0.8 + offset * 0.2
    }
  }, [])

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
      case 'pong':
        onPong(msg.data)
        break
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

  // Target position on the shared clock: where the room "should" be right now.
  const targetPosition = useCallback(() => {
    const s = lastState.current
    if (!s.playing) return s.position
    return s.position + (serverNow() - s.updatedAt) / 1000
  }, [serverNow])

  // Apply the authoritative playback state to the local <audio> element.
  // This only handles DISCRETE transitions (track change, play/pause). All
  // positional alignment is done continuously by the drift corrector below —
  // hard seeks from here would fight with it and cause audible jumps.
  const applyState = useCallback((state) => {
    lastState.current = { ...state }
    const audio = audioRef.current
    applyingRemote.current = true

    // Compare against a ref, not React state: this callback is held by the
    // WebSocket onmessage closure, so state read here would always be stale.
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
    // user actions and get echoed back to the server — every client then
    // ping-pongs its own position into the room and playback never settles.
    const releaseGuard = () => {
      setTimeout(() => {
        applyingRemote.current = false
      }, 250)
    }

    // Wait a tick so React swaps the <source> if the track changed.
    setTimeout(
      () => {
        if (!audio) return
        if (trackChanged || !state.playing) {
          // Discrete jump: land straight on the shared-clock target.
          try {
            audio.currentTime = Math.max(0, targetPosition())
          } catch (e) {
            /* metadata not ready — corrector will fix it */
          }
        }
        if (state.playing) {
          audio
            .play()
            .then(
              () => setNeedsGesture(false),
              // NotAllowedError => autoplay blocked, user gesture required.
              () => setNeedsGesture(true)
            )
            .finally(releaseGuard)
        } else {
          audio.pause()
          audio.playbackRate = 1
          releaseGuard()
        }
      },
      trackChanged ? 120 : 0
    )
  }, [targetPosition])

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

  // Clock sync: a burst on join to converge fast, then a steady trickle.
  useEffect(() => {
    if (!joined) return
    let n = 0
    const burst = setInterval(() => {
      send('ping', { t: Date.now() })
      if (++n >= 8) clearInterval(burst)
    }, 300)
    const steady = setInterval(() => send('ping', { t: Date.now() }), 2000)
    return () => {
      clearInterval(burst)
      clearInterval(steady)
    }
  }, [joined, send])

  // Leader: publish the real <audio> clock, stamped with SERVER time. The
  // stamp makes the report self-describing — the server stores it as-is and
  // followers project from it on the same shared clock, so neither the
  // leader's ping nor the followers' ping can skew the target.
  useEffect(() => {
    if (!joined || !isLeader) return
    const id = setInterval(() => {
      const audio = audioRef.current
      if (!audio || applyingRemote.current || !clockReadyRef.current) return
      const playingNow = !audio.paused && !audio.ended
      send('leader_pos', {
        position: audio.currentTime || 0,
        playing: playingNow,
        at: serverNow(),
      })
    }, 500)
    return () => clearInterval(id)
  }, [joined, isLeader, send, serverNow])

  // Followers: fallback state poll (e.g. leader's tab throttled in background).
  useEffect(() => {
    if (!joined || isLeader) return
    const id = setInterval(() => send('sync'), 5000)
    return () => clearInterval(id)
  }, [joined, isLeader, send])

  // -------------------------------------------------------------------------
  // Continuous drift corrector (followers only)
  // -------------------------------------------------------------------------
  // Compares the local audio clock against the shared-clock target several
  // times per second and nudges `playbackRate` by up to ±5% — completely
  // inaudible, but it keeps devices locked "sound to sound". A hard seek is
  // used only for gross desync (buffer stall, tab wake-up).
  useEffect(() => {
    if (!joined || isLeader) return
    const id = setInterval(() => {
      const audio = audioRef.current
      const s = lastState.current
      if (!audio || !s.playing || audio.paused || applyingRemote.current) return
      if (!clockReadyRef.current) return

      const target = targetPosition()
      const drift = audio.currentTime - target // >0 we're ahead, <0 behind

      if (Math.abs(drift) > HARD_SEEK_THRESHOLD) {
        try {
          // Land slightly ahead of the target to absorb the seek latency.
          audio.currentTime = target + 0.05
          audio.playbackRate = 1
        } catch (e) {
          /* metadata not ready */
        }
        return
      }

      if (Math.abs(drift) < RATE_DEADBAND) {
        if (audio.playbackRate !== 1) audio.playbackRate = 1
        return
      }

      // Proportional controller: correction strength scales with drift.
      const adjust = Math.max(
        -MAX_RATE_ADJUST,
        Math.min(MAX_RATE_ADJUST, -drift * 0.5)
      )
      audio.playbackRate = 1 + adjust
    }, CORRECTOR_INTERVAL_MS)
    return () => clearInterval(id)
  }, [joined, isLeader, targetPosition])

  // Keep pitch natural during rate corrections.
  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return
    try {
      audio.preservesPitch = true
      audio.mozPreservesPitch = true
      audio.webkitPreservesPitch = true
    } catch (e) {
      /* older browsers */
    }
  }, [joined])

  // Unlock audio with a real user gesture (autoplay policy), then jump to
  // the shared-clock target so we come in already in sync.
  const enableAudio = () => {
    const audio = audioRef.current
    if (!audio) return
    applyingRemote.current = true
    try {
      audio.currentTime = Math.max(0, targetPosition())
    } catch (e) {
      /* metadata not ready — the corrector will align us */
    }
    audio
      .play()
      .then(() => setNeedsGesture(false))
      .catch(() => {})
      .finally(() => {
        setTimeout(() => {
          applyingRemote.current = false
        }, 250)
      })
  }

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
          {needsGesture && playing && (
            <div className="player" style={{ textAlign: 'center' }}>
              <button className="play-btn" onClick={enableAudio}>
                🔊 Включить звук (браузер заблокировал автовоспроизведение)
              </button>
            </div>
          )}
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
