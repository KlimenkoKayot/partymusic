import React, { useEffect, useRef, useState, useCallback } from 'react'
import Join from './components/Join.jsx'
import Player from './components/Player.jsx'
import Playlist from './components/Playlist.jsx'
import Users from './components/Users.jsx'
import Chat from './components/Chat.jsx'
import Search from './components/Search.jsx'

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
  // Simple approach: set currentTime directly and play/pause.
  const applyState = useCallback((state) => {
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
        // Set the position directly from server state
        try {
          audio.currentTime = state.position || 0
        } catch (e) {
          /* metadata not ready */
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
          releaseGuard()
        }
      },
      trackChanged ? 120 : 0
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

  // All clients: fallback state poll (e.g. tab throttled in background).
  useEffect(() => {
    if (!joined) return
    const id = setInterval(() => send('sync'), 5000)
    return () => clearInterval(id)
  }, [joined, send])

  // Unlock audio with a real user gesture (autoplay policy).
  const enableAudio = () => {
    const audio = audioRef.current
    if (!audio) return
    applyingRemote.current = true
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
