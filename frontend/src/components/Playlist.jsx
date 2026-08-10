import React from 'react'

export default function Playlist({ tracks, activeIndex, onSelect }) {
  return (
    <section className="playlist">
      <h2>Room queue</h2>
      {tracks.length === 0 && (
        <div className="empty">
          Queue is empty. Search Yandex Music above, or drop audio files into the{' '}
          <code>music/</code> folder.
        </div>
      )}
      <ul>
        {tracks.map((t, i) => (
          <li
            key={t.id}
            className={i === activeIndex ? 'track active' : 'track'}
            onClick={() => onSelect(i)}
          >
            <span className="track-index">{i === activeIndex ? '♪' : i + 1}</span>
            {t.cover ? (
              <img className="track-cover" src={t.cover} alt="" />
            ) : null}
            <span className="track-name">
              {t.title}
              {t.artist ? <span className="track-artist"> — {t.artist}</span> : null}
            </span>
            <span className={`source-badge ${t.source || 'local'}`}>
              {t.source === 'yandex' ? 'Я.Music' : 'local'}
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}
