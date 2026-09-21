import { useEffect, useState } from 'react'
import { apiFetch } from './api'
import AnalystControl from './AnalystControl'

const KIND = {
  TRENDING: { label: 'Trending', color: '#26a69a' },
  TREND_COMING: { label: 'Trend coming', color: '#4fc3f7' },
  NEAR_MOVE: { label: 'Near a move', color: '#ffb74d' },
  BIG_MOVE: { label: 'Big move', color: '#ef5350' },
  ORDER_WRONG: { label: 'Wrong order', color: '#ef5350' },
  ORDER_EXIT: { label: 'Exit needed', color: '#ff7043' },
  ORDER_TRAIL: { label: 'Trail target', color: '#26a69a' },
}

// Admin-only: the backend route enforces it, this tab is just hidden from everyone else.
// Alerts are written by analyst.py and kept 7 days, so this is also the history to look back at.
export default function Alerts({ onSeen }) {
  const [items, setItems] = useState([])
  const [market, setMarket] = useState('all')
  const [err, setErr] = useState('')

  async function load() {
    try {
      const res = await apiFetch('/api/admin/alerts?limit=500')
      const data = await res.json()
      const list = data.items || []
      setItems(list)
      setErr('')
      if (list.length) onSeen(list[0].ts)
    } catch (e) {
      setErr(e.message)
    }
  }

  useEffect(() => {
    load()
    const id = setInterval(load, 30000)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const shown = items.filter((a) => market === 'all' || a.market === market)
  const btn = (id, label) => (
    <button
      key={id}
      onClick={() => setMarket(id)}
      style={{
        background: market === id ? '#2962ff' : 'transparent', color: market === id ? '#fff' : '#d1d4dc',
        border: '1px solid #2a2e39', borderRadius: 4, padding: '5px 10px', cursor: 'pointer', fontSize: 13,
      }}
    >
      {label}
    </button>
  )

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', color: '#d1d4dc' }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: 12, borderBottom: '1px solid #2a2e39', flexWrap: 'wrap' }}>
        {btn('all', 'All')}{btn('india', 'India')}{btn('crypto', 'Crypto')}
        <span style={{ marginLeft: 'auto', display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-end' }}>
          <AnalystControl market="india" />
          <AnalystControl market="crypto" />
        </span>
        <span style={{ width: '100%', fontSize: 12, color: '#787b86' }}>
          Market: trending · trend coming · near a move · big move &nbsp;|&nbsp; Orders: wrong order · exit needed · trail target — stored 7 days · refreshes every 30s
        </span>
      </div>
      <div style={{ flex: 1, overflow: 'auto', background: '#0c0e15', padding: 12, fontSize: 13 }}>
        {err && <div style={{ color: '#ef5350' }}>Error: {err}</div>}
        {!err && shown.length === 0 && <div style={{ color: '#787b86' }}>No alerts yet.</div>}
        {shown.map((a, i) => {
          const k = KIND[a.kind] || { label: a.kind, color: '#d1d4dc' }
          return (
            <div key={i} style={{ display: 'flex', gap: 10, padding: '8px 0', borderBottom: '1px solid #1a1d26', flexWrap: 'wrap' }}>
              <span style={{ color: '#787b86', fontFamily: 'monospace', whiteSpace: 'nowrap' }}>{a.ts}</span>
              <span style={{ background: a.market === 'crypto' ? '#4a3a00' : '#0d2a4d', borderRadius: 3, padding: '0 6px', fontSize: 11, alignSelf: 'center' }}>
                {a.market === 'crypto' ? 'CRYPTO' : 'INDIA'}
              </span>
              <strong>{a.symbol}</strong>
              <span style={{ color: k.color, fontWeight: 600 }}>{k.label}</span>
              <span style={{ flex: 1, minWidth: 200 }}>{a.text}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
