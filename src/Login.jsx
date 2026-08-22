import { useState } from 'react'
import { API } from './api'

export default function Login({ onLogin }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e) {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      const res = await fetch(`${API}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || 'login failed')
      onLogin(data.token, data.is_admin)
    } catch (err) {
      setError(err.message)
      setBusy(false)
    }
  }

  return (
    <div style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#131722' }}>
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 10, width: 260 }}>
        <h2 style={{ color: '#d1d4dc', margin: '0 0 8px' }}>Sign in</h2>
        <input
          value={username} onChange={(e) => setUsername(e.target.value)} placeholder="Username" autoFocus
          style={{ background: '#1e222d', color: '#d1d4dc', border: '1px solid #2a2e39', borderRadius: 4, padding: '8px 10px' }}
        />
        <input
          value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password" type="password"
          style={{ background: '#1e222d', color: '#d1d4dc', border: '1px solid #2a2e39', borderRadius: 4, padding: '8px 10px' }}
        />
        {error && <div style={{ color: '#ef5350', fontSize: 13 }}>{error}</div>}
        <button
          disabled={busy} type="submit"
          style={{ background: '#2962ff', color: '#fff', border: 'none', borderRadius: 4, padding: '8px 10px', cursor: 'pointer' }}
        >
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  )
}
