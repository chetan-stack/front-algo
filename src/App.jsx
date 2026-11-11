import { useEffect, useState } from 'react'
import { apiFetch } from './api'
import { chartTarget } from './chartTarget'
import Alerts from './Alerts'
import Chart from './Chart'
import TradingPanel from './TradingPanel'
import Login from './Login'
import Admin from './Admin'
import AiChatTab from './AiChatTab'
import AdminLogs from './AdminLogs'
import Analysis from './Analysis'
import MarketAnalysis from './MarketAnalysis'
import Notifications from './Notifications'
import OrderBook from './OrderBook'
import FailedOrders from './FailedOrders'
import BrokerAccount from './BrokerAccount'

const LAYOUTS = {
  1: { cols: 1, rows: 1 },
  2: { cols: 2, rows: 1 },
  4: { cols: 2, rows: 2 },
}

// One glyph per tab so the bar can be scanned at a glance (plain unicode, no icon library).
const TAB_ICONS = {
  charts: '📈', trading: '🤖', 'crypto-charts': '🪙', 'crypto-trading': '⚡', orderbook: '📒', 'failed-orders': '⛔',
  notifications: '🔔', alerts: '🚨', 'market-analysis': '🧭', 'ai-chat': '💬', broker: '🏦', admin: '🛡️', logs: '📜',
  'all-notifications': '📣', analysis: '🇮🇳', 'crypto-analysis': '📊',
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
  { id: 'market-analysis', label: 'Market Analysis' },
  { id: 'ai-chat', label: 'AI Chat' },
  { id: 'broker', label: 'Broker Account' },
]

