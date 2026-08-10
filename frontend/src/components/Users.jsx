import React from 'react'

export default function Users({ users, me }) {
  return (
    <section className="users">
      <h2>Listeners ({users.length})</h2>
      <ul>
        {users.map((u, i) => (
          <li key={`${u}-${i}`} className="user">
            <span className="dot" />
            {u}
            {u === me && <span className="me-tag">you</span>}
          </li>
        ))}
      </ul>
    </section>
  )
}
