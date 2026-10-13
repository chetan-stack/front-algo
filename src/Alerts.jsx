import { useEffect, useState } from 'react'
import { apiFetch } from './api'
import { fmtPnl } from './pnl'
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

// scope="all" (admin only, backend-enforced): every alert, every user, plus the analyst
// Start/Stop/Restart controls. scope="self" (any logged-in user): only MY alerts — my own
// order alerts, and market alerts (trending/near-move/etc) for symbols I actually trade.
// The backend does the filtering (/api/admin/alerts vs /api/alerts); this component just
// picks which one and whether to show admin controls.
// Alerts are written by analyst.py and kept 7 days, so this is also the history to look back at.
// Order alerts (ORDER_*) carry the order's symbol and owner: "View chart" opens that
// position's chart (App.openOrderChart: an admin is switched to the owner's account so
// the chart's Exit acts on their order); "Exit" closes it right here, for the alert's
// user (apiFetch asUser: no account switch). A closed position answers "no open
// position", shown on the row.
export default function Alerts({ onSeen, scope = 'all', me = '', onViewOrder }) {
  const [items, setItems] = useState([])
  const [positions, setPositions] = useState({})  // "market|user|symbol" -> its order record (live P&L)
  const [rowMsg, setRowMsg] = useState({})  // alert key -> result text of View / Exit (the list reloads every 30s)
  const [market, setMarket] = useState('all')
  const [err, setErr] = useState('')

  async function load() {
    try {
      const res = await apiFetch(`${scope === 'all' ? '/api/admin/alerts' : '/api/alerts'}?limit=500`)
      const data = await res.json()
      const list = data.items || []
      setItems(list)
      setErr('')
      if (list.length) onSeen(list[0].ts)
      loadPositions(list)
    } catch (e) {
      setErr(e.message)
    }
  }

  // Current P&L for today's order alerts: each account's order records (the same
  // pending-orders list the chart uses) carry the live P&L the exit bot writes every
  // few seconds while a position is open, and the final P&L once closed. One request
  // per account and market that has an order alert today, on the existing 30s refresh.
  async function loadPositions(list) {
    const today = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Kolkata' }).slice(0, 10)
    const owners = [...new Set(list.filter((a) => String(a.kind).startsWith('ORDER_') && a.ts.startsWith(today))
      .map((a) => `${a.market}|${scope === 'all' ? a.user || '' : ''}`))]
    const found = {}
    await Promise.all(owners.map(async (o) => {
      const [mk, user] = o.split('|')
      try {
        const res = await apiFetch(`${mk === 'crypto' ? '/api/crypto/trading' : '/api/trading'}/pending-orders`,
          { asUser: scope === 'all' ? user : undefined })
        const d = await res.json()
        for (const ord of d.orders || []) found[`${mk}|${user}|${ord.symbol}`] = ord
      } catch { /* that account's dashboard is down: no P&L for its rows */ }
    }))
    setPositions(found)
  }

  useEffect(() => {
    load()
    const id = setInterval(load, 30000)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope])

  const shown = items.filter((a) => market === 'all' || a.market === market)
  const isOrder = (a) => String(a.kind).startsWith('ORDER_') && a.symbol
  const keyOf = (a) => `${a.ts}|${a.user}|${a.symbol}|${a.kind}`
  const say = (a, text) => setRowMsg((m) => ({ ...m, [keyOf(a)]: text }))

  async function view(a) {
    say(a, 'Opening chart…')
    try {
      await onViewOrder({ user: scope === 'all' ? a.user : '', market: a.market, symbol: a.symbol })
    } catch (e) {
      say(a, `Can't open chart: ${e.message}`)
    }
  }

  async function exitNow(a) {
    const owner = scope === 'all' && a.user && a.user !== me ? ` for ${a.user}` : ''
    if (!confirm(`Exit ${a.symbol}${owner} now?\n\nCloses the open position at the current price (paper or real money, following that account's "With money").`)) return
    say(a, 'Exiting…')
    try {
      const prefix = a.market === 'crypto' ? '/api/crypto/trading' : '/api/trading'
      const res = await apiFetch(`${prefix}/exit-order`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ symbol: a.symbol }),
        // admin: act on the alert's user for this one request; a user: their own account
        asUser: scope === 'all' ? (a.user || '') : undefined,
      })
      const d = await res.json()
      if (d.status === 'success') load()  // the row then shows the final P&L
      say(a, d.status === 'success' ? `Exited @ ${d.exitPrice ?? ''}${d.profit != null ? ` (P/L ${Number(d.profit).toFixed(2)})` : ''}` : `Not exited: ${d.message || d.detail || res.status}`)
    } catch (e) {
      say(a, `Not exited: ${e.message}`)
    }
  }
  // The order record behind an alert, if it's still the same position (a symbol keeps one
  // record: a newer position on it, entered after the alert, isn't this alert's).
  function positionOf(a) {
    const ord = positions[`${a.market}|${scope === 'all' ? a.user || '' : ''}|${a.symbol}`]
    if (!ord) return null
    if (ord.createdAt && String(ord.createdAt).slice(0, 19) > a.ts) return { gone: true }
    return ord
  }
  const pnlColor = (v) => (Number(v) > 0 ? '#26a69a' : Number(v) < 0 ? '#ef5350' : '#d1d4dc')
  const smallBtn = (color) => ({ background: 'transparent', color, border: `1px solid ${color}`, borderRadius: 4, padding: '2px 8px', cursor: 'pointer', fontSize: 12 })
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
        {scope === 'all' && (
          <span style={{ marginLeft: 'auto', display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-end' }}>
            <AnalystControl market="india" />
            <AnalystControl market="crypto" />
          </span>
        )}
        <span style={{ width: '100%', fontSize: 12, color: '#787b86' }}>
          {scope === 'all'
            ? 'Every user, every symbol'
            : 'Your account’s own order alerts, plus market alerts for symbols you trade'}
          &nbsp;— Market: trending · trend coming · near a move · big move &nbsp;|&nbsp; Orders: wrong order · exit needed · trail target — stored 7 days · refreshes every 30s
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
              {a.user && scope === 'all' && <span style={{ color: '#787b86' }}>({a.user})</span>}
              <span style={{ color: k.color, fontWeight: 600 }}>{k.label}</span>
              <span style={{ flex: 1, minWidth: 200 }}>{a.text}</span>
              {isOrder(a) && (
                <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  {(() => {
                    const p = positionOf(a)
                    if (!p) return null
                    if (p.gone) return <span style={{ fontSize: 12, color: '#787b86' }}>closed</span>
                    const open = String(p.orderterm).toLowerCase() === 'hold'
                    return (
                      <span style={{ fontSize: 12, fontWeight: 600, color: pnlColor(p.profit) }} title={open ? 'Live P&L, updated by the exit bot every few seconds (refreshes here every 30s)' : 'Final P&L'}>
                        {open ? 'P&L now ' : 'Closed, P&L '}{a.market === 'crypto' ? '' : '₹'}{fmtPnl(p.profit, a.market, a.symbol)}
                      </span>
                    )
                  })()}
                  <button onClick={() => view(a)} style={smallBtn('#2962ff')}
                    title={scope === 'all' && a.user && a.user !== me ? `Switches to ${a.user}'s account and opens the position's chart (Exit, target/stoploss, P&L there)` : "Opens the position's chart (Exit, target/stoploss, P&L there)"}>
                    View chart
                  </button>
                  <button onClick={() => exitNow(a)} style={smallBtn('#ef5350')}>Exit</button>
                  {rowMsg[keyOf(a)] && <span style={{ fontSize: 12, color: '#787b86' }}>{rowMsg[keyOf(a)]}</span>}
                </span>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