export default function App() {
  const [token, setToken] = useState(() => localStorage.getItem('token'))
  const [isAdmin, setIsAdmin] = useState(() => localStorage.getItem('isAdmin') === 'true')
  const [actingAs, setActingAs] = useState(() => localStorage.getItem('actingAs') || '')
  const [me, setMe] = useState('')  // own username, so the Alerts tab knows when "act as" is needed
  useEffect(() => {
    if (!token) return
    apiFetch('/api/auth/me', { asUser: '' }).then((r) => r.json()).then((d) => setMe(d.username || '')).catch(() => {})
  }, [token])
  const [count, setCount] = useState(1)
  // One view per screen: any tab can go in any screen (charts beside the
  // order book, notifications, etc). The top tab bar drives screen 1.
  const [panes, setPanes] = useState(['charts', 'charts', 'charts', 'charts'])
  const view = panes[0]
  const setView = (v) => setPanes((p) => [v, ...p.slice(1)])
  const setPaneView = (i, v) => setPanes((p) => p.map((x, j) => (j === i ? v : x)))
  // Per screen, per market: the chart's symbol/label/interval/live, reported by
  // each Chart and saved with presets. layoutVersion remounts charts on preset
  // open so they start from the saved state.
  const [paneCharts, setPaneCharts] = useState([{}, {}, {}, {}])
  const [layoutVersion, setLayoutVersion] = useState(0)
  const setPaneChart = (i, market, st) => setPaneCharts((p) => p.map((x, j) => (j === i ? { ...x, [market]: st } : x)))
  // Saved screen layouts ("custom tabs"): screen count + which tab each
  // screen shows. Per browser (localStorage), so localhost and the live site
  // keep separate lists. ponytail: move to the backend if presets must follow
  // the user across devices.
  const [presets, setPresets] = useState(() => {
    try { return JSON.parse(localStorage.getItem('screenPresets') || '[]') } catch { return [] }
  })
  useEffect(() => {
    try { localStorage.setItem('screenPresets', JSON.stringify(presets)) } catch { /* storage blocked */ }
  }, [presets])
  const activePreset = presets.find((pr) => pr.count === count && pr.panes.every((v, i) => panes[i] === v))

  function savePreset() {
    const name = window.prompt('Name this screen layout', activePreset?.name || '')?.trim()
    if (!name) return
    setPresets((all) => [...all.filter((pr) => pr.name !== name), { name, count, panes: panes.slice(0, count), charts: paneCharts.slice(0, count) }])
  }

  // The screens as they were before a saved layout was opened, for "Close layout".
  const [beforePreset, setBeforePreset] = useState(null)

  function openPreset(pr) {
    if (!activePreset) setBeforePreset({ count, panes, charts: paneCharts })  // switching layouts keeps the first "before"
    setCount(pr.count)
    setPanes((p) => [...pr.panes, ...p.slice(pr.panes.length)])
    if (pr.charts) setPaneCharts((p) => [...pr.charts, ...p.slice(pr.charts.length)])
    setLayoutVersion((n) => n + 1)
  }

  // Back to the screens from before the layout was opened, or one chart screen.
  function closePreset() {
    const back = beforePreset || { count: 1, panes: ['charts', ...panes.slice(1)], charts: paneCharts }
    setCount(back.count)
    setPanes(back.panes)
    setPaneCharts(back.charts)
    setLayoutVersion((n) => n + 1)
    setBeforePreset(null)
  }

  function deletePreset(name) {
    if (window.confirm(`Delete layout "${name}"?`)) setPresets((all) => all.filter((pr) => pr.name !== name))
  }
  const [jump, setJump] = useState(null)
  const [unseenAlerts, setUnseenAlerts] = useState(0)
  // Header dropdowns (Orders / Reports / Admin / Layouts / user): one open at a time;
  // a click outside or Escape closes it.
  const [menu, setMenu] = useState(null)
  useEffect(() => {
    if (!menu) return
    const close = (e) => { if (e.type === 'keydown' ? e.key === 'Escape' : !e.target.closest('.menu-wrap')) setMenu(null) }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', close)
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', close) }
  }, [menu])
  const { cols, rows } = LAYOUTS[count]
  // Every user gets an Alerts tab, but non-admins get their OWN alerts only (backend-filtered:
  // their own order alerts, plus market alerts for symbols they trade) — never another user's.
  const tabs = (isAdmin ? [
    ...TABS.filter((t) => t.id !== 'alerts'),
    { id: 'admin', label: 'Admin' }, { id: 'logs', label: 'Logs' }, { id: 'all-notifications', label: 'All Notifications' },
    { id: 'alerts', label: 'Alerts' },
    { id: 'analysis', label: 'India Report' }, { id: 'crypto-analysis', label: 'Crypto Report' },
  ] : TABS).map((t) => (t.id === 'alerts' && unseenAlerts > 0 ? { ...t, badge: unseenAlerts > 99 ? '99+' : unseenAlerts } : t))

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
    setView(req.market === 'crypto' || view === 'crypto-trading' ? 'crypto-charts' : 'charts')
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

  // Alerts tab -> the position's chart (its pending-order box has Exit, target/stoploss
  // and live P&L). An admin opening another user's order switches to that account first
  // (the same "act as" as Admin → Act as), so the chart's Exit works on THEIR order;
  // opening their own order stops acting as anyone.
  async function openOrderChart({ user, market, symbol }) {
    if (isAdmin && user) {
      if (user === me) stopActingAs()
      else { localStorage.setItem('actingAs', user); setActingAs(user) }
    }
    const target = await chartTarget(symbol, market)  // throws a readable error for the caller
    setJump(target)
    setView(market === 'crypto' ? 'crypto-charts' : 'charts')
  }

  function renderView(v, i) {
    const market = v.startsWith('crypto') ? 'crypto' : 'india'
    if (v === 'admin') return <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}><Admin onActAsUser={actAsUser} /></div>
    if (v === 'logs') return <div style={{ flex: 1, minHeight: 0 }}><AdminLogs /></div>
    if (v === 'alerts') return <div style={{ flex: 1, minHeight: 0 }}><Alerts onSeen={alertsSeen} scope={isAdmin ? 'all' : 'self'} me={me} onViewOrder={openOrderChart} /></div>
    if ((v === 'analysis' || v === 'crypto-analysis') && isAdmin) return <div style={{ flex: 1, minHeight: 0 }}><Analysis key={v} market={v === 'crypto-analysis' ? 'crypto' : 'india'} /></div>
    if (v === 'market-analysis') return <div style={{ flex: 1, minHeight: 0 }}><MarketAnalysis isAdmin={isAdmin} onViewOnChart={viewOnChart} /></div>
    if (v === 'all-notifications') return <div style={{ flex: 1, minHeight: 0 }}><Notifications scope="all" /></div>
    if (v === 'notifications') return <div style={{ flex: 1, minHeight: 0 }}><Notifications scope="self" /></div>
    if (v === 'ai-chat') {
      const ctx = paneCharts.flatMap((pc) => Object.values(pc || {})).filter((c) => c?.symbol).map((c) => `${c.symbol} ${c.interval}`)
      return <div style={{ flex: 1, minHeight: 0 }}><AiChatTab chartContext={[...new Set(ctx)].join(', ')} onViewOnChart={viewOnChart} /></div>
    }
    if (v === 'orderbook') return <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}><OrderBook /></div>
    if (v === 'broker') return <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}><BrokerAccount /></div>
    if (v === 'failed-orders') return <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}><FailedOrders /></div>
    if (v === 'trading' || v === 'crypto-trading') return <div style={{ flex: 1, minHeight: 0 }}><TradingPanel key={market} market={market} onViewOnChart={viewOnChart} /></div>
    return (
      <div style={{ flex: 1, minHeight: 0 }}><Chart
        key={`${market}-${i}-${layoutVersion}`}
        market={market}
        defaultSymbol={market === 'crypto' ? 'BINANCE:BTCUSDT' : 'NSE:NIFTY'}
        defaultLabel={market === 'crypto' ? 'BINANCE:BTCUSDT' : 'NSE:NIFTY'}
        jump={i === 0 ? jump : null}
        onJumpConsumed={i === 0 ? () => setJump(null) : undefined}
        initial={paneCharts[i]?.[market]}
        onStateChange={(st) => setPaneChart(i, market, st)}
      /></div>
    )
  }

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: '#131722' }}>
      <div className="tab-bar">
        <span className="brand" title="TradeSmart AI"><span className="brand-mark">◆</span><span className="brand-text">TradeSmart</span><b>AI</b></span>
        {(() => {
          const byId = Object.fromEntries(tabs.map((t) => [t.id, t]))
          const go = (id) => { setView(id); setMenu(null) }
          const tabBtn = (id) => byId[id] && (
            <button key={id} onClick={() => go(id)} className={`tab-btn${view === id ? ' active' : ''}`} title={byId[id].label}>
              <span className="tab-ico" aria-hidden="true">{TAB_ICONS[id]}</span>{byId[id].label}
            </button>)
          // A group of tabs behind one button; the button lights up when one of its tabs is open.
          const group = (key, icon, label, ids) => {
            const items = ids.filter((id) => byId[id])
            if (!items.length) return null
            const current = items.find((id) => id === view)
            return (
              <span key={key} className="menu-wrap">
                <button onClick={() => setMenu(menu === key ? null : key)} className={`tab-btn${current ? ' active' : ''}`} aria-haspopup="menu" aria-expanded={menu === key}>
                  <span className="tab-ico" aria-hidden="true">{current ? TAB_ICONS[current] : icon}</span>{current ? byId[current].label : label}<span className="caret">▾</span>
                </button>
                {menu === key && (
                  <div className="menu" role="menu">
                    {items.map((id) => (
                      <button key={id} role="menuitem" onClick={() => go(id)} className={`menu-item${view === id ? ' on' : ''}`}>
                        <span className="tab-ico" aria-hidden="true">{TAB_ICONS[id]}</span>{byId[id].label}
                        {byId[id].badge ? <span className="tab-badge" style={{ marginLeft: 'auto' }}>{byId[id].badge}</span> : null}
                      </button>))}
                  </div>)}
              </span>)
          }
          return <>
            <nav className="tab-group" aria-label="Main">
              {['charts', 'trading', 'crypto-charts', 'crypto-trading', 'market-analysis', 'ai-chat'].map(tabBtn)}
              {group('orders', '📒', 'Orders', ['orderbook', 'failed-orders', 'notifications', 'alerts'])}
              {group('reports', '📊', 'Reports', ['analysis', 'crypto-analysis'])}
              {group('admin', '🛡️', 'Admin', ['admin', 'logs', 'all-notifications'])}
            </nav>
            <span className="tab-right">
            <button onClick={() => go('alerts')} className={`icon-btn${view === 'alerts' ? ' active' : ''}`} title={unseenAlerts ? `${unseenAlerts} new alerts` : 'Alerts'} aria-label="Alerts">
              🔔{unseenAlerts > 0 && <span className="dot-badge">{unseenAlerts > 99 ? '99+' : unseenAlerts}</span>}
            </button>
            <span className="seg" role="radiogroup" aria-label="Screens">
              {Object.keys(LAYOUTS).map((n) => (
                <button key={n} role="radio" aria-checked={count === Number(n)} onClick={() => setCount(Number(n))}
                  className={count === Number(n) ? 'on' : ''} title={`${n} screen${n === '1' ? '' : 's'}`}>
                  {n === '1' ? '▢' : n === '2' ? '◫' : '⊞'}
                </button>))}
            </span>
            <span className="menu-wrap">
              <button onClick={() => setMenu(menu === 'layouts' ? null : 'layouts')} className={`tab-btn${activePreset ? ' active' : ''}`} aria-haspopup="menu" aria-expanded={menu === 'layouts'}>
                <span className="tab-ico" aria-hidden="true">★</span>{activePreset ? activePreset.name : 'Layouts'}<span className="caret">▾</span>
              </button>
              {menu === 'layouts' && (
                <div className="menu" role="menu" style={{ right: 0, left: 'auto' }}>
                  {presets.length === 0 && <div className="menu-note">No saved layouts yet. Arrange your screens, then save them here.</div>}
                  {presets.map((pr) => (
                    <div key={pr.name} className={`menu-item${activePreset?.name === pr.name ? ' on' : ''}`} style={{ padding: 0 }}>
                      <button role="menuitem" onClick={() => { openPreset(pr); setMenu(null) }} title={`${pr.count} screen${pr.count === 1 ? '' : 's'}: ${pr.panes.join(', ')}`}
                        style={{ flex: 1, background: 'transparent', border: 0, color: 'inherit', textAlign: 'left', padding: '7px 10px', cursor: 'pointer', font: 'inherit' }}>
                        ★ {pr.name} <span style={{ color: '#787b86', fontSize: 11 }}>· {pr.count} screen{pr.count === 1 ? '' : 's'}</span>
                      </button>
                      <button aria-label={`Delete layout ${pr.name}`} title="Delete layout" onClick={() => deletePreset(pr.name)}
                        style={{ background: 'transparent', border: 0, color: '#787b86', cursor: 'pointer', padding: '7px 10px' }}>✕</button>
                    </div>))}
                  <div className="menu-sep" />
                  <button role="menuitem" className="menu-item" onClick={() => { savePreset(); setMenu(null) }}>＋ Save current screens…</button>
                  {activePreset && <button role="menuitem" className="menu-item" style={{ color: '#ef5350' }} onClick={() => { closePreset(); setMenu(null) }}>✕ Close “{activePreset.name}”</button>}
                </div>)}
            </span>
            <span className="menu-wrap">
              <button onClick={() => setMenu(menu === 'user' ? null : 'user')} className="user-btn" aria-haspopup="menu" aria-expanded={menu === 'user'} title={me || 'Account'}>
                <span className="avatar">{(me || '?')[0].toUpperCase()}</span><span className="caret">▾</span>
              </button>
              {menu === 'user' && (
                <div className="menu" role="menu" style={{ right: 0, left: 'auto' }}>
                  <div className="menu-note"><b style={{ color: '#fff' }}>{me || 'Signed in'}</b>{isAdmin ? ' · admin' : ''}{actingAs ? <div style={{ color: '#ffb74d' }}>acting as {actingAs}</div> : null}</div>
                  <div className="menu-sep" />
                  {byId.broker && <button role="menuitem" className={`menu-item${view === 'broker' ? ' on' : ''}`} onClick={() => go('broker')}><span className="tab-ico">{TAB_ICONS.broker}</span>Broker account</button>}
                  {actingAs && <button role="menuitem" className="menu-item" onClick={() => { stopActingAs(); setMenu(null) }}>↩ Return to my account</button>}
                  <button role="menuitem" className="menu-item" style={{ color: '#ef5350' }} onClick={logout}>⎋ Log out</button>
                </div>)}
            </span>
            </span>
          </>
        })()}
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
