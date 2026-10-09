import { useState } from 'react'
import { API } from './api'

const inputStyle = { background: '#1e222d', color: '#d1d4dc', border: '1px solid #2a2e39', borderRadius: 4, padding: '8px 10px' }

export default function Login({ onLogin }) {
  // The landing page's "Create account" links here with ?signup
  const [signup, setSignup] = useState(() => new URLSearchParams(window.location.search).has('signup'))
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e) {
    e.preventDefault()
    setError('')
    setNotice('')
    if (signup && password !== confirm) return setError('Passwords do not match')
    setBusy(true)
    try {
      const res = await fetch(`${API}/api/auth/${signup ? 'signup' : 'login'}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || (signup ? 'signup failed' : 'login failed'))
      if (signup) {
        setSignup(false)
        setPassword('')
        setConfirm('')
        setNotice('Account created. You can sign in once it is approved.')
        setBusy(false)
        return
      }
      onLogin(data.token, data.is_admin)
    } catch (err) {
      setError(err.message)
      setBusy(false)
    }
  }

  function toggle() {
    setSignup(!signup)
    setError('')
    setNotice('')
  }

  return (
    <div style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#131722' }}>
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 10, width: 260 }}>
        <h2 style={{ color: '#d1d4dc', margin: '0 0 8px' }}>{signup ? 'Create account' : 'Sign in'}</h2>
        <input
          value={username} onChange={(e) => setUsername(e.target.value)} placeholder="Username" autoFocus
          autoCapitalize="none" autoCorrect="off" maxLength={signup ? 20 : undefined}
          style={inputStyle}
        />
        <input
          value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password" type="password"
          autoComplete={signup ? 'new-password' : 'current-password'}
          style={inputStyle}
        />
        {signup && (
          <input
            value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="Confirm password" type="password"
            autoComplete="new-password" style={inputStyle}
          />
        )}
        {signup && <div style={{ color: '#787b86', fontSize: 12 }}>Username: 3-20 of a-z, 0-9, _. Password: at least 8 characters.</div>}
        {error && <div style={{ color: '#ef5350', fontSize: 13 }}>{error}</div>}
        {notice && <div style={{ color: '#26a69a', fontSize: 13 }}>{notice}</div>}
        <button
          disabled={busy} type="submit"
          style={{ background: '#2962ff', color: '#fff', border: 'none', borderRadius: 4, padding: '8px 10px', cursor: 'pointer' }}
        >
          {busy ? 'Please wait…' : signup ? 'Create account' : 'Sign in'}
        </button>
        <button
          type="button" onClick={toggle}
          style={{ background: 'transparent', color: '#2962ff', border: 'none', cursor: 'pointer', fontSize: 13 }}
        >
          {signup ? 'Already have an account? Sign in' : 'New here? Create account'}
        </button>
      </form>
    </div>
  )
}
