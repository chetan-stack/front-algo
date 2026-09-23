import { useEffect, useState } from 'react'
import { apiFetch } from './api'
import Alerts from './Alerts'
import Chart from './Chart'
import TradingPanel from './TradingPanel'
import Login from './Login'
import Admin from './Admin'
import AdminLogs from './AdminLogs'
import Analysis from './Analysis'
import Notifications from './Notifications'
import OrderBook from './OrderBook'
import FailedOrders from './FailedOrders'

const LAYOUTS = {
  1: { cols: 1, rows: 1 },
  2: { cols: 2, rows: 1 },
  4: { cols: 2, rows: 2 },
}

const TABS = [
  { id: 'charts', label: 'Charts' },
  { id: 'trading', label: 'Trading' },
  { id: 'crypto-charts', label: 'Crypto Charts' },
  { id: 'crypto-trading', label: 'Crypto Trading' },
  { id: 'orderbook', label: 'Order Book' },
  { id: 'failed-orders', label: 'Failed Orders' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'alerts', label: 'Alerts' },
]

export default function App() {
  const [token, setToken] = useState(() => localStorage.getItem('token'))
  const [isAdmin, setIsAdmin] = useState(() => localStorage.getItem('isAdmin') === 'true')
  const [actingAs, setActingAs] = useState(() => localStorage.getItem('actingAs') || '')
  const [count, setCount] = useState(1)
  // One view per screen: any tab can go in any screen (charts beside the
  // order book, notifications, etc). The top tab bar drives screen 1.
  const [panes, setPanes] = useState(['charts', 'charts', 'charts', 'charts'])
  const view = panes[0]
  const setView = (v) => setPanes((p) => [v, ...p.slice(1)])
  const setPaneView = (i, v) => setPanes((p) => p.map((x, j) => (j === i ? v : x)))
  const [jump, setJump] = useState(null)
  const [unseenAlerts, setUnseenAlerts] = useState(0)
  const { cols, rows } = LAYOUTS[count]
  // Every user gets an Alerts tab, but non-admins get their OWN alerts only (backend-filtered:
  // their own order alerts, plus market alerts for symbols they trade) — never another user's.
  const tabs = (isAdmin ? [
    ...TABS.filter((t) => t.id !== 'alerts'),
    { id: 'admin', label: 'Admin' }, { id: 'logs', label: 'Logs' }, { id: 'all-notifications', label: 'All Notifications' },
    { id: 'alerts', label: 'Alerts' },
    { id: 'analysis', label: 'India Report' }, { id: 'crypto-analysis', label: 'Crypto Report' },
  ] : TABS).map((t) => (t.id === 'alerts' && unseenAlerts > 0 ? { ...t, label: `Alerts (${unseenAlerts})` } : t))

  // Alert badge for everyone: count alerts (mine, or all if admin) newer than the last time
  // the Alerts tab was opened. Timestamps are "YYYY-MM-DD HH:MM:SS" IST, so string-comparable.
  useEffect(() => {
    if (!token) return
    async function poll() {
      try {
        const res = await apiFetch(`${isAdmin ? '/api/admin/alerts' : '/api/alerts'}?limit=200`)
        const data = await res.json()
        const seen = localStorage.getItem('alertsSeen') || ''
        setUnseenAlerts((data.items || []).filter((a) => a.ts > seen).length)
      } catch { /* backend restarting — try again next tick */ }
    }
    poll()
    const id = setInterval(poll, 30000)
    return () => clearInterval(id)
  }, [token, isAdmin])

  function alertsSeen(latestTs) {
    localStorage.setItem('alertsSeen', latestTs)
    setUnseenAlerts(0)
  }

  function viewOnChart(req) {
    setJump(req)
    // Land on whichever charts tab matches where "View chart" was clicked
    // from — used to always go to the india charts view, even from the
    // crypto trading tab.
    setView(view === 'crypto-trading' ? 'crypto-charts' : 'charts')
  }

  if (!token) {
    return <Login onLogin={(t, admin) => {
      localStorage.setItem('token', t)
      localStorage.setItem('isAdmin', admin ? 'true' : 'false')
      setToken(t)
      setIsAdmin(!!admin)
    }} />
  }

  function logout() {
    localStorage.removeItem('token')
    localStorage.removeItem('isAdmin')
    localStorage.removeItem('actingAs')
    setToken(null)
  }

  function actAsUser(username) {
    localStorage.setItem('actingAs', username)
    setActingAs(username)
    setView('trading')
  }

  function stopActingAs() {
    localStorage.removeItem('actingAs')
    setActingAs('')
  }

  function renderView(v, i) {
    const market = v.startsWith('crypto') ? 'crypto' : 'india'
    if (v === 'admin') return <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}><Admin onActAsUser={actAsUser} /></div>
    if (v === 'logs') return <div style={{ flex: 1, minHeight: 0 }}><AdminLogs /></div>
    if (v === 'alerts') return <div style={{ flex: 1, minHeight: 0 }}><Alerts onSeen={alertsSeen} scope={isAdmin ? 'all' : 'self'} /></div>
    if ((v === 'analysis' || v === 'crypto-analysis') && isAdmin) return <div style={{ flex: 1, minHeight: 0 }}><Analysis key={v} market={v === 'crypto-analysis' ? 'crypto' : 'india'} /></div>
    if (v === 'all-notifications') return <div style={{ flex: 1, minHeight: 0 }}><Notifications scope="all" /></div>
    if (v === 'notifications') return <div style={{ flex: 1, minHeight: 0 }}><Notifications scope="self" /></div>
    if (v === 'orderbook') return <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}><OrderBook /></div>
    if (v === 'failed-orders') return <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}><FailedOrders /></div>
    if (v === 'trading' || v === 'crypto-trading') return <div style={{ flex: 1, minHeight: 0 }}><TradingPanel market={market} onViewOnChart={viewOnChart} /></div>
    return (
      <div style={{ flex: 1, minHeight: 0 }}><Chart
        key={`${market}-${i}`}
        market={market}
        defaultSymbol={market === 'crypto' ? 'BINANCE:BTCUSDT' : 'NSE:NIFTY'}
        defaultLabel={market === 'crypto' ? 'BINANCE:BTCUSDT' : 'NSE:NIFTY'}
        jump={i === 0 ? jump : null}
        onJumpConsumed={i === 0 ? () => setJump(null) : undefined}
      /></div>
    )
  }

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: '#131722' }}>
      <div className="tab-bar">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setView(t.id)}
            className={`tab-btn${view === t.id ? ' active' : ''}`}
          >
            {t.label}
          </button>
        ))}
        {Object.keys(LAYOUTS).map((n) => (
          <button
            key={n}
            onClick={() => setCount(Number(n))}
            className={`tab-btn${count === Number(n) ? ' active' : ''}`}
          >
            {n} screen{n === '1' ? '' : 's'}
          </button>
        ))}
        <button onClick={logout} className="tab-btn tab-bar-spacer" style={{ color: '#787b86' }}>
          Log out
        </button>
      </div>
      {actingAs && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10, padding: '6px 12px',
          background: '#5b3a00', color: '#ffcc80', fontSize: 13,
        }}>
          <span>⚠️ Acting as <strong>{actingAs}</strong> — trades and dashboard actions affect their account, not yours.</span>
          <button
            onClick={stopActingAs}
            style={{ background: 'transparent', color: '#ffcc80', border: '1px solid #ffcc80', borderRadius: 4, padding: '2px 8px', cursor: 'pointer', fontSize: 12 }}
          >
            Return to my account
          </button>
        </div>
      )}
      <div style={{
        flex: 1, minHeight: 0, display: 'grid',
        gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
        gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`,
        gap: 2,
      }}>
        {panes.slice(0, count).map((v, i) => (
          <div key={i} style={{ minHeight: 0, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden', border: count > 1 ? '1px solid #2a2e39' : 'none' }}>
            {count > 1 && (
              <select
                value={v} onChange={(e) => setPaneView(i, e.target.value)} aria-label={`Screen ${i + 1} tab`}
                style={{ background: '#1e222d', color: '#d1d4dc', border: 'none', borderBottom: '1px solid #2a2e39', padding: '3px 6px', fontSize: 12 }}
              >
                {tabs.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
              </select>
            )}
            {renderView(v, i)}
          </div>
        ))}
      </div>
    </div>
  )
}
