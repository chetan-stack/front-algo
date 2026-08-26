import { useEffect, useState } from 'react'
import { apiFetch } from './api'

const LOG_BOTS = [
  { key: 'webview', label: 'Dashboard' },
  { key: 'ai', label: 'AI orders' },
  { key: 'storesupportzone', label: 'Auto-strategy' },
  { key: 'store_exit', label: 'Auto-exit' },
  { key: 'crypto_webview', label: 'Crypto dashboard', crypto: true },
  { key: 'crypto_strategy', label: 'Crypto strategy', crypto: true },
]
const ERROR_RE = /traceback|error(?!code)|exception|critical/i

const panel = { background: '#1e222d', border: '1px solid #2a2e39', borderRadius: 6 }

export default function AdminLogs() {
  const [users, setUsers] = useState([])
  const [selectedUser, setSelectedUser] = useState(null)
  const [selectedBot, setSelectedBot] = useState(null)
  const [lines, setLines] = useState([])
  const [path, setPath] = useState(null)
  const [busy, setBusy] = useState(false)
  const [autoRefresh, setAutoRefresh] = useState(false)

  async function loadUsers() {
    const res = await apiFetch('/api/admin/users')
    const data = await res.json()
    if (data.success) {
      setUsers(data.users)
      if (!selectedUser && data.users.length > 0) selectUser(data.users[0].username)
    }
  }

  useEffect(() => { loadUsers() }, [])

  function selectUser(username) {
    setSelectedUser(username)
    setSelectedBot(null)
    setLines([])
    setPath(null)
  }

  async function loadLog(bot) {
    if (!selectedUser) return
    setSelectedBot(bot)
    setBusy(true)
    try {
      const res = await apiFetch(`/api/admin/users/${selectedUser}/logs/${bot}`)
      const data = await res.json()
      setLines(data.lines || [])
      setPath(data.path)
    } catch (err) {
      setLines([`Error loading log: ${err.message}`])
      setPath(null)
    }
    setBusy(false)
  }

  useEffect(() => {
    if (!autoRefresh || !selectedUser || !selectedBot) return
    const id = setInterval(() => { loadLog(selectedBot); loadUsers() }, 5000)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRefresh, selectedUser, selectedBot])

  const currentUser = users.find((u) => u.username === selectedUser)

  return (
    <div style={{ height: '100%', display: 'flex', color: '#d1d4dc' }}>
      {/* Users sidebar */}
      <div style={{ width: 220, borderRight: '1px solid #2a2e39', overflowY: 'auto', flexShrink: 0 }}>
        <div style={{ padding: '10px 12px', fontSize: 13, color: '#787b86', borderBottom: '1px solid #2a2e39' }}>
          Users
        </div>
        {users.map((u) => {
          const hasError = Object.values(u.errors || {}).some(Boolean)
          return (
            <div
              key={u.username}
              onClick={() => selectUser(u.username)}
              style={{
                padding: '10px 12px', cursor: 'pointer',
                background: selectedUser === u.username ? '#2a2e39' : 'transparent',
                borderBottom: '1px solid #1a1d26',
              }}
            >
              {u.username}{hasError ? ' ⚠️' : ''}
            </div>
          )
        })}
      </div>

      {/* Bot list + log viewer */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        {currentUser && (
          <>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', padding: 12, borderBottom: '1px solid #2a2e39' }}>
              {LOG_BOTS.filter((b) => !b.crypto || currentUser.crypto_port != null).map((b) => (
                <button
                  key={b.key}
                  onClick={() => loadLog(b.key)}
                  style={{
                    background: selectedBot === b.key ? '#2962ff' : 'transparent',
                    color: selectedBot === b.key ? '#fff' : '#d1d4dc',
                    border: '1px solid #2a2e39', borderRadius: 4, padding: '5px 10px', cursor: 'pointer', fontSize: 13,
                  }}
                >
                  {b.label}{currentUser.errors?.[b.key] ? ' ⚠️' : ''}
                </button>
              ))}
              <label style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#787b86' }}>
                <input type="checkbox" checked={autoRefresh} onChange={(e) => setAutoRefresh(e.target.checked)} />
                Auto-refresh (5s)
              </label>
              <button
                onClick={() => selectedBot && loadLog(selectedBot)}
                disabled={!selectedBot || busy}
                style={{ background: 'transparent', color: '#2962ff', border: '1px solid #2a2e39', borderRadius: 4, padding: '5px 10px', cursor: 'pointer', fontSize: 13 }}
              >
                {busy ? 'Loading…' : 'Refresh'}
              </button>
            </div>

            <div style={{ padding: '6px 12px', fontSize: 12, color: '#787b86', borderBottom: '1px solid #2a2e39' }}>
              {selectedBot ? (path || 'No log file found yet for this bot') : 'Select a bot above to view its log'}
            </div>

            <pre style={{
              flex: 1, margin: 0, padding: 12, overflow: 'auto',
              background: '#0c0e15', fontSize: 12, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-all',
            }}>
              {selectedBot && lines.length === 0 && !busy ? '(empty)' : lines.map((line, i) => (
                <div key={i} style={{ color: ERROR_RE.test(line) ? '#ef5350' : '#d1d4dc' }}>{line}</div>
              ))}
            </pre>
          </>
        )}
      </div>
    </div>
  )
}
