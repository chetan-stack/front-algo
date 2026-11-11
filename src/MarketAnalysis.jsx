import { useEffect, useState } from 'react'
import { apiFetch } from './api'

// Market Analysis (every user): market_scan.py's 5-min snapshot of every market plus
// Claude's plan. Loads once + manual Refresh only (no auto-refresh, keeps RAM down).
const C = { up: '#26a69a', down: '#ef5350', warn: '#ffb74d', info: '#4fc3f7', dim: '#787b86', text: '#d1d4dc', line: '#2a2e39', card: '#1e222d' }
const BIAS = { BULLISH: C.up, BEARISH: C.down, SIDEWAYS: C.warn, AVOID: C.dim }
const IMPACT = { HIGH: C.down, MEDIUM: C.warn, LOW: C.dim }
const INDEX_CHART = { NIFTY: 'NSE:NIFTY', BANKNIFTY: 'NSE:BANKNIFTY', SENSEX: 'BSE:SENSEX' }
const CRYPTO_CHART = { BTC: 'BINANCE:BTCUSDT', ETH: 'BINANCE:ETHUSDT', XAUT: 'DELTA:XAUTUSD' }

const pct = (v) => (v == null ? '' : <span style={{ color: v >= 0 ? C.up : C.down }}>{v >= 0 ? '+' : ''}{v.toFixed(2)}%</span>)
const num = (v) => (v == null ? '—' : Number(v).toLocaleString('en-IN', { maximumFractionDigits: 2 }))
const card = { background: C.card, border: `1px solid ${C.line}`, borderRadius: 6, padding: 12 }
const btn = { background: 'transparent', color: '#2962ff', border: `1px solid ${C.line}`, borderRadius: 4, padding: '4px 10px', cursor: 'pointer', fontSize: 12 }
const td = { padding: '5px 8px', borderBottom: `1px solid ${C.line}`, verticalAlign: 'top' }

const MKT_LABEL = { INDIA_STOCK: 'Stock (intraday)', INDIA_OPTION: 'Index option', CRYPTO: 'Crypto' }
const STRIKE_RE = /(\d{4,6})\s*(CE|PE)\b/i
// Which existing order route a plan row maps to (same routes as AI Chat's and the chart's order buttons;
// each follows that account's "With money": real order when on, paper when off). null = can't be ordered here.
function orderOf(t) {
  if (t.market === 'CRYPTO') return CRYPTO_CHART[t.symbol] ? { mkt: 'crypto', path: '/api/crypto/trading/enter-order', body: { coin: t.symbol, direction: t.side === 'BUY' ? 'long' : 'short' } } : null
  if (t.market === 'INDIA_OPTION') {
    const m = STRIKE_RE.exec(t.instrument || '')
    const right = t.side === 'BUY' ? 'CE' : 'PE'
    return m && m[2].toUpperCase() === right && INDEX_CHART[t.symbol] ? { mkt: 'india', path: '/api/trading/ai-enter-option-order', body: { underlying: t.symbol, strike: m[1], right } } : null
  }
  return null  // intraday stocks: the bots have no equity order route
}
// Exact cost of the order the Place-order button sends, from the margin calculator (live broker
// prices + the account's own lots / leverage), and the ₹ loss at stoploss / profit at target.
function liveOf(t, margin) {
  const o = orderOf(t)
  if (!o) return null
  if (o.mkt === 'india') {
    const m = margin.india?.indices?.[t.symbol]
    if (!m) return null
    if (m.error) return { note: m.error }
    const leg = m.atm?.[o.body.right === 'CE' ? 'ce' : 'pe']
    if (!leg) return null
    const cost = leg.margin
    return { cost, loss: cost * t.option_sl_pct / 100, profit: cost * t.option_target_pct / 100,
      note: `${leg.symbol}: ${leg.premium} × ${leg.qty}${String(leg.strike) !== o.body.strike ? ` (priced at ATM ${leg.strike}, plan says ${o.body.strike})` : ''}` }
  }
  const d = margin.crypto
  const c = d?.coins?.[t.symbol]
  if (!d) return null
  if (!c) return { note: `${t.symbol} is off in your crypto settings` }
  if (c.error) return { note: c.error }
  const rate = d.usd_inr || 88
  if (d.instrument === 'futures') {
    const coins = c.min * d.leverage / c.price  // qty × contract size
    return { cost: c.min * rate, loss: coins * Math.abs(t.entry - t.stoploss) * rate, profit: coins * Math.abs(t.target - t.entry) * rate,
      note: `${c.qty} contracts · ${d.leverage}x · margin $${c.min}` }
  }
  const leg = c.legs?.[t.side === 'BUY' ? 0 : 1]
  return leg ? { cost: leg.margin * rate, note: `${leg.symbol}: premium ${leg.premium} × ${leg.qty} (option P&L depends on the premium move)` } : null
}
const inr = (v) => (v == null ? '—' : `₹${Math.round(v).toLocaleString('en-IN')}`)

