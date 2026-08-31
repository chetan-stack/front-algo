import { Fragment, useEffect, useState } from 'react'
import { apiFetch } from './api'

const box = { background: '#1e222d', border: '1px solid #2a2e39', borderRadius: 6, padding: 16 }
const input = { background: '#131722', color: '#d1d4dc', border: '1px solid #2a2e39', borderRadius: 4, padding: '6px 10px', width: '100%' }
const label = { color: '#787b86', fontSize: 12, marginBottom: 4, display: 'block' }
const field = { marginBottom: 10 }
const smallBtn = { background: 'transparent', color: '#2962ff', border: '1px solid #2a2e39', borderRadius: 4, padding: '3px 8px', cursor: 'pointer', fontSize: 12 }
const smallDangerBtn = { ...smallBtn, color: '#ef5350' }

export default function Admin({ onActAsUser }) {
  const [users, setUsers] = useState([])
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [demoMode, setDemoMode] = useState(true)
  const [angelone, setAngelone] = useState({ api_key: '', user_id: '', password: '', totp: '' })
  const [includeIndiaStrategy, setIncludeIndiaStrategy] = useState(false)
  const [includeCrypto, setIncludeCrypto] = useState(false)
  const [cryptoDemoMode, setCryptoDemoMode] = useState(true)
  const [deltaex, setDeltaex] = useState({ api_key: '', api_secret: '' })
  const [includeTelegram, setIncludeTelegram] = useState(false)
  const [telegramToken, setTelegramToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState(null)

  const [managingUser, setManagingUser] = useState(null)
  const [managingCreds, setManagingCreds] = useState(null)
  const [managingCrypto, setManagingCrypto] = useState(null)
  const [enableStrategy, setEnableStrategy] = useState(false)
  const [enableTelegram, setEnableTelegram] = useState(false)
  const [newPassword, setNewPassword] = useState('')
  const [manageBusy, setManageBusy] = useState(false)
  const [manageMessage, setManageMessage] = useState('')
  const [cryptoBusy, setCryptoBusy] = useState(false)
  const [cryptoMessage, setCryptoMessage] = useState('')
  const [botBusy, setBotBusy] = useState(null)

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
    setEnableStrategy(false)
    setEnableTelegram(false)
    const res = await apiFetch(`/api/admin/users/${u.username}/credentials`)
    const data = await res.json()
    setManagingCreds(data.success ? data : { demo_mode: true, api_key: '', user_id: '', password: '', totp: '', bot_token: '', chatids: [] })
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
      setCryptoMessage(`Saved (port ${data.crypto_port}). Dashboard: ${data.crypto_dashboard_alive ? '🟢' : '🔴'}, strategy: ${data.crypto_strategy_alive ? '🟢' : '🔴'}, exit: ${data.crypto_exit_alive ? '🟢' : '🔴'}.`)
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
        body: JSON.stringify({
          angelone: managingCreds.demo_mode ? null : managingCreds,
          enable_strategy: enableStrategy,
          telegram: { bot_token: managingCreds.bot_token, chatids: managingCreds.chatids },
          enable_telegram: enableTelegram,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || 'failed to save')
      let msg = `Saved. Dashboard bot: ${data.webview_alive ? '🟢' : '🔴'}, AI bot: ${data.ai_alive ? '🟢' : '🔴'}.`
      if (data.storesupportzone_alive !== undefined) {
        msg += ` Auto-strategy: ${data.storesupportzone_alive ? '🟢' : '🔴'}, auto-exit: ${data.store_exit_alive ? '🟢' : '🔴'}.`
      }
      if (data.telegram_alive !== undefined) {
        msg += ` Telegram bot: ${data.telegram_alive ? '🟢' : '🔴'}.`
      }
      setManageMessage(msg)
      loadUsers()
    } catch (err) {
      setManageMessage(`Error: ${err.message}`)
    }
    setManageBusy(false)
  }

  async function controlBot(username, bot, action) {
    const key = `${bot}:${action}`
    setBotBusy(key)
    setManageMessage('')
    try {
      const res = await apiFetch(`/api/admin/users/${username}/bots/${bot}/${action}`, { method: 'POST' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || `failed to ${action} ${bot}`)
      setManageMessage(`${bot}: ${action === 'stop' ? 'stopped' : 'restarted'} — ${data.alive ? '🟢 running' : '🔴 not running'}.`)
      loadUsers()
    } catch (err) {
      setManageMessage(`Error: ${err.message}`)
    }
    setBotBusy(null)
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
          include_india_strategy: includeIndiaStrategy,
          include_crypto: includeCrypto,
          deltaex: includeCrypto && !cryptoDemoMode ? deltaex : null,
          telegram: includeTelegram && telegramToken ? { bot_token: telegramToken, chatids: [] } : null,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || 'failed to create user')
      setResult(data)
      setUsername('')
      setPassword('')
      setAngelone({ api_key: '', user_id: '', password: '', totp: '' })
      setIncludeIndiaStrategy(false)
      setIncludeCrypto(false)
      setCryptoDemoMode(true)
      setDeltaex({ api_key: '', api_secret: '' })
      setIncludeTelegram(false)
      setTelegramToken('')
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
            <input type="checkbox" id="includeIndiaStrategy" checked={includeIndiaStrategy} onChange={(e) => setIncludeIndiaStrategy(e.target.checked)} />
            <label htmlFor="includeIndiaStrategy" style={{ color: '#d1d4dc', fontSize: 13 }}>
              Also enable auto-strategy trading (india) — always-on, places/exits orders on its own
            </label>
          </div>

          <div style={{ ...field, display: 'flex', alignItems: 'center', gap: 8 }}>
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

          <div style={{ ...field, display: 'flex', alignItems: 'center', gap: 8, marginTop: 14, paddingTop: 10, borderTop: '1px solid #2a2e39' }}>
            <input type="checkbox" id="includeTelegram" checked={includeTelegram} onChange={(e) => setIncludeTelegram(e.target.checked)} />
            <label htmlFor="includeTelegram" style={{ color: '#d1d4dc', fontSize: 13 }}>Also set up a Telegram bot for them</label>
          </div>
          {includeTelegram && (
            <div style={field}>
              <label style={label}>Telegram bot token (from @BotFather)</label>
              <input style={input} value={telegramToken} onChange={(e) => setTelegramToken(e.target.value)} required />
              <span style={{ color: '#787b86', fontSize: 11 }}>
                They message their bot with /start once it's running — it replies with their chat ID for you to paste into Manage → Telegram afterward.
              </span>
            </div>
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
            {result.storesupportzone_alive !== undefined && (
              <> Auto-strategy: {result.storesupportzone_alive ? '🟢' : '🔴'}, auto-exit: {result.store_exit_alive ? '🟢' : '🔴'}.</>
            )}
            {result.crypto_port != null && (
              <> Crypto (port {result.crypto_port}): dashboard {result.crypto_dashboard_alive ? '🟢' : '🔴'}, strategy {result.crypto_strategy_alive ? '🟢' : '🔴'}, exit {result.crypto_exit_alive ? '🟢' : '🔴'}.</>
            )}
            {result.telegram_alive !== undefined && (
              <> Telegram bot: {result.telegram_alive ? '🟢 running — have them message it with /start to get their chat ID' : '🔴 failed to start'}.</>
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
              <th style={{ padding: '4px 8px' }}>Auto-strategy</th>
              <th style={{ padding: '4px 8px' }}>Crypto</th>
              <th style={{ padding: '4px 8px' }}>Telegram</th>
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
                    {u.webview_alive ? '🟢' : '🔴'} dashboard{u.errors?.webview && ' ⚠️'}&nbsp;&nbsp;{u.ai_alive ? '🟢' : '🔴'} AI{u.errors?.ai && ' ⚠️'}
                  </td>
                  <td style={{ padding: '6px 8px', color: '#787b86' }}>
                    {u.storesupportzone_alive ? '🟢' : '🔴'} strat{u.errors?.storesupportzone && ' ⚠️'}&nbsp;&nbsp;{u.store_exit_alive ? '🟢' : '🔴'} exit{u.errors?.store_exit && ' ⚠️'}
                  </td>
                  <td style={{ padding: '6px 8px', color: '#787b86' }}>
                    {u.crypto_port == null ? '—' : <>{u.crypto_dashboard_alive ? '🟢' : '🔴'} dash{u.errors?.crypto_webview && ' ⚠️'}&nbsp;&nbsp;{u.crypto_strategy_alive ? '🟢' : '🔴'} strat{u.errors?.crypto_strategy && ' ⚠️'}&nbsp;&nbsp;{u.crypto_exit_alive ? '🟢' : '🔴'} exit{u.errors?.crypto_exit && ' ⚠️'}</>}
                  </td>
                  <td style={{ padding: '6px 8px', color: '#787b86' }}>
                    {u.telegram_alive ? '🟢' : '🔴'}{u.errors?.telegram && ' ⚠️'}
                  </td>
                  <td style={{ padding: '6px 8px', color: '#787b86' }}>{u.is_admin ? 'yes' : ''}</td>
                  <td style={{ padding: '6px 8px', display: 'flex', gap: 6 }}>
                    <button
                      onClick={() => openManage(u)}
                      style={{ background: 'transparent', color: '#2962ff', border: '1px solid #2a2e39', borderRadius: 4, padding: '3px 8px', cursor: 'pointer', fontSize: 12 }}
                    >
                      {managingUser === u.username ? 'Close' : 'Manage'}
                    </button>
                    <button
                      onClick={() => onActAsUser(u.username)}
                      title="View and trade on this user's dashboard as if logged in as them"
                      style={{ background: 'transparent', color: '#ffb74d', border: '1px solid #2a2e39', borderRadius: 4, padding: '3px 8px', cursor: 'pointer', fontSize: 12 }}
                    >
                      Act as
                    </button>
                  </td>
                </tr>
                {managingUser === u.username && managingCreds && (
                  <tr>
                    <td colSpan={8} style={{ padding: '10px 8px', background: '#131722' }}>
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
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                        <input
                          type="checkbox" id={`strategy-${u.username}`} checked={enableStrategy}
                          onChange={(e) => setEnableStrategy(e.target.checked)}
                        />
                        <label htmlFor={`strategy-${u.username}`} style={{ color: '#d1d4dc', fontSize: 13 }}>
                          Enable auto-strategy trading (india) on save — currently {u.storesupportzone_alive ? '🟢' : '🔴'} strategy, {u.store_exit_alive ? '🟢' : '🔴'} exit
                        </label>
                      </div>
                      <div style={{ display: 'flex', gap: 6, marginBottom: 10, flexWrap: 'wrap' }}>
                        <button disabled={!!botBusy} onClick={() => controlBot(u.username, 'storesupportzone', 'restart')} style={smallBtn}>
                          {botBusy === 'storesupportzone:restart' ? 'Restarting…' : 'Restart auto-strategy'}
                        </button>
                        <button disabled={!!botBusy} onClick={() => controlBot(u.username, 'storesupportzone', 'stop')} style={smallDangerBtn}>
                          {botBusy === 'storesupportzone:stop' ? 'Stopping…' : 'Stop auto-strategy'}
                        </button>
                        <button disabled={!!botBusy} onClick={() => controlBot(u.username, 'store_exit', 'restart')} style={smallBtn}>
                          {botBusy === 'store_exit:restart' ? 'Restarting…' : 'Restart auto-exit'}
                        </button>
                        <button disabled={!!botBusy} onClick={() => controlBot(u.username, 'store_exit', 'stop')} style={smallDangerBtn}>
                          {botBusy === 'store_exit:stop' ? 'Stopping…' : 'Stop auto-exit'}
                        </button>
                      </div>
                      {managingCrypto?.provisioned && (
                        <div style={{ display: 'flex', gap: 6, marginBottom: 10, flexWrap: 'wrap' }}>
                          <button disabled={!!botBusy} onClick={() => controlBot(u.username, 'crypto_strategy', 'restart')} style={smallBtn}>
                            {botBusy === 'crypto_strategy:restart' ? 'Restarting…' : 'Restart crypto strategy'}
                          </button>
                          <button disabled={!!botBusy} onClick={() => controlBot(u.username, 'crypto_strategy', 'stop')} style={smallDangerBtn}>
                            {botBusy === 'crypto_strategy:stop' ? 'Stopping…' : 'Stop crypto strategy'}
                          </button>
                          <button disabled={!!botBusy} onClick={() => controlBot(u.username, 'crypto_exit', 'restart')} style={smallBtn}>
                            {botBusy === 'crypto_exit:restart' ? 'Restarting…' : 'Restart crypto exit'}
                          </button>
                          <button disabled={!!botBusy} onClick={() => controlBot(u.username, 'crypto_exit', 'stop')} style={smallDangerBtn}>
                            {botBusy === 'crypto_exit:stop' ? 'Stopping…' : 'Stop crypto exit'}
                          </button>
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
                            {managingCrypto.provisioned && (
                              <> — currently {u.crypto_strategy_alive ? '🟢' : '🔴'} strategy, {u.crypto_exit_alive ? '🟢' : '🔴'} exit</>
                            )}
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

                      <div style={{ marginTop: 14, paddingTop: 10, borderTop: '1px solid #2a2e39' }}>
                        <div style={{ color: '#d1d4dc', fontSize: 13, marginBottom: 8 }}>
                          Telegram {u.telegram_alive ? '🟢' : '🔴'}
                        </div>
                        <div style={field}>
                          <label style={label}>Bot token (from @BotFather)</label>
                          <input
                            style={input} value={managingCreds.bot_token || ''}
                            onChange={(e) => setManagingCreds({ ...managingCreds, bot_token: e.target.value })}
                          />
                        </div>
                        <div style={field}>
                          <label style={label}>Chat ID (they get this by messaging the bot with /start)</label>
                          <input
                            style={input} value={(managingCreds.chatids || [])[0] || ''}
                            onChange={(e) => setManagingCreds({ ...managingCreds, chatids: e.target.value ? [e.target.value] : [] })}
                            placeholder={managingCreds.bot_token ? 'not linked yet' : ''}
                          />
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                          <input
                            type="checkbox" id={`telegram-${u.username}`} checked={enableTelegram}
                            onChange={(e) => setEnableTelegram(e.target.checked)}
                          />
                          <label htmlFor={`telegram-${u.username}`} style={{ color: '#d1d4dc', fontSize: 13 }}>
                            (Re)start Telegram bot on save
                          </label>
                        </div>
                      </div>

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
