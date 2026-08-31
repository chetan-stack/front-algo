import { useEffect, useState } from 'react'
import { apiFetch } from './api'

const BOT_LABELS = {
  webview: 'Dashboard', ai: 'AI orders', storesupportzone: 'Auto-strategy', store_exit: 'Auto-exit',
  telegram: 'Telegram', crypto_webview: 'Crypto dashboard', crypto_strategy: 'Crypto strategy', crypto_exit: 'Crypto exit',
}

function loadCache(cacheKey) {
  try {
    return JSON.parse(localStorage.getItem(cacheKey)) || []
  } catch {
    return []
  }
}

// scope: 'self' (endpoint /api/notifications, every user sees only their own
// account — or, if an admin is "acting as" someone, that user's) or 'all'
// (admin-only /api/admin/notifications across every user, with a user filter).
export default function Notifications({ scope = 'self' }) {
  const endpoint = scope === 'all' ? '/api/admin/notifications' : '/api/notifications'
  const cacheKey = `notifications_cache_${scope}`
  const [items, setItems] = useState(() => loadCache(cacheKey))
  const [busy, setBusy] = useState(false)
  const [autoRefresh, setAutoRefresh] = useState(true)
  const [userFilter, setUserFilter] = useState('all')
  const [categoryFilter, setCategoryFilter] = useState('all')

  async function load() {
    setBusy(true)
    try {
      const res = await apiFetch(endpoint)
      const data = await res.json()
      if (data.success) {
        setItems(data.items)
        localStorage.setItem(cacheKey, JSON.stringify(data.items))
      }
    } catch {
      // keep showing the cached/last-known list on a failed fetch
    }
    setBusy(false)
  }

  useEffect(() => { load() }, [])

  useEffect(() => {
    if (!autoRefresh) return
    const id = setInterval(load, 8000)
    return () => clearInterval(id)
  }, [autoRefresh])

  const usernames = [...new Set(items.map((it) => it.username))].sort()
  const filtered = items.filter((it) =>
    (userFilter === 'all' || it.username === userFilter) &&
    (categoryFilter === 'all' || it.category === categoryFilter)
  )

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', color: '#d1d4dc' }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: 12, borderBottom: '1px solid #2a2e39' }}>
        {scope === 'all' && (
          <select
            value={userFilter} onChange={(e) => setUserFilter(e.target.value)}
            style={{ background: '#131722', color: '#d1d4dc', border: '1px solid #2a2e39', borderRadius: 4, padding: '5px 8px' }}
          >
            <option value="all">All users</option>
            {usernames.map((u) => <option key={u} value={u}>{u}</option>)}
          </select>
        )}
        <select
          value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)}
          style={{ background: '#131722', color: '#d1d4dc', border: '1px solid #2a2e39', borderRadius: 4, padding: '5px 8px' }}
        >
          <option value="all">All categories</option>
          <option value="error">Errors only</option>
          <option value="order">Order status only</option>
        </select>
        <label style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#787b86' }}>
          <input type="checkbox" checked={autoRefresh} onChange={(e) => setAutoRefresh(e.target.checked)} />
          Auto-refresh (8s)
        </label>
        <button
          onClick={load} disabled={busy}
          style={{ background: 'transparent', color: '#2962ff', border: '1px solid #2a2e39', borderRadius: 4, padding: '5px 10px', cursor: 'pointer', fontSize: 13 }}
        >
          {busy ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      <div style={{ flex: 1, overflow: 'auto', padding: 12 }}>
        {filtered.length === 0 ? (
          <div style={{ color: '#787b86', fontSize: 13 }}>{busy ? 'Loading…' : 'No notifications'}</div>
        ) : (
          filtered.map((it, i) => (
            <div
              key={i}
              style={{
                display: 'flex', gap: 10, padding: '8px 10px', marginBottom: 4, borderRadius: 4,
                background: '#1e222d', borderLeft: `3px solid ${it.category === 'error' ? '#ef5350' : '#2962ff'}`,
                fontSize: 13,
              }}
            >
              <span style={{ color: '#787b86', flexShrink: 0, whiteSpace: 'nowrap' }}>{it.timestamp || '—'}</span>
              <span style={{ color: '#ffb74d', flexShrink: 0, whiteSpace: 'nowrap' }}>
                {scope === 'all' ? `${it.username} / ${BOT_LABELS[it.bot] || it.bot}` : (BOT_LABELS[it.bot] || it.bot)}
              </span>
              <span style={{ wordBreak: 'break-word', color: it.category === 'error' ? '#ef5350' : '#d1d4dc' }}>{it.line}</span>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
