import { useEffect, useState } from 'react'
import { apiFetch } from './api'

const box = { background: '#1e222d', border: '1px solid #2a2e39', borderRadius: 6, padding: 16 }
const input = { background: '#131722', color: '#d1d4dc', border: '1px solid #2a2e39', borderRadius: 4, padding: '6px 10px', width: '100%' }
const label = { color: '#787b86', fontSize: 12, marginBottom: 4, display: 'block' }
const field = { marginBottom: 10 }

export default function Admin() {
  const [users, setUsers] = useState([])
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [demoMode, setDemoMode] = useState(true)
  const [angelone, setAngelone] = useState({ api_key: '', user_id: '', password: '', totp: '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState(null)

  async function loadUsers() {
    const res = await apiFetch('/api/admin/users')
    const data = await res.json()
    if (data.success) setUsers(data.users)
  }

  useEffect(() => { loadUsers() }, [])

  async function createUser(e) {
    e.preventDefault()
    setBusy(true)
    setError('')
    setResult(null)
    try {
      const res = await apiFetch('/api/admin/users', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username, password,
          angelone: demoMode ? null : angelone,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || 'failed to create user')
      setResult(data)
      setUsername('')
      setPassword('')
      setAngelone({ api_key: '', user_id: '', password: '', totp: '' })
      loadUsers()
    } catch (err) {
      setError(err.message)
    }
    setBusy(false)
  }

  return (
    <div style={{ padding: 24, maxWidth: 480, display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div style={box}>
        <h3 style={{ color: '#d1d4dc', marginTop: 0 }}>Add user</h3>
        <form onSubmit={createUser}>
          <div style={field}>
            <label style={label}>Username</label>
            <input style={input} value={username} onChange={(e) => setUsername(e.target.value)} required />
          </div>
          <div style={field}>
            <label style={label}>Password</label>
            <input style={input} type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </div>
          <div style={{ ...field, display: 'flex', alignItems: 'center', gap: 8 }}>
            <input type="checkbox" id="demoMode" checked={demoMode} onChange={(e) => setDemoMode(e.target.checked)} />
            <label htmlFor="demoMode" style={{ color: '#d1d4dc', fontSize: 13 }}>
              Demo mode (no broker account yet — paper trading only)
            </label>
          </div>
          {!demoMode && (
            <>
              <div style={field}>
                <label style={label}>AngelOne API key</label>
                <input style={input} value={angelone.api_key} onChange={(e) => setAngelone({ ...angelone, api_key: e.target.value })} required />
              </div>
              <div style={field}>
                <label style={label}>AngelOne client (user) ID</label>
                <input style={input} value={angelone.user_id} onChange={(e) => setAngelone({ ...angelone, user_id: e.target.value })} required />
              </div>
              <div style={field}>
                <label style={label}>AngelOne password</label>
                <input style={input} type="password" value={angelone.password} onChange={(e) => setAngelone({ ...angelone, password: e.target.value })} required />
              </div>
              <div style={field}>
                <label style={label}>AngelOne TOTP secret</label>
                <input style={input} value={angelone.totp} onChange={(e) => setAngelone({ ...angelone, totp: e.target.value })} required />
              </div>
            </>
          )}
          {error && <div style={{ color: '#ef5350', fontSize: 13, marginBottom: 10 }}>{error}</div>}
          <button
            disabled={busy} type="submit"
            style={{ background: '#2962ff', color: '#fff', border: 'none', borderRadius: 4, padding: '8px 14px', cursor: 'pointer' }}
          >
            {busy ? 'Creating…' : 'Create user'}
          </button>
        </form>
        {result && (
          <div style={{ marginTop: 12, fontSize: 13, color: '#d1d4dc' }}>
            Created {result.username} — ports {result.webview_port}/{result.ai_port}.{' '}
            Dashboard bot: {result.webview_alive ? '🟢 running' : '🔴 failed to start'}, AI bot: {result.ai_alive ? '🟢 running' : '🔴 failed to start'}.
            {(!result.webview_alive || !result.ai_alive) && ' Check that user\'s log files in SmartApi/logs/ — a real broker login can fail if throttled; retry from a terminal.'}
          </div>
        )}
      </div>

      <div style={box}>
        <h3 style={{ color: '#d1d4dc', marginTop: 0 }}>Users</h3>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ color: '#787b86', textAlign: 'left' }}>
              <th style={{ padding: '4px 8px' }}>Username</th>
              <th style={{ padding: '4px 8px' }}>Ports</th>
              <th style={{ padding: '4px 8px' }}>Status</th>
              <th style={{ padding: '4px 8px' }}>Admin</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.username} style={{ borderTop: '1px solid #2a2e39' }}>
                <td style={{ padding: '6px 8px', color: '#d1d4dc' }}>{u.username}</td>
                <td style={{ padding: '6px 8px', color: '#787b86' }}>{u.webview_port} / {u.ai_port}</td>
                <td style={{ padding: '6px 8px' }}>
                  {u.webview_alive ? '🟢' : '🔴'} dashboard&nbsp;&nbsp;{u.ai_alive ? '🟢' : '🔴'} AI
                </td>
                <td style={{ padding: '6px 8px', color: '#787b86' }}>{u.is_admin ? 'yes' : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
