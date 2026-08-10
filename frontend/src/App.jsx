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

  const wsRef = useRef(null)
  const audioRef = useRef(null)
  // Guards to avoid echoing server-driven changes back to the server.
  const applyingRemote = useRef(false)
  // Latest authoritative state, used by the drift corrector.
  const lastState = useRef({ trackIndex: -1, position: 0, playing: false })

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
      case 'state':
        applyState(msg.data)
        break
      default:
        break
    }
  }, [])

  // Apply the authoritative playback state to the local <audio> element.
  const applyState = useCallback((state) => {
    lastState.current = state
    const audio = audioRef.current
    applyingRemote.current = true

    const trackChanged = state.trackIndex !== trackIndex
    setTrackIndex(state.trackIndex)
    setPlaying(state.playing)

    if (!audio) {
      applyingRemote.current = false
      return
    }

    // Wait a tick so React swaps the <source> if the track changed.
    setTimeout(
      () => {
        if (!audio) return
        const drift = Math.abs(audio.currentTime - state.position)
        if (drift > SYNC_THRESHOLD || Number.isNaN(audio.currentTime) || trackChanged) {
          try {
            audio.currentTime = state.position
          } catch (e) {
            /* seeking before metadata is ready — ignored */
          }
        }
        if (state.playing) {
          audio.play().catch(() => {})
        } else {
          audio.pause()
        }
        applyingRemote.current = false
      },
      trackChanged ? 120 : 40
    )
  }, [trackIndex])

  // ----- Load track list + initial connection ---------------------------
  const doJoin = (roomName, userName) => {
    setRoom(roomName)
    setName(userName)
    setJoined(true)

    fetch('/api/health')
      .then((r) => r.json())
      .then((d) => setYandexEnabled(!!d.yandex))
      .catch(() => {})

    fetch('/api/tracks')
      .then((r) => r.json())
      .then((data) => setTracks(data || []))
      .catch(() => {})

    connect(roomName, userName)
  }

  // Periodically ask the server for the authoritative state to correct drift.
  useEffect(() => {
    if (!joined) return
    const id = setInterval(() => send('sync'), 4000)
    return () => clearInterval(id)
  }, [joined, send])

  // Continuous soft drift correction while playing (no hard seeks).
  useEffect(() => {
    if (!joined) return
    const id = setInterval(() => {
      const audio = audioRef.current
      const s = lastState.current
      if (!audio || !s.playing || applyingRemote.current) return
      // Project the last known server position forward.
      const expected =
        s.position + (Date.now() - (s.updatedAt || Date.now())) / 1000
      const drift = audio.currentTime - expected
      if (Math.abs(drift) > SYNC_THRESHOLD) {
        try {
          audio.currentTime = expected
        } catch (e) {
          /* ignore */
        }
      }
    }, 1000)
    return () => clearInterval(id)
  }, [joined])

  // ----- User actions (broadcast to the room) ---------------------------
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
            applyingRemote={applyingRemote}
            onPlay={onPlay}
            onPause={onPause}
            onSeek={onSeek}
            onEnded={onEnded}
          />
          <Search enabled={yandexEnabled} onAdd={onAdd} />
          <Playlist tracks={tracks} activeIndex={trackIndex} onSelect={onSelect} />
        </main>

        <aside className="sidebar">
          <Users users={users} me={name} />
          <Chat messages={messages} me={name} onSend={onSendChat} />
        </aside>
      </div>
    </div>
  )
}