// "AI investment planner": the user's amount + market + risk -> AI trades built from the latest scan.
// Quantities and ₹ max loss / profit are computed by the backend (ai_chat.invest_numbers), not by the AI.
function InvestPlanner({ view }) {
  const [amount, setAmount] = useState('100000')
  const [market, setMarket] = useState('ANY')
  const [risk, setRisk] = useState('MEDIUM')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const [err, setErr] = useState('')
  const [plan, setPlan] = useState(null)
  const [quota, setQuota] = useState(null)
  const [money, setMoney] = useState({})  // { india: withmoney, crypto: withmoney } of the logged-in account
  const [orderMsg, setOrderMsg] = useState({})
  const [margin, setMargin] = useState({})  // { india, crypto } margin-estimate responses
  const [history, setHistory] = useState([])  // today's saved plans (server, newest first)

  useEffect(() => {
    apiFetch('/api/ai/invest-plan').then((r) => r.json()).then((d) => {
      setHistory(d.plans || [])
      if (d.plans?.length) setPlan((p) => p || d.plans[0])
    }).catch(() => {})
  }, [])
  const choose = (p) => { setPlan(p); setOrderMsg({}); setMargin({}) }
  const [marginBusy, setMarginBusy] = useState(false)

  async function checkMargin() {
    setMarginBusy(true)
    const need = new Set(plan.trades.map((t) => orderOf(t)?.mkt).filter(Boolean))
    const next = {}
    for (const [mkt, path] of [['india', '/api/trading/margin-estimate'], ['crypto', '/api/crypto/trading/margin-estimate']]) {
      if (!need.has(mkt)) continue
      try {
        const d = await (await apiFetch(path)).json()
        next[mkt] = d.status === 'success' ? d : { error: d.message || d.detail || 'margin check failed' }
      } catch { next[mkt] = { error: 'could not reach the margin calculator' } }
    }
    setMargin(next); setMarginBusy(false)
  }

  useEffect(() => {
    if (!plan?.trades?.length) return
    const need = new Set(plan.trades.map((t) => orderOf(t)?.mkt).filter(Boolean))
    for (const [mkt, path] of [['india', '/api/trading/dashboard'], ['crypto', '/api/crypto/trading/dashboard']]) {
      if (!need.has(mkt)) continue
      apiFetch(path).then((r) => r.json()).then((d) => setMoney((m) => ({ ...m, [mkt]: !!d.form_data?.withmoney }))).catch(() => {})
    }
  }, [plan])

  async function placeOrder(i, t, o) {
    const live = money[o.mkt]
    const what = o.mkt === 'crypto'
      ? `${t.side === 'BUY' ? 'LONG' : 'SHORT'} ${t.symbol} (futures or ATM option, per your crypto "Trade in" setting)`
      : `BUY ${o.body.underlying} ${o.body.strike} ${o.body.right}`
    const mode = live === undefined ? 'Real money if "With money" is on, otherwise paper' : live ? '💰 REAL MONEY ("With money" is on)' : '📝 Paper trade ("With money" is off)'
    if (!window.confirm(`Place ${what} at market now?\n\n${mode}\n\nQuantity / lots and the auto-exit target & stoploss come from your Trading settings, not from this plan.`)) return
    setOrderMsg((m) => ({ ...m, [i]: 'Placing…' }))
    try {
      const d = await (await apiFetch(o.path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o.body) })).json()
      const tag = d.mode ? (d.mode === 'live' ? '💰 live' : '📝 paper') : live ? '💰 live' : live === false ? '📝 paper' : ''
      setOrderMsg((m) => ({ ...m, [i]: d.status === 'success' ? `✓ ${tag} order placed: ${d.symbol} x${Math.abs(d.qty ?? d.lotsize)} @ ${d.price ?? d.ltp}` : `✗ ${d.message || d.detail || 'order failed'}` }))
    } catch {
      setOrderMsg((m) => ({ ...m, [i]: '✗ could not reach the order server' }))
    }
  }
  const chip = (on, col = '#2962ff') => ({ background: on ? `${col}26` : 'transparent', color: on ? '#fff' : C.text, border: `1px solid ${on ? col : C.line}`, borderRadius: 16, padding: '5px 12px', cursor: 'pointer', fontSize: 12, fontWeight: on ? 700 : 400 })
  const input = { background: '#131722', color: C.text, border: `1px solid ${C.line}`, borderRadius: 4, padding: '6px 8px', fontSize: 13 }

  async function build(e) {
    e.preventDefault()
    setBusy(true); setErr(''); setPlan(null); setOrderMsg({}); setMargin({}); setStatus('Sending…')
    try {
      const res = await apiFetch('/api/ai/invest-plan', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: Number(amount), market, risk }),
      })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || `HTTP ${res.status}`)
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const lines = buf.split('\n')
        buf = lines.pop()
        for (const ln of lines.filter(Boolean)) {
          const { t, v } = JSON.parse(ln)
          if (t === 'status') setStatus(v)
          else if (t === 'plan') { setPlan(v); setHistory((h) => [v, ...h]) }
          else if (t === 'quota') setQuota(v)
          else if (t === 'error') setErr(v)
        }
      }
    } catch (e) { setErr(e.message || 'Could not reach the AI server.') }
    setBusy(false); setStatus('')
  }

  const chartOf = (t) => (t.market === 'CRYPTO' ? CRYPTO_CHART[t.symbol] : t.market === 'INDIA_OPTION' ? INDEX_CHART[t.symbol] : `NSE:${t.symbol}`)
  return (
    <div style={card}>
      <form onSubmit={build} style={{ display: 'grid', gap: 12 }}>
        <div>
          <div style={{ color: C.dim, fontSize: 11, marginBottom: 5 }}>HOW MUCH DO YOU WANT TO INVEST?</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            <span style={{ position: 'relative' }}>
              <span style={{ position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)', color: C.dim, fontWeight: 700 }}>₹</span>
              <input style={{ ...input, width: 140, paddingLeft: 22, fontSize: 15, fontWeight: 700 }} type="number" min="1000" step="1000" required value={amount} onChange={(e) => setAmount(e.target.value)} aria-label="Investment in rupees" />
            </span>
            {[10000, 25000, 50000, 100000, 500000].map((v) => (
              <button type="button" key={v} onClick={() => setAmount(String(v))} style={chip(Number(amount) === v)}>{v >= 100000 ? `${v / 100000}L` : `${v / 1000}k`}</button>))}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          <div>
            <div style={{ color: C.dim, fontSize: 11, marginBottom: 5 }}>MARKET</div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }} role="radiogroup" aria-label="Market">
              {[['ANY', '✨ AI picks'], ['INDIA_STOCKS', '🏢 Stocks'], ['INDIA_OPTIONS', '🎯 Index options'], ['CRYPTO', '🪙 Crypto']].map(([v, l]) => (
                <button type="button" role="radio" aria-checked={market === v} key={v} onClick={() => setMarket(v)} style={chip(market === v)}>{l}</button>))}
            </div>
          </div>
          <div>
            <div style={{ color: C.dim, fontSize: 11, marginBottom: 5 }}>RISK (MAX TOTAL LOSS)</div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }} role="radiogroup" aria-label="Risk">
              {[['LOW', '🛡️ Low · 1%', C.up], ['MEDIUM', '⚖️ Medium · 2%', C.warn], ['HIGH', '🔥 High · 3%', C.down]].map(([v, l, col]) => (
                <button type="button" role="radio" aria-checked={risk === v} key={v} onClick={() => setRisk(v)} style={chip(risk === v, col)}>{l}</button>))}
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <button type="submit" disabled={busy} style={{ border: 0, borderRadius: 8, padding: '10px 18px', fontSize: 14, fontWeight: 700, color: '#fff', cursor: busy ? 'wait' : 'pointer', background: 'linear-gradient(135deg, #2962ff, #7c4dff)', boxShadow: '0 4px 14px rgba(41,98,255,.35)' }}>
            {busy ? '⏳ AI is building…' : '✨ Build my plan with AI'}
          </button>
          <span style={{ color: C.dim, fontSize: 12 }}>
            {amount && Number(amount) >= 1000 ? <>You risk at most <b style={{ color: C.text }}>{inr(Number(amount) * { LOW: 0.01, MEDIUM: 0.02, HIGH: 0.03 }[risk])}</b> · </> : null}
            about 1–2 min · 1 AI question{quota?.left != null ? ` (${quota.left} left today)` : ''}
          </span>
        </div>
      </form>
      {history.length > 0 && <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginTop: 10, fontSize: 12 }}>
        <span style={{ color: C.dim }}>Today's saved plans:</span>
        {history.map((p, i) => (
          <button key={i} onClick={() => choose(p)} style={{ ...btn, color: p === plan ? '#fff' : C.text, background: p === plan ? '#2962ff' : 'transparent' }}>
            {p.built_at || '—'} · {inr(p.amount)} · {p.market === 'ANY' ? 'any' : p.market.replace('INDIA_', '').toLowerCase()} · {p.risk.toLowerCase()}
          </button>))}
      </div>}
      {status && <div style={{ color: C.info, marginTop: 10, display: 'flex', alignItems: 'center', gap: 8 }}><span className="pulse-dot" style={{ width: 8, height: 8, borderRadius: 4, background: C.info }} />{status}</div>}
      {err && <div style={{ color: C.down, marginTop: 8 }}>{err}</div>}
      {plan && <div style={{ marginTop: 14 }} className="fade-up">
        <div style={{ background: '#131722', border: `1px solid ${C.line}`, borderLeft: '3px solid #7c4dff', borderRadius: 6, padding: '8px 12px', lineHeight: 1.55 }}>🧠 {plan.summary}</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 8, margin: '10px 0' }}>
          {[['Invested', inr(plan.used)], ['Cash reserve', inr(plan.reserve)], ['Max loss (all SL hit)', inr(plan.max_loss), C.down],
            ['Max profit (all targets)', inr(plan.max_profit), C.up], ['Expected value', inr(plan.expected), plan.expected >= 0 ? C.up : C.down]].map(([k, v, col]) => (
            <div key={k} style={{ background: '#131722', border: `1px solid ${C.line}`, borderRadius: 6, padding: '6px 8px' }}>
              <div style={{ color: C.dim, fontSize: 10, textTransform: 'uppercase' }}>{k}</div><div style={{ color: col || C.text, fontWeight: 700 }}>{v}</div>
            </div>))}
        </div>
        {plan.amount > 0 && <div style={{ marginBottom: 12 }}>
          <div style={{ display: 'flex', height: 14, borderRadius: 7, overflow: 'hidden', background: C.line }}>
            {plan.trades.map((t, i) => <span key={i} title={`${t.instrument || t.symbol}: ${inr(t.capital)}`} style={{ width: `${(t.capital / plan.amount) * 100}%`, background: ['#2962ff', '#7c4dff', '#26a69a', '#ffb74d'][i % 4], borderRight: '2px solid #1e222d' }} />)}
          </div>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: 11, color: C.dim, marginTop: 5 }}>
            {plan.trades.map((t, i) => <span key={i}><span style={{ color: ['#2962ff', '#7c4dff', '#26a69a', '#ffb74d'][i % 4] }}>●</span> {t.symbol} {Math.round((t.capital / plan.amount) * 100)}%</span>)}
            <span>● cash {Math.round((plan.reserve / plan.amount) * 100)}%</span>
          </div>
        </div>}
        {plan.trades.some((t) => orderOf(t)) && (() => {
          const rows = plan.trades.map((t) => liveOf(t, margin)).filter((x) => x?.cost != null)
          const sum = (k) => rows.reduce((a, r) => a + (r[k] ?? 0), 0)
          const errs = Object.entries(margin).filter(([, d]) => d.error).map(([k, d]) => `${k}: ${d.error}`)
          return <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
            <button style={btn} onClick={checkMargin} disabled={marginBusy} title="Prices each order with live broker prices and your own lots / leverage">
              {marginBusy ? 'Checking…' : rows.length ? '⟳ Re-check live margin' : 'Check live margin'}
            </button>
            {rows.length > 0 && <span>With your Trading settings: <b>{inr(sum('cost'))}</b> needed · loss at SL <b style={{ color: C.down }}>{inr(sum('loss'))}</b> · profit at target <b style={{ color: C.up }}>{inr(sum('profit'))}</b>
              <span style={{ color: C.dim }}> (orderable rows only{margin.india?.at || margin.crypto?.at ? `, prices at ${margin.india?.at || margin.crypto?.at}` : ''})</span></span>}
            {errs.length > 0 && <span style={{ color: C.down }}>{errs.join(' · ')}</span>}
          </div>
        })()}
        {plan.trades.length === 0 && <div style={{ textAlign: 'center', padding: '18px 10px', border: `1px dashed ${C.line}`, borderRadius: 8 }}>
          <div style={{ fontSize: 28 }}>🧘</div>
          <div style={{ color: C.warn, fontWeight: 700, marginTop: 4 }}>No trade with an edge right now — keeping your cash is the plan.</div>
          <div style={{ color: C.dim, fontSize: 12, marginTop: 4 }}>Try again when the market moves, or pick another market above.</div>
        </div>}
        {plan.trades.length > 0 && <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead><tr style={{ color: C.dim, textAlign: 'left' }}>{['Trade', 'Strategy', 'Capital', 'Qty', 'Entry', 'Stoploss', 'Target', 'Win chance', 'Max loss', 'Max profit'].map((x) => <th key={x} style={td}>{x}</th>)}</tr></thead>
            <tbody>{plan.trades.map((t, i) => {
              const trade = { entry: t.entry, stoploss: t.stoploss, target: t.target, direction: t.side === 'BUY' ? 'long' : 'short' }
              const opt = t.market === 'INDIA_OPTION'
              const live = liveOf(t, margin)
              return (
                <tr key={i}>
                  <td style={{ ...td, minWidth: 210 }}><b style={{ color: t.side === 'BUY' ? C.up : C.down }}>{t.side}</b> <b>{t.instrument || t.symbol}</b><div style={{ color: C.dim }}>{MKT_LABEL[t.market]}</div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6, alignItems: 'center' }}>
                    <button style={btn} onClick={() => view(chartOf(t), t.market === 'CRYPTO' ? 'crypto' : 'india', trade)}>View strategy</button>
                    {(() => {
                      const o = orderOf(t)
                      if (!o) return <div style={{ color: C.dim, fontSize: 11, marginTop: 4 }}>{t.market === 'INDIA_STOCK' ? 'stock orders not supported' : 'no exact contract to order'}</div>
                      const live = money[o.mkt]
                      return <button style={{ ...btn, color: '#fff', background: live ? C.down : '#2962ff', borderColor: live ? C.down : '#2962ff' }}
                        disabled={orderMsg[i] === 'Placing…'} onClick={() => placeOrder(i, t, o)}
                        title={live ? 'Places a REAL order ("With money" is on)' : 'Places a paper order ("With money" is off)'}>
                        {live ? '💰 Place real order' : live === false ? '📝 Place paper order' : 'Place order'}
                      </button>
                    })()}
                    {orderMsg[i] && <div style={{ flexBasis: '100%', fontSize: 11, color: orderMsg[i].startsWith('✓') ? C.up : orderMsg[i].startsWith('✗') ? C.down : C.info, whiteSpace: 'normal', maxWidth: 260 }}>{orderMsg[i]}</div>}
                    </div>
                  </td>
                  <td style={td} title={t.why}>{t.strategy}<div style={{ color: C.dim }}>{t.why}</div></td>
                  <td style={td}>{inr(t.capital)}{live && <div style={{ color: C.info }} title={live.note}>live {live.cost != null ? inr(live.cost) : '—'}<div style={{ color: C.dim, fontSize: 11, maxWidth: 220 }}>{live.note}</div></div>}</td>
                  <td style={td}>{opt ? <span style={{ color: C.dim }} title="Lots = capital ÷ (live premium × lot size)">by premium</span> : t.qty}</td>
                  <td style={td}>{num(t.entry)}</td>
                  <td style={{ ...td, color: C.down }}>{num(t.stoploss)}{opt ? <div style={{ color: C.dim }}>premium −{t.option_sl_pct}%</div> : null}</td>
                  <td style={{ ...td, color: C.up }}>{num(t.target)}{opt ? <div style={{ color: C.dim }}>premium +{t.option_target_pct}%</div> : null}</td>
                  <td style={td}>
                    <b>{t.win_probability}%</b>
                    <div style={{ width: 60, height: 5, borderRadius: 3, background: C.line, marginTop: 4 }}><div style={{ width: `${t.win_probability}%`, height: '100%', borderRadius: 3, background: t.win_probability >= 55 ? C.up : t.win_probability >= 40 ? C.warn : C.down }} /></div>
                  </td>
                  <td style={{ ...td, color: C.down }}>{inr(t.max_loss)}{live?.loss != null && <div style={{ color: C.info }}>live {inr(live.loss)}</div>}</td>
                  <td style={{ ...td, color: C.up }}>{inr(t.max_profit)}{live?.profit != null && <div style={{ color: C.info }}>live {inr(live.profit)}</div>}</td>
                </tr>)
            })}</tbody>
          </table>
        </div>}
        {plan.cash_reserve_reason && <div style={{ color: C.dim, marginTop: 6 }}>Reserve: {plan.cash_reserve_reason}</div>}
        {plan.avoid?.length > 0 && <div style={{ color: C.dim, marginTop: 4 }}>Avoid: {plan.avoid.join(' · ')}</div>}
        {plan.dropped?.length > 0 && <div style={{ color: C.warn, marginTop: 4 }}>Removed by safety check: {plan.dropped.join(' · ')}</div>}
        <div style={{ color: C.dim, fontSize: 11, marginTop: 6 }}>
          Built {plan.built_at ? `at ${plan.built_at} ` : ''}from market data at {plan.data_ts} — levels can be stale later in the day. Total loss is capped at {plan.risk_cap_pct}% of your amount. Win chance is the AI's estimate, not a guarantee — no strategy has a fixed profit.
          Prices for entry / stoploss / target are the underlying (index for options, USD for crypto). No leverage assumed. AI suggestions, not financial advice.
        </div>
      </div>}
    </div>
  )
}

