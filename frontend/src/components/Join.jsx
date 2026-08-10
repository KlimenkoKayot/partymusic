import React, { useState } from 'react'

export default function Join({ onJoin }) {
  const [room, setRoom] = useState('lobby')
  const [name, setName] = useState('')

  const submit = (e) => {
    e.preventDefault()
    const r = room.trim() || 'lobby'
    const n = name.trim() || `guest-${Math.floor(Math.random() * 1000)}`
    onJoin(r, n)
  }

  return (
    <div className="join-screen">
      <form className="join-card" onSubmit={submit}>
        <div className="join-logo">🎵</div>
        <h1>PartyMusic</h1>
        <p className="subtitle">Listen to music together, perfectly in sync.</p>

        <label>
          Your name
          <input
            type="text"
            value={name}
            placeholder="DJ Awesome"
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
        </label>

        <label>
          Room
          <input
            type="text"
            value={room}
            placeholder="lobby"
            onChange={(e) => setRoom(e.target.value)}
          />
        </label>

        <button type="submit">Join room</button>
      </form>
    </div>
  )
}
