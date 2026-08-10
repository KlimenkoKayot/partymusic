import React, { useEffect, useState } from 'react'

function fmt(t) {
  if (!t || Number.isNaN(t)) return '0:00'
  const m = Math.floor(t / 60)
  const s = Math.floor(t % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

export default function Player({
  audioRef,
  track,
  playing,
  applyingRemote,
  onPlay,
  onPause,
  onSeek,
  onEnded,
}) {
  const [current, setCurrent] = useState(0)
  const [duration, setDuration] = useState(0)

  // Keep the local progress bar updated.
  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return
    const onTime = () => setCurrent(audio.currentTime)
    const onMeta = () => setDuration(audio.duration || 0)
    audio.addEventListener('timeupdate', onTime)
    audio.addEventListener('loadedmetadata', onMeta)
    audio.addEventListener('durationchange', onMeta)
    return () => {
      audio.removeEventListener('timeupdate', onTime)
      audio.removeEventListener('loadedmetadata', onMeta)
      audio.removeEventListener('durationchange', onMeta)
    }
  }, [audioRef, track])

  // Native play/pause events that were user-initiated get forwarded up.
  const handlePlay = () => {
    if (applyingRemote.current) return
    onPlay()
  }
  const handlePause = () => {
    if (applyingRemote.current) return
    onPause()
  }

  const scrub = (e) => {
    const pos = Number(e.target.value)
    if (audioRef.current) audioRef.current.currentTime = pos
    setCurrent(pos)
    onSeek(pos)
  }

  return (
    <section className="player">
      <div className="now-playing">
        {track && track.cover ? (
          <img className="cover" src={track.cover} alt="" />
        ) : (
          <div className="cover">🎧</div>
        )}
        <div className="track-meta">
          <div className="track-title">{track ? track.title : 'No track selected'}</div>
          <div className="track-sub">
            {track
              ? track.artist
                ? `${track.artist} · ${playing ? 'Playing' : 'Paused'}`
                : playing
                ? 'Playing'
                : 'Paused'
              : 'Search Yandex Music or pick a song from the queue'}
          </div>
        </div>
      </div>

      <audio
        ref={audioRef}
        src={track ? track.url : undefined}
        onPlay={handlePlay}
        onPause={handlePause}
        onEnded={onEnded}
        preload="auto"
      />

      <div className="progress-row">
        <span className="time">{fmt(current)}</span>
        <input
          className="progress"
          type="range"
          min="0"
          max={duration || 0}
          step="0.1"
          value={current}
          onChange={scrub}
          disabled={!track}
        />
        <span className="time">{fmt(duration)}</span>
      </div>

      <div className="controls">
        {playing ? (
          <button className="play-btn" onClick={onPause} disabled={!track}>
            ⏸ Pause
          </button>
        ) : (
          <button className="play-btn" onClick={onPlay} disabled={!track}>
            ▶ Play
          </button>
        )}
      </div>
    </section>
  )
}