// ---- small visual pieces -------------------------------------------------------------------
const pill = (color, text, extra = {}) => <span style={{ display: 'inline-block', padding: '1px 9px', borderRadius: 10, fontSize: 11, fontWeight: 700, color, border: `1px solid ${color}`, background: `${color}1a`, ...extra }}>{text}</span>
const SECTIONS = [['planner', '🎯', 'Planner'], ['plan', '🧠', 'AI plan'], ['strategies', '📚', 'Strategies'], ['indices', '🏛️', 'Indices'],
  ['movers', '🔥', 'Movers'], ['crypto', '🪙', 'Crypto'], ['forex', '💱', 'Forex'], ['news', '📰', 'News']]

function Section({ id, icon, title, sub, children, right }) {
  return (
    <section id={`ma-${id}`} style={{ scrollMarginTop: 104, marginTop: 22 }} className="fade-up">
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
        <span style={{ fontSize: 16 }}>{icon}</span>
        <b style={{ fontSize: 15, color: '#fff' }}>{title}</b>
        {sub && <span style={{ color: C.dim, fontSize: 12 }}>{sub}</span>}
        {right && <span style={{ marginLeft: 'auto' }}>{right}</span>}
      </div>
      {children}
    </section>
  )
}

// Day range: where the price sits between today's low and high, with support / resistance ticks.
function RangeBar({ low, high, price, support, resistance }) {
  if (![low, high, price].every((v) => typeof v === 'number') || high <= low) return null
  const at = (v) => `${Math.max(0, Math.min(100, ((v - low) / (high - low)) * 100))}%`
  return (
    <div style={{ margin: '10px 0 4px' }} title={`Day low ${num(low)} · high ${num(high)}`}>
      <div style={{ position: 'relative', height: 6, borderRadius: 3, background: `linear-gradient(90deg, ${C.down}66, ${C.warn}55, ${C.up}66)` }}>
        {typeof support === 'number' && support > low && support < high && <span title={`Support ${num(support)}`} style={{ position: 'absolute', left: at(support), top: -3, width: 2, height: 12, background: C.up }} />}
        {typeof resistance === 'number' && resistance > low && resistance < high && <span title={`Resistance ${num(resistance)}`} style={{ position: 'absolute', left: at(resistance), top: -3, width: 2, height: 12, background: C.down }} />}
        <span style={{ position: 'absolute', left: at(price), top: -4, width: 14, height: 14, marginLeft: -7, borderRadius: 7, background: '#fff', boxShadow: '0 0 0 3px rgba(41,98,255,.6)' }} />
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', color: C.dim, fontSize: 11, marginTop: 5 }}><span>L {num(low)}</span><span>H {num(high)}</span></div>
    </div>
  )
}

