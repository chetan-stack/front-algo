import { Fragment, useEffect, useState } from 'react'
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
  const [includeCrypto, setIncludeCrypto] = useState(false)
  const [cryptoDemoMode, setCryptoDemoMode] = useState(true)
  const [deltaex, setDeltaex] = useState({ api_key: '', api_secret: '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState(null)

  const [managingUser, setManagingUser] = useState(null)
  const [managingCreds, setManagingCreds] = useState(null)
  const [managingCrypto, setManagingCrypto] = useState(null)
  const [newPassword, setNewPassword] = useState('')
  const [manageBusy, setManageBusy] = useState(false)
  const [manageMessage, setManageMessage] = useState('')
  const [cryptoBusy, setCryptoBusy] = useState(false)
  const [cryptoMessage, setCryptoMessage] = useState('')

  async function loadUsers() {
    const res = await apiFetch('/api/admin/users')
    const data = await res.json()
    if (data.success) setUsers(data.users)
  }

  useEffect(() => { loadUsers() }, [])

  async function openManage(u) {
    if (managingUser === u.username) {
      setManagingUser(null)
      return
    }
    setManagingUser(u.username)
    setManageMessage('')
    setCryptoMessage('')
    setNewPassword('')
    const res = await apiFetch(`/api/admin/users/${u.username}/credentials`)
    const data = await res.json()
    setManagingCreds(data.success ? data : { demo_mode: true, api_key: '', user_id: '', password: '', totp: '' })
    const cryptoRes = await apiFetch(`/api/admin/users/${u.username}/crypto-credentials`)
    const cryptoData = await cryptoRes.json()
    setManagingCrypto(cryptoData)
  }

  async function saveCryptoCredentials() {
    setCryptoBusy(true)
    setCryptoMessage('')
    try {
      const res = await apiFetch(`/api/admin/users/${managingUser}/crypto-credentials`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deltaex: managingCrypto.demo_mode ? null : managingCrypto }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || 'failed to save')
      setCryptoMessage(`Saved (port ${data.crypto_port}). Dashboard: ${data.crypto_dashboard_alive ? '🟢' : '🔴'}, strategy: ${data.crypto_strategy_alive ? '🟢' : '🔴'}.`)
      loadUsers()
    } catch (err) {
      setCryptoMessage(`Error: ${err.message}`)
    }
    setCryptoBusy(false)
  }

  async function saveCredentials() {
    setManageBusy(true)
    setManageMessage('')
    try {
      const res = await apiFetch(`/api/admin/users/${managingUser}/credentials`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ angelone: managingCreds.demo_mode ? null : managingCreds }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || 'failed to save')
      setManageMessage(`Saved. Dashboard bot: ${data.webview_alive ? '🟢' : '🔴'}, AI bot: ${data.ai_alive ? '🟢' : '🔴'}.`)
      loadUsers()
    } catch (err) {
      setManageMessage(`Error: ${err.message}`)
    }
    setManageBusy(false)
  }

  async function resetPassword() {
    if (!newPassword) return
    setManageBusy(true)
    setManageMessage('')
    try {
      const res = await apiFetch(`/api/admin/users/${managingUser}/reset-password`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: newPassword }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || 'failed to reset password')
      setManageMessage('Password reset — that user is logged out everywhere and must sign in again with the new password.')
      setNewPassword('')
    } catch (err) {
      setManageMessage(`Error: ${err.message}`)
    }
    setManageBusy(false)
  }

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
          include_crypto: includeCrypto,
          deltaex: includeCrypto && !cryptoDemoMode ? deltaex : null,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || 'failed to create user')
      setResult(data)
      setUsername('')
      setPassword('')
      setAngelone({ api_key: '', user_id: '', password: '', totp: '' })
      setIncludeCrypto(false)
      setCryptoDemoMode(true)
      setDeltaex({ api_key: '', api_secret: '' })
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

          <div style={{ ...field, display: 'flex', alignItems: 'center', gap: 8, marginTop: 14, paddingTop: 10, borderTop: '1px solid #2a2e39' }}>
            <input type="checkbox" id="includeCrypto" checked={includeCrypto} onChange={(e) => setIncludeCrypto(e.target.checked)} />
            <label htmlFor="includeCrypto" style={{ color: '#d1d4dc', fontSize: 13 }}>Also set up crypto trading</label>
          </div>
          {includeCrypto && (
            <>
              <div style={{ ...field, display: 'flex', alignItems: 'center', gap: 8 }}>
                <input type="checkbox" id="cryptoDemoMode" checked={cryptoDemoMode} onChange={(e) => setCryptoDemoMode(e.target.checked)} />
                <label htmlFor="cryptoDemoMode" style={{ color: '#d1d4dc', fontSize: 13 }}>
                  Crypto demo mode (no DeltaEx account yet — paper trading only)
                </label>
              </div>
              {!cryptoDemoMode && (
                <>
                  <div style={field}>
                    <label style={label}>DeltaEx API key</label>
                    <input style={input} value={deltaex.api_key} onChange={(e) => setDeltaex({ ...deltaex, api_key: e.target.value })} required />
                  </div>
                  <div style={field}>
                    <label style={label}>DeltaEx API secret</label>
                    <input style={input} type="password" value={deltaex.api_secret} onChange={(e) => setDeltaex({ ...deltaex, api_secret: e.target.value })} required />
                  </div>
                </>
              )}
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
            {result.crypto_port != null && (
              <> Crypto (port {result.crypto_port}): dashboard {result.crypto_dashboard_alive ? '🟢' : '🔴'}, strategy {result.crypto_strategy_alive ? '🟢' : '🔴'}.</>
            )}
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
              <th style={{ padding: '4px 8px' }}>Crypto</th>
              <th style={{ padding: '4px 8px' }}>Admin</th>
              <th style={{ padding: '4px 8px' }}></th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <Fragment key={u.username}>
                <tr style={{ borderTop: '1px solid #2a2e39' }}>
                  <td style={{ padding: '6px 8px', color: '#d1d4dc' }}>{u.username}</td>
                  <td style={{ padding: '6px 8px', color: '#787b86' }}>{u.webview_port} / {u.ai_port}</td>
                  <td style={{ padding: '6px 8px' }}>
                    {u.webview_alive ? '🟢' : '🔴'} dashboard&nbsp;&nbsp;{u.ai_alive ? '🟢' : '🔴'} AI
                  </td>
                  <td style={{ padding: '6px 8px', color: '#787b86' }}>
                    {u.crypto_port == null ? '—' : <>{u.crypto_dashboard_alive ? '🟢' : '🔴'} dash&nbsp;&nbsp;{u.crypto_strategy_alive ? '🟢' : '🔴'} strat</>}
                  </td>
                  <td style={{ padding: '6px 8px', color: '#787b86' }}>{u.is_admin ? 'yes' : ''}</td>
                  <td style={{ padding: '6px 8px' }}>
                    <button
                      onClick={() => openManage(u)}
                      style={{ background: 'transparent', color: '#2962ff', border: '1px solid #2a2e39', borderRadius: 4, padding: '3px 8px', cursor: 'pointer', fontSize: 12 }}
                    >
                      {managingUser === u.username ? 'Close' : 'Manage'}
                    </button>
                  </td>
                </tr>
                {managingUser === u.username && managingCreds && (
                  <tr>
                    <td colSpan={6} style={{ padding: '10px 8px', background: '#131722' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                        <input
                          type="checkbox" id={`demo-${u.username}`} checked={managingCreds.demo_mode}
                          onChange={(e) => setManagingCreds({ ...managingCreds, demo_mode: e.target.checked })}
                        />
                        <label htmlFor={`demo-${u.username}`} style={{ color: '#d1d4dc' }}>Demo mode</label>
                      </div>
                      {!managingCreds.demo_mode && (
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 10 }}>
                          <div>
                            <label style={label}>AngelOne API key</label>
                            <input style={input} value={managingCreds.api_key} onChange={(e) => setManagingCreds({ ...managingCreds, api_key: e.target.value })} />
                          </div>
                          <div>
                            <label style={label}>AngelOne client (user) ID</label>
                            <input style={input} value={managingCreds.user_id} onChange={(e) => setManagingCreds({ ...managingCreds, user_id: e.target.value })} />
                          </div>
                          <div>
                            <label style={label}>AngelOne password</label>
                            <input style={input} type="password" value={managingCreds.password} onChange={(e) => setManagingCreds({ ...managingCreds, password: e.target.value })} />
                          </div>
                          <div>
                            <label style={label}>AngelOne TOTP secret</label>
                            <input style={input} value={managingCreds.totp} onChange={(e) => setManagingCreds({ ...managingCreds, totp: e.target.value })} />
                          </div>
                        </div>
                      )}
                      <button
                        disabled={manageBusy} onClick={saveCredentials}
                        style={{ background: '#2962ff', color: '#fff', border: 'none', borderRadius: 4, padding: '6px 12px', cursor: 'pointer', fontSize: 12, marginRight: 8 }}
                      >
                        {manageBusy ? 'Saving…' : 'Save & restart bots'}
                      </button>

                      {managingCrypto && (
                        <div style={{ marginTop: 14, paddingTop: 10, borderTop: '1px solid #2a2e39' }}>
                          <div style={{ color: '#d1d4dc', fontSize: 13, marginBottom: 8 }}>
                            Crypto{!managingCrypto.provisioned && ' (not set up yet)'}
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                            <input
                              type="checkbox" id={`crypto-demo-${u.username}`} checked={managingCrypto.demo_mode}
                              onChange={(e) => setManagingCrypto({ ...managingCrypto, demo_mode: e.target.checked })}
                            />
                            <label htmlFor={`crypto-demo-${u.username}`} style={{ color: '#d1d4dc' }}>Demo mode</label>
                          </div>
                          {!managingCrypto.demo_mode && (
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 10 }}>
                              <div>
                                <label style={label}>DeltaEx API key</label>
                                <input style={input} value={managingCrypto.api_key} onChange={(e) => setManagingCrypto({ ...managingCrypto, api_key: e.target.value })} />
                              </div>
                              <div>
                                <label style={label}>DeltaEx API secret</label>
                                <input style={input} type="password" value={managingCrypto.api_secret} onChange={(e) => setManagingCrypto({ ...managingCrypto, api_secret: e.target.value })} />
                              </div>
                            </div>
                          )}
                          <button
                            disabled={cryptoBusy} onClick={saveCryptoCredentials}
                            style={{ background: '#2962ff', color: '#fff', border: 'none', borderRadius: 4, padding: '6px 12px', cursor: 'pointer', fontSize: 12 }}
                          >
                            {cryptoBusy ? 'Saving…' : managingCrypto.provisioned ? 'Save & restart crypto bots' : 'Set up crypto'}
                          </button>
                          {cryptoMessage && <div style={{ marginTop: 8, fontSize: 12, color: '#d1d4dc' }}>{cryptoMessage}</div>}
                        </div>
                      )}

                      <div style={{ marginTop: 14, paddingTop: 10, borderTop: '1px solid #2a2e39', display: 'flex', alignItems: 'center', gap: 8 }}>
                        <input
                          style={{ ...input, width: 200 }} type="password" placeholder="New app password"
                          value={newPassword} onChange={(e) => setNewPassword(e.target.value)}
                        />
                        <button
                          disabled={manageBusy || !newPassword} onClick={resetPassword}
                          style={{ background: 'transparent', color: '#ef5350', border: '1px solid #2a2e39', borderRadius: 4, padding: '6px 12px', cursor: 'pointer', fontSize: 12 }}
                        >
                          Reset password
                        </button>
                        <span style={{ color: '#787b86', fontSize: 12 }}>(app login password can't be viewed, only reset)</span>
                      </div>

                      {manageMessage && <div style={{ marginTop: 10, fontSize: 12, color: '#d1d4dc' }}>{manageMessage}</div>}
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
