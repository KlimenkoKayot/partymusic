import React, { useState, useRef } from 'react'

// Search Yandex Music and add results to the room queue.
export default function Search({ enabled, onAdd }) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const debounceRef = useRef(null)

  const runSearch = async (q) => {
    if (!q.trim()) {
      setResults([])
      return
    }
    setLoading(true)
    setError('')
    try {
      const r = await fetch(`/api/yandex/search?q=${encodeURIComponent(q)}&limit=20`)
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const data = await r.json()
      setResults(data || [])
    } catch (e) {
      setError('Search failed. Check the Yandex Music token on the server.')
      setResults([])
    } finally {
      setLoading(false)
    }
  }

  const onChange = (e) => {
    const q = e.target.value
    setQuery(q)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => runSearch(q), 400)
  }

  const submit = (e) => {
    e.preventDefault()
    if (debounceRef.current) clearTimeout(debounceRef.current)
    runSearch(query)
  }

  if (!enabled) {
    return (
      <section className="search">
        <h2>Yandex Music</h2>
        <div className="empty">
          Yandex Music search is disabled. Set <code>YANDEX_MUSIC_TOKEN</code> on the
          backend to enable it (see the README for where to get the token).
        </div>
      </section>
    )
  }

  return (
    <section className="search">
      <h2>Search Yandex Music</h2>
      <form className="search-input" onSubmit={submit}>
        <input
          type="text"
          value={query}
          placeholder="Search songs, artists…"
          onChange={onChange}
        />
        <button type="submit">Search</button>
      </form>

      {loading && <div className="empty">Searching…</div>}
      {error && <div className="empty error">{error}</div>}

      <ul className="search-results">
        {results.map((t) => (
          <li key={t.id} className="search-result">
            {t.cover ? (
              <img className="result-cover" src={t.cover} alt="" />
            ) : (
              <div className="result-cover placeholder">🎵</div>
            )}
            <div className="result-meta">
              <div className="result-title">{t.title}</div>
              <div className="result-artist">{t.artist}</div>
            </div>
            <button className="add-btn" onClick={() => onAdd(t)} title="Add to room">
              ＋
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}