// India session from the viewer's clock in IST: open / cutoff passed / closed.
function session() {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }))
  const mins = now.getHours() * 60 + now.getMinutes()
  const wk = now.getDay() >= 1 && now.getDay() <= 5
  const left = (to) => { const m = to - mins; return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m` }
  if (!wk || mins < 555 || mins >= 930) return { color: C.dim, text: 'NSE closed', sub: 'opens 09:15 on the next trading day' }
  if (mins >= 900) return { color: C.warn, text: 'NSE open · no new entries', sub: `entries stopped at 15:00 · square-off 15:10 · closes in ${left(930)}` }
  return { color: C.up, text: 'NSE open', sub: `${left(900)} to the 15:00 entry cutoff`, live: true }
}

export default function MarketAnalysis({ isAdmin, onViewOnChart }) {
  const [res, setRes] = useState(null)
  const [err, setErr] = useState('')
  const [msg, setMsg] = useState('')
  const [loading, setLoading] = useState(false)
  const [newsFilter, setNewsFilter] = useState('ALL')

  async function load() {
    setLoading(true)
    try {
      const r = await apiFetch('/api/market-scan')
      setRes(await r.json())
      setErr('')
    } catch (e) { setErr(e.message) }
    setLoading(false)
  }
  useEffect(() => { load() }, [])

  async function askClaude() {
    try {
      await apiFetch('/api/admin/market-scan/ask', { method: 'POST' })
      setMsg('AI is reading the markets — press Refresh in about 2 minutes.')
    } catch (e) { setMsg(e.message) }
  }

  const view = (symbol, market = 'india', trade) => onViewOnChart?.({ symbol, label: symbol, market, trade })
  const jump = (id) => document.getElementById(`ma-${id}`)?.scrollIntoView({ block: 'start' })
  const SIDE = { BUY: C.up, SELL: C.down, AVOID: C.dim }
  const d = res?.data
  const ai = d?.ai
  const ses = session()
  const biasCount = (ai?.markets || []).reduce((a, m) => ({ ...a, [m.bias]: (a[m.bias] || 0) + 1 }), {})
  const biasTotal = Object.values(biasCount).reduce((a, b) => a + b, 0)
  const news = (d?.news || []).filter((n) => newsFilter === 'ALL' || n.impact === newsFilter)
  const movers = [...(d?.stocks?.gainers || []), ...(d?.stocks?.losers || [])]
  const maxMove = Math.max(1, ...movers.map((s) => Math.abs(s.chg_pct || 0)))

  return (
    <div style={{ height: '100%', overflow: 'auto', color: C.text, padding: '0 14px 24px', fontSize: 13 }}>
      {/* sticky header: title, freshness, actions, section nav */}
      <div style={{ position: 'sticky', top: 0, zIndex: 5, background: 'rgba(19,23,34,.94)', backdropFilter: 'blur(6px)', padding: '10px 0 8px', borderBottom: `1px solid ${C.line}` }}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <b style={{ color: '#fff', fontSize: 17 }}>🧭 Market Analysis</b>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: ses.color }} title={ses.sub}>
            <span className={ses.live ? 'pulse-dot' : ''} style={{ width: 8, height: 8, borderRadius: 4, background: ses.color }} />{ses.text}
          </span>
          <span style={{ color: C.dim, fontSize: 12 }}>data {d?.ts?.slice(11, 16) || '—'} · AI {ai?.ts?.slice(11, 16) || '—'}</span>
          {res && !res.running && pill(C.down, 'scanner not running')}
          <span style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            {isAdmin && <button style={btn} onClick={askClaude} disabled={res?.asked}>{res?.asked ? '⏳ AI queued…' : '✨ Ask AI now'}</button>}
            <button style={btn} onClick={load} disabled={loading}>{loading ? 'Refreshing…' : '⟳ Refresh'}</button>
          </span>
        </div>
        {d && <nav style={{ display: 'flex', gap: 6, overflowX: 'auto', marginTop: 8, paddingBottom: 2 }} aria-label="Sections">
          {SECTIONS.map(([id, icon, label]) => (
            <button key={id} onClick={() => jump(id)} style={{ ...btn, color: C.text, borderRadius: 14, whiteSpace: 'nowrap', padding: '3px 11px' }}>{icon} {label}</button>))}
        </nav>}
      </div>
      {msg && <div style={{ color: C.info, marginTop: 8 }}>{msg}</div>}
      {err && <div style={{ color: C.down, marginTop: 8 }}>Error: {err}</div>}
      {!res && !err && <div style={{ color: C.dim, marginTop: 30, textAlign: 'center' }}>Loading the market picture…</div>}
      {res && !d && <div style={{ color: C.dim, marginTop: 30, textAlign: 'center' }}>No analysis yet — the first scan takes about 2 minutes after start.</div>}
      {d && <>
        {/* market pulse */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 260px), 1fr))', gap: 10, marginTop: 14, alignItems: 'start' }} className="fade-up">
          <div style={{ ...card, background: 'linear-gradient(135deg, #1e222d 0%, #1a2340 100%)', gridColumn: 'span 2', minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ color: C.dim, fontSize: 11, textTransform: 'uppercase', letterSpacing: 1 }}>Market mood by AI</span>
              {ai?.risk && pill(IMPACT[ai.risk], `RISK ${ai.risk}`)}
            </div>
            <div style={{ fontSize: 15, color: '#fff', margin: '6px 0' }}>{ai?.mood || 'Waiting for the first AI run.'}</div>
            {ai?.when_to_trade && <div style={{ color: C.dim }}>⏰ {ai.when_to_trade}</div>}
          </div>
          <div style={card}>
            <div style={{ color: C.dim, fontSize: 11, textTransform: 'uppercase', letterSpacing: 1 }}>AI bias across {biasTotal || '—'} markets</div>
            <div style={{ display: 'flex', height: 10, borderRadius: 5, overflow: 'hidden', margin: '10px 0 8px', background: C.line }}>
              {['BULLISH', 'SIDEWAYS', 'BEARISH', 'AVOID'].map((b) => biasCount[b] ? <span key={b} title={`${b}: ${biasCount[b]}`} style={{ width: `${(biasCount[b] / biasTotal) * 100}%`, background: BIAS[b] }} /> : null)}
            </div>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', fontSize: 12 }}>
              {['BULLISH', 'SIDEWAYS', 'BEARISH', 'AVOID'].map((b) => <span key={b} style={{ color: BIAS[b] }}>● {b.toLowerCase()} {biasCount[b] || 0}</span>)}
            </div>
          </div>
          <div style={{ ...card, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            {[...Object.entries(d.indices || {}).map(([n, x]) => [n, x, INDEX_CHART[n], 'india', '']), ...['BTC'].map((n) => [n, d.crypto?.[n], CRYPTO_CHART[n], 'crypto', '$'])].map(([n, x, sym, mkt, cur]) => (
              <button key={n} onClick={() => view(sym, mkt)} title={`Open ${n} chart`} style={{ textAlign: 'left', background: '#131722', border: `1px solid ${C.line}`, borderRadius: 6, padding: '5px 8px', cursor: 'pointer', color: C.text }}>
                <div style={{ fontSize: 11, color: C.dim }}>{n}</div>
                <div style={{ fontWeight: 700 }}>{cur}{num(x?.price)}</div>
                <div style={{ fontSize: 11 }}>{pct(x?.chg_pct)}</div>
              </button>))}
          </div>
        </div>

        <Section id="planner" icon="🎯" title="AI investment planner" sub="enter your amount — AI builds the strategy from the latest scan">
          <InvestPlanner view={view} />
        </Section>

        <Section id="plan" icon="🧠" title="What to trade now" sub={ai?.ts ? `AI plan from ${ai.ts.slice(11, 16)}` : ''}>
          {!ai && <div style={{ color: C.dim }}>Waiting for the first AI run.</div>}
          {ai?.error && <div style={{ color: C.warn, marginBottom: 8 }}>⚠️ Latest AI run failed ({ai.error}){ai.mood ? ' — showing the last good plan' : ''}</div>}
          {ai?.mood && <>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 250px), 1fr))', gap: 10 }}>
              {ai.markets.map((m) => (
                <div key={m.name} style={{ ...card, borderLeft: `3px solid ${BIAS[m.bias]}` }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}><b style={{ color: '#fff' }}>{m.name}</b>{pill(BIAS[m.bias], m.bias)}</div>
                  <div style={{ margin: '6px 0', color: C.info }}>{m.strategy}</div>
                  {m.bias !== 'AVOID' && <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '2px 8px', fontSize: 12 }}>
                    <span style={{ color: C.dim }}>Entry</span><span>{m.entry}</span>
                    <span style={{ color: C.dim }}>Stoploss</span><span style={{ color: C.down }}>{m.stoploss}</span>
                    <span style={{ color: C.dim }}>Target</span><span style={{ color: C.up }}>{m.target}</span>
                  </div>}
                  <div style={{ color: C.dim, fontSize: 12, marginTop: 6 }}>{m.why}</div>
                </div>))}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 320px), 1fr))', gap: 10, marginTop: 10 }}>
              <div style={card}><b>📢 News that matters today</b>
                {ai.news_impact.length ? ai.news_impact.map((n, i) => <div key={i} style={{ marginTop: 8 }}>{pill(IMPACT[n.impact], n.impact, { marginRight: 6 })}{n.headline}<div style={{ color: C.dim, fontSize: 12 }}>affects: {n.affects}</div></div>) : <div style={{ color: C.dim, marginTop: 6 }}>Nothing market-moving.</div>}
              </div>
              <div style={{ ...card, borderColor: `${C.down}55` }}><b style={{ color: C.down }}>🚫 Avoid right now</b>
                <ul style={{ margin: '6px 0 0', paddingLeft: 18, lineHeight: 1.6 }}>{ai.avoid.map((a, i) => <li key={i}>{a}</li>)}</ul>
              </div>
            </div>
            <details style={{ marginTop: 8, color: C.dim }}>
              <summary>🔍 Data checks by AI ({ai.data_checks.length})</summary>
              <ul style={{ paddingLeft: 18 }}>{ai.data_checks.map((c, i) => <li key={i}>{c}</li>)}</ul>
            </details>
          </>}
        </Section>

        {ai?.playbook?.length > 0 && <Section id="strategies" icon="📚" title="Prebuilt strategies by AI" sub="for today's conditions — open a card for the exact rules">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 290px), 1fr))', gap: 10, alignItems: 'start' }}>
            {ai.playbook.map((p, i) => (
              <details key={p.name} style={{ ...card, borderTop: `3px solid ${['#2962ff', '#7c4dff', '#26a69a', '#ffb74d', '#4fc3f7', '#ef5350'][i % 6]}` }}>
                <summary style={{ listStyle: 'none' }}>
                  <b style={{ color: '#fff' }}>{p.name}</b>
                  <div style={{ color: C.dim, fontSize: 11, margin: '2px 0 6px' }}>{p.markets}</div>
                  <div style={{ fontSize: 12 }}>🟢 {p.condition}</div>
                  <div style={{ color: '#2962ff', fontSize: 12, marginTop: 6 }}>Show rules ▾</div>
                </summary>
                <div style={{ display: 'grid', gap: 6, marginTop: 8, fontSize: 12 }}>
                  <div><b>▶ Entry:</b> {p.entry_rule}</div>
                  <div><b style={{ color: C.down }}>■ Stoploss:</b> {p.stoploss_rule}</div>
                  <div><b style={{ color: C.up }}>★ Target:</b> {p.target_rule}</div>
                  <div style={{ color: C.down }}>⚠️ Avoid when: {p.avoid_when}</div>
                </div>
              </details>))}
          </div>
        </Section>}

        <Section id="indices" icon="🏛️" title="Indices" sub={`${d.india_open ? '' : 'market closed — last session · '}India VIX ${num(d.global?.['India VIX']?.price)}`}
          right={pct(d.global?.['India VIX']?.chg_pct)}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 280px), 1fr))', gap: 10 }}>{Object.entries(d.indices || {}).map(([name, x]) => {
            const m = ai?.markets?.find((r) => r.name === name)
            return (
              <div key={name} style={card}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}><b style={{ color: '#fff' }}>{name}</b><button style={btn} onClick={() => view(INDEX_CHART[name])}>📈 Chart</button></div>
                {x.error ? <div style={{ color: C.down }}>data unavailable ({x.error})</div> : <>
                  <div style={{ fontSize: 22, fontWeight: 700, margin: '4px 0' }}>{num(x.price)} <span style={{ fontSize: 14 }}>{pct(x.chg_pct)}</span></div>
                  <RangeBar low={x.low} high={x.high} price={x.price} support={x.support} resistance={x.resistance} />
                  <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', fontSize: 12, color: C.dim }}>
                    <span><span style={{ color: C.up }}>▮</span> Support {num(x.support)}</span><span><span style={{ color: C.down }}>▮</span> Resistance {num(x.resistance)}</span>
                    {x.delayed_min > 8 && <span style={{ color: C.warn }}>delayed {x.delayed_min} min</span>}
                  </div>
                  <div style={{ marginTop: 8 }} title={(x.why || []).join('\n')}>{pill(x.state.includes('UP') ? C.up : x.state.includes('DOWN') ? C.down : C.warn, x.state.replace('_', ' '))}{x.label ? <span style={{ color: C.dim, fontSize: 12 }}> {x.label}</span> : null}</div>
                  {m ? <div style={{ marginTop: 8, paddingTop: 8, borderTop: `1px dashed ${C.line}` }}>AI: <b style={{ color: BIAS[m.bias] }}>{m.bias}</b> — {m.strategy}<div style={{ color: C.dim, fontSize: 12 }}>Entry {m.entry} · SL {m.stoploss} · Target {m.target}</div></div>
                    : <div style={{ color: C.dim, marginTop: 6 }}>Waiting for AI strategy.</div>}
                </>}
              </div>)
          })}</div>
        </Section>

        <Section id="movers" icon="🔥" title="Top moving F&O stocks" sub="tile colour = size of today's move · click a tile for its chart and AI levels">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: 6, marginBottom: 12 }}>
            {movers.map((s) => {
              const p = ai?.stocks?.find((r) => r.symbol === s.symbol)
              const trade = p?.side && p.side !== 'AVOID' && p.entry != null ? { entry: p.entry, stoploss: p.stoploss, target: p.target, direction: p.side === 'BUY' ? 'long' : 'short' } : null
              const a = 0.15 + 0.6 * Math.abs(s.chg_pct || 0) / maxMove
              const col = (s.chg_pct || 0) >= 0 ? `rgba(38,166,154,${a})` : `rgba(239,83,80,${a})`
              return (
                <button key={s.symbol} onClick={() => view(`NSE:${s.symbol}`, 'india', trade)} title={p?.why || 'Open the chart'}
                  style={{ background: col, border: '1px solid rgba(255,255,255,.06)', borderRadius: 8, padding: '8px 10px', textAlign: 'left', cursor: 'pointer', color: '#fff' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 4 }}><b style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.symbol}</b>{p?.side && <span style={{ fontSize: 10, fontWeight: 700, opacity: 0.9, flexShrink: 0 }}>{p.side}</span>}</div>
                  <div style={{ fontSize: 16, fontWeight: 700 }}>{s.chg_pct >= 0 ? '+' : ''}{s.chg_pct?.toFixed(2)}%</div>
                  <div style={{ fontSize: 11, opacity: 0.85 }}>{num(s.price)}</div>
                </button>)
            })}
          </div>
          {['gainers', 'losers'].map((k) => (
            <details key={k} open style={{ ...card, marginBottom: 10 }}>
              <summary><b style={{ color: k === 'gainers' ? C.up : C.down }}>{k === 'gainers' ? '▲ Top gainers' : '▼ Top losers'}</b> <span style={{ color: C.dim, fontSize: 12 }}>— AI entry, stoploss &amp; target</span></summary>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, marginTop: 6 }}>
                  <thead><tr style={{ color: C.dim, textAlign: 'left' }}>{['Stock', 'Price', 'Day', 'High / Low', 'AI', 'Strategy', 'Entry', 'Stoploss', 'Target', ''].map((x) => <th key={x} style={td}>{x}</th>)}</tr></thead>
                  <tbody>
                  {(d.stocks?.[k] || []).map((s) => {
                    const p = ai?.stocks?.find((r) => r.symbol === s.symbol)
                    const trade = p?.side && p.side !== 'AVOID' && p.entry != null ? { entry: p.entry, stoploss: p.stoploss, target: p.target, direction: p.side === 'BUY' ? 'long' : 'short' } : null
                    return (
                      <tr key={s.symbol}>
                        <td style={{ ...td, fontWeight: 700 }}>{s.symbol}</td>
                        <td style={td}>{num(s.price)}</td><td style={td}>{pct(s.chg_pct)}</td>
                        <td style={{ ...td, color: C.dim }}>{num(s.high)} / {num(s.low)}</td>
                        <td style={td}>{p?.side ? pill(SIDE[p.side], p.side) : '—'}</td>
                        <td style={td} title={p?.why}>{p?.strategy || <span style={{ color: C.dim }}>waiting for AI</span>}</td>
                        <td style={td}>{num(p?.entry)}</td>
                        <td style={{ ...td, color: C.down }}>{num(p?.stoploss)}</td>
                        <td style={{ ...td, color: C.up }}>{num(p?.target)}</td>
                        <td style={{ ...td, whiteSpace: 'nowrap' }}>
                          <button style={btn} onClick={() => view(`NSE:${s.symbol}`, 'india', trade)} title={trade ? 'Open the chart with the AI entry / stoploss / target lines' : 'Open the chart'}>
                            {trade ? '🎯 View strategy' : '📈 Chart'}
                          </button>
                        </td>
                      </tr>)
                  })}
                  </tbody>
                </table>
              </div>
            </details>))}
        </Section>

        <Section id="crypto" icon="🪙" title="Crypto" sub="last 24 hours">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 260px), 1fr))', gap: 10 }}>
            {Object.entries(d.crypto || {}).map(([name, x]) => {
              const m = ai?.markets?.find((r) => r.name === name)
              return (
                <div key={name} style={card}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}><b style={{ color: '#fff' }}>{name}</b><button style={btn} onClick={() => view(CRYPTO_CHART[name], 'crypto')}>📈 Chart</button></div>
                  {x.error ? <div style={{ color: C.down }}>data unavailable ({x.error})</div> : <>
                    <div style={{ fontSize: 22, fontWeight: 700, margin: '4px 0' }}>${num(x.price)} <span style={{ fontSize: 14 }}>{pct(x.chg_pct)}</span></div>
                    <RangeBar low={x.low} high={x.high} price={x.price} />
                    <div style={{ marginTop: 6 }} title={(x.why || []).join('\n')}>{pill(x.state.includes('UP') ? C.up : x.state.includes('DOWN') ? C.down : C.warn, x.state.replace('_', ' '))}</div>
                    {m && <div style={{ marginTop: 8, fontSize: 12 }}>AI: <b style={{ color: BIAS[m.bias] }}>{m.bias}</b> — {m.strategy}</div>}
                  </>}
                </div>)
            })}
            <div style={card}><b>🚀 Top crypto movers</b>
              {(d.crypto_movers || []).map((m) => (
                <button key={m.symbol} onClick={() => view(`BINANCE:${m.symbol}`, 'crypto')} style={{ display: 'flex', width: '100%', justifyContent: 'space-between', marginTop: 4, background: 'transparent', border: 0, borderBottom: `1px solid ${C.line}`, padding: '4px 0', color: C.text, cursor: 'pointer', fontSize: 12 }}>
                  <span>{m.symbol}</span><span>{num(m.price)} {pct(m.chg_pct)}</span>
                </button>))}
            </div>
          </div>
        </Section>

        <Section id="forex" icon="💱" title="Forex & global cues">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 8 }}>
            {Object.entries(d.global || {}).filter(([n, x]) => n !== 'India VIX' && x && typeof x === 'object').map(([n, x]) => (
              <div key={n} style={{ ...card, padding: 10, borderLeft: `3px solid ${(x.chg_pct || 0) >= 0 ? C.up : C.down}` }}>
                <div style={{ color: C.dim, fontSize: 11 }}>{n}</div><div style={{ fontWeight: 700, fontSize: 15 }}>{num(x.price)}</div><div style={{ fontSize: 12 }}>{pct(x.chg_pct)}</div>
              </div>))}
          </div>
        </Section>

        <Section id="news" icon="📰" title="News" sub="last 8 hours"
          right={<span style={{ display: 'flex', gap: 6 }}>{['ALL', 'HIGH', 'MEDIUM', 'LOW'].map((f) => {
            const n = f === 'ALL' ? (d.news || []).length : (d.news || []).filter((x) => x.impact === f).length
            return <button key={f} onClick={() => setNewsFilter(f)} style={{ ...btn, borderRadius: 12, color: newsFilter === f ? '#fff' : (IMPACT[f] || C.text), background: newsFilter === f ? '#2962ff' : 'transparent' }}>{f.toLowerCase()} {n}</button>
          })}</span>}>
          <div style={card}>
            {news.length === 0 && <div style={{ color: C.dim }}>No news here.</div>}
            {news.map((n, i) => (
              <div key={i} style={{ display: 'flex', gap: 10, padding: '7px 0', borderBottom: i < news.length - 1 ? `1px solid ${C.line}` : 0 }}>
                <span style={{ width: 4, borderRadius: 2, background: IMPACT[n.impact], flexShrink: 0 }} />
                <div style={{ minWidth: 0 }}>
                  <a href={n.link} target="_blank" rel="noreferrer" style={{ color: C.text, textDecoration: 'none' }}>{n.title}</a>
                  <div style={{ color: C.dim, fontSize: 11, marginTop: 2 }}>{n.source} · {n.ts.slice(11, 16)}{n.affects.length ? ` · ${n.affects.join(', ')}` : ''}</div>
                </div>
              </div>))}
          </div>
        </Section>
        <div style={{ color: C.dim, fontSize: 11, marginTop: 16, textAlign: 'center' }}>AI suggestions, not financial advice. No strategy guarantees profit — always use a stoploss.</div>
      </>}
    </div>
  )
}
