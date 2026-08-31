import { useState } from 'react'
import Chart from './Chart'
import TradingPanel from './TradingPanel'
import Login from './Login'
import Admin from './Admin'
import AdminLogs from './AdminLogs'
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
]

export default function App() {
  const [token, setToken] = useState(() => localStorage.getItem('token'))
  const [isAdmin, setIsAdmin] = useState(() => localStorage.getItem('isAdmin') === 'true')
  const [actingAs, setActingAs] = useState(() => localStorage.getItem('actingAs') || '')
  const [count, setCount] = useState(1)
  const [view, setView] = useState('charts')
  const [jump, setJump] = useState(null)
  const { cols, rows } = LAYOUTS[count]
  const market = view.startsWith('crypto') ? 'crypto' : 'india'
  const isTrading = view === 'trading' || view === 'crypto-trading'
  const tabs = isAdmin ? [...TABS, { id: 'admin', label: 'Admin' }, { id: 'logs', label: 'Logs' }, { id: 'all-notifications', label: 'All Notifications' }] : TABS

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

  const isChartsView = view === 'charts' || view === 'crypto-charts'

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
        {isChartsView && Object.keys(LAYOUTS).map((n) => (
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
      {view === 'admin' ? (
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}><Admin onActAsUser={actAsUser} /></div>
      ) : view === 'logs' ? (
        <div style={{ flex: 1, minHeight: 0 }}><AdminLogs /></div>
      ) : view === 'all-notifications' ? (
        <div style={{ flex: 1, minHeight: 0 }}><Notifications scope="all" /></div>
      ) : view === 'notifications' ? (
        <div style={{ flex: 1, minHeight: 0 }}><Notifications scope="self" /></div>
      ) : view === 'orderbook' ? (
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}><OrderBook /></div>
      ) : view === 'failed-orders' ? (
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}><FailedOrders /></div>
      ) : isTrading ? (
        <div style={{ flex: 1, minHeight: 0 }}><TradingPanel market={market} onViewOnChart={viewOnChart} /></div>
      ) : (
        <div style={{
          flex: 1, display: 'grid',
          gridTemplateColumns: `repeat(${cols}, 1fr)`,
          gridTemplateRows: `repeat(${rows}, 1fr)`,
          gap: 2,
        }}>
          {Array.from({ length: count }, (_, i) => (
            <Chart
              key={`${market}-${i}`}
              market={market}
              defaultSymbol={market === 'crypto' ? 'BINANCE:BTCUSDT' : 'NSE:NIFTY'}
              defaultLabel={market === 'crypto' ? 'BINANCE:BTCUSDT' : 'NSE:NIFTY'}
              jump={i === 0 ? jump : null}
              onJumpConsumed={i === 0 ? () => setJump(null) : undefined}
            />
          ))}
        </div>
      )}
    </div>
  )
}
