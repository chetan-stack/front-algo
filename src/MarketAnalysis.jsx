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
const h = { margin: '18px 0 8px', fontSize: 13, color: C.dim, textTransform: 'uppercase', letterSpacing: 1 }
const btn = { background: 'transparent', color: '#2962ff', border: `1px solid ${C.line}`, borderRadius: 4, padding: '4px 10px', cursor: 'pointer', fontSize: 12 }
const grid = { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 10 }
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
      <form onSubmit={build} style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 3, color: C.dim, fontSize: 11 }}>Investment (₹)
          <input style={{ ...input, width: 130 }} type="number" min="1000" step="1000" required value={amount} onChange={(e) => setAmount(e.target.value)} />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 3, color: C.dim, fontSize: 11 }}>Market
          <select style={input} value={market} onChange={(e) => setMarket(e.target.value)}>
            <option value="ANY">Any — AI picks the best</option>
            <option value="INDIA_STOCKS">India intraday stocks</option>
            <option value="INDIA_OPTIONS">India index options</option>
            <option value="CRYPTO">Crypto</option>
          </select>
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 3, color: C.dim, fontSize: 11 }}>Risk
          <select style={input} value={risk} onChange={(e) => setRisk(e.target.value)}>
            <option value="LOW">Low — max loss 1%</option>
            <option value="MEDIUM">Medium — max loss 2%</option>
            <option value="HIGH">High — max loss 3%</option>
          </select>
        </label>
        <button type="submit" disabled={busy} style={{ ...btn, background: '#2962ff', color: '#fff', padding: '7px 14px', fontSize: 13, cursor: busy ? 'wait' : 'pointer' }}>
          {busy ? 'Building…' : 'Build my plan with AI'}
        </button>
        <span style={{ color: C.dim, fontSize: 11 }}>Takes about 1–2 minutes · counts as 1 AI question{quota?.left != null ? ` (${quota.left} left today)` : ''}</span>
      </form>
      {history.length > 0 && <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginTop: 10, fontSize: 12 }}>
        <span style={{ color: C.dim }}>Today's saved plans:</span>
        {history.map((p, i) => (
          <button key={i} onClick={() => choose(p)} style={{ ...btn, color: p === plan ? '#fff' : C.text, background: p === plan ? '#2962ff' : 'transparent' }}>
            {p.built_at || '—'} · {inr(p.amount)} · {p.market === 'ANY' ? 'any' : p.market.replace('INDIA_', '').toLowerCase()} · {p.risk.toLowerCase()}
          </button>))}
      </div>}
      {status && <div style={{ color: C.info, marginTop: 8 }}>{status}</div>}
      {err && <div style={{ color: C.down, marginTop: 8 }}>{err}</div>}
      {plan && <div style={{ marginTop: 10 }}>
        <div>{plan.summary}</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 8, margin: '10px 0' }}>
          {[['Invested', inr(plan.used)], ['Cash reserve', inr(plan.reserve)], ['Max loss (all SL hit)', inr(plan.max_loss), C.down],
            ['Max profit (all targets)', inr(plan.max_profit), C.up], ['Expected value', inr(plan.expected), plan.expected >= 0 ? C.up : C.down]].map(([k, v, col]) => (
            <div key={k} style={{ background: '#131722', border: `1px solid ${C.line}`, borderRadius: 6, padding: '6px 8px' }}>
              <div style={{ color: C.dim, fontSize: 10, textTransform: 'uppercase' }}>{k}</div><div style={{ color: col || C.text, fontWeight: 700 }}>{v}</div>
            </div>))}
        </div>
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
        {plan.trades.length === 0 && <div style={{ color: C.warn }}>AI found no trade with an edge right now — keep the cash.</div>}
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
                  <td style={td}>{t.win_probability}%</td>
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

export default function MarketAnalysis({ isAdmin, onViewOnChart }) {
  const [res, setRes] = useState(null)
  const [err, setErr] = useState('')
  const [msg, setMsg] = useState('')

  async function load() {
    try {
      const r = await apiFetch('/api/market-scan')
      setRes(await r.json())
      setErr('')
    } catch (e) { setErr(e.message) }
  }
  useEffect(() => { load() }, [])

  async function askClaude() {
    try {
      await apiFetch('/api/admin/market-scan/ask', { method: 'POST' })
      setMsg('AI is reading the markets — press Refresh in about 2 minutes.')
    } catch (e) { setMsg(e.message) }
  }

  const view = (symbol, market = 'india', trade) => onViewOnChart?.({ symbol, label: symbol, market, trade })
  const SIDE = { BUY: C.up, SELL: C.down, AVOID: C.dim }
  const d = res?.data
  const ai = d?.ai

  return (
    <div style={{ height: '100%', overflow: 'auto', color: C.text, padding: 12, fontSize: 13 }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', fontSize: 12, color: C.dim }}>
        <b style={{ color: C.text, fontSize: 15 }}>Market Analysis</b>
        <span>data {d?.ts || '—'} · AI plan {ai?.ts || '—'}</span>
        {res && !res.running && <span style={{ color: C.down }}>scanner not running (start.sh starts it)</span>}
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          {isAdmin && <button style={btn} onClick={askClaude} disabled={res?.asked}>{res?.asked ? 'AI queued…' : 'Ask AI now'}</button>}
          <button style={btn} onClick={load}>⟳ Refresh</button>
        </span>
      </div>
      {msg && <div style={{ color: C.info, marginTop: 6 }}>{msg}</div>}
      {err && <div style={{ color: C.down, marginTop: 6 }}>Error: {err}</div>}
      {res && !d && <div style={{ color: C.dim, marginTop: 20 }}>No analysis yet — the first scan takes about 2 minutes after start.</div>}
      {d && <>
        <div style={h}>AI investment planner — enter your amount, AI builds the strategy</div>
        <InvestPlanner view={view} />

        {/* AI plan */}
        <div style={h}>AI plan — what to do now</div>
        {!ai && <div style={{ color: C.dim }}>Waiting for the first AI run.</div>}
        {ai?.error && <div style={{ color: C.warn, marginBottom: 6 }}>Latest AI run failed ({ai.error}){ai.mood ? ' — showing the last good plan' : ''}</div>}
        {ai?.mood && <>
          <div style={{ ...card, display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div><b>Mood:</b> {ai.mood} <span style={{ marginLeft: 8, padding: '1px 8px', borderRadius: 10, border: `1px solid ${IMPACT[ai.risk]}`, color: IMPACT[ai.risk], fontSize: 11 }}>RISK {ai.risk}</span></div>
            <div><b>When to trade:</b> {ai.when_to_trade}</div>
          </div>
          {ai.playbook?.length > 0 && <>
            <div style={h}>Prebuilt strategies by AI — for today's conditions</div>
            <div style={grid}>{ai.playbook.map((p) => (
              <div key={p.name} style={card}>
                <b style={{ color: C.info }}>{p.name}</b> <span style={{ color: C.dim, fontSize: 11 }}>· {p.markets}</span>
                <div style={{ color: C.dim, margin: '4px 0' }}>When: {p.condition}</div>
                <div><b>Entry:</b> {p.entry_rule}</div>
                <div><b>Stoploss:</b> {p.stoploss_rule}</div>
                <div><b>Target:</b> {p.target_rule}</div>
                <div style={{ color: C.down, marginTop: 4 }}>Avoid when: {p.avoid_when}</div>
              </div>))}
            </div>
            <div style={h}>What to trade now</div>
          </>}
          <div style={{ overflowX: 'auto', marginTop: 10 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead><tr style={{ color: C.dim, textAlign: 'left' }}>{['Market', 'Bias', 'Strategy', 'Entry', 'Stoploss', 'Target', 'Why'].map((x) => <th key={x} style={td}>{x}</th>)}</tr></thead>
              <tbody>{ai.markets.map((m) => (
                <tr key={m.name}>
                  <td style={{ ...td, fontWeight: 700 }}>{m.name}</td>
                  <td style={{ ...td, color: BIAS[m.bias], fontWeight: 700 }}>{m.bias}</td>
                  <td style={td}>{m.strategy}</td><td style={td}>{m.entry}</td><td style={td}>{m.stoploss}</td><td style={td}>{m.target}</td>
                  <td style={{ ...td, color: C.dim }}>{m.why}</td>
                </tr>))}
              </tbody>
            </table>
          </div>
          <div style={{ ...grid, marginTop: 10 }}>
            <div style={card}><b>News impact</b>
              {ai.news_impact.length ? ai.news_impact.map((n, i) => <div key={i} style={{ marginTop: 6 }}><span style={{ color: IMPACT[n.impact] }}>{n.impact}</span> {n.headline}<div style={{ color: C.dim }}>affects: {n.affects}</div></div>) : <div style={{ color: C.dim }}>Nothing market-moving.</div>}
            </div>
            <div style={card}><b style={{ color: C.down }}>Avoid</b>
              <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>{ai.avoid.map((a, i) => <li key={i}>{a}</li>)}</ul>
            </div>
          </div>
          <details style={{ marginTop: 8, color: C.dim }}>
            <summary style={{ cursor: 'pointer' }}>Data checks by AI ({ai.data_checks.length})</summary>
            <ul style={{ paddingLeft: 18 }}>{ai.data_checks.map((c, i) => <li key={i}>{c}</li>)}</ul>
          </details>
          <div style={{ color: C.dim, fontSize: 11, marginTop: 4 }}>AI suggestions, not financial advice. No strategy guarantees profit — always use a stoploss.</div>
        </>}

        {/* Indices */}
        <div style={h}>Indices {d.india_open ? '' : '(market closed — last session)'} · India VIX {num(d.global?.['India VIX']?.price)} {pct(d.global?.['India VIX']?.chg_pct)}</div>
        <div style={grid}>{Object.entries(d.indices || {}).map(([name, x]) => (
          <div key={name} style={card}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}><b>{name}</b><button style={btn} onClick={() => view(INDEX_CHART[name])}>View chart</button></div>
            {x.error ? <div style={{ color: C.down }}>data unavailable ({x.error})</div> : <>
              <div style={{ fontSize: 18, margin: '4px 0' }}>{num(x.price)} {pct(x.chg_pct)}</div>
              <div style={{ color: C.dim }}>Day H {num(x.high)} · L {num(x.low)}{x.delayed_min > 8 ? ` · delayed ${x.delayed_min} min` : ''}</div>
              <div style={{ color: C.dim }}>Support {num(x.support)} · Resistance {num(x.resistance)}</div>
              <div style={{ marginTop: 6 }} title={(x.why || []).join('\n')}><b style={{ color: x.state.includes('UP') ? C.up : x.state.includes('DOWN') ? C.down : C.warn }}>{x.state.replace('_', ' ')}</b>{x.label ? ` · ${x.label}` : ''}</div>
              {(() => { const m = ai?.markets?.find((r) => r.name === name); return m
                ? <div style={{ marginTop: 4 }}>AI: <b style={{ color: BIAS[m.bias] }}>{m.bias}</b> — {m.strategy}<div style={{ color: C.dim }}>Entry {m.entry} · SL {m.stoploss} · Target {m.target}</div></div>
                : <div style={{ color: C.dim, marginTop: 4 }}>Waiting for AI strategy.</div> })()}
            </>}
          </div>))}
        </div>

        {/* Top movers */}
        <div style={h}>Top moving F&amp;O stocks — AI entry, stoploss &amp; target</div>
        {['gainers', 'losers'].map((k) => (
          <div key={k} style={{ ...card, marginBottom: 10, overflowX: 'auto' }}><b style={{ color: k === 'gainers' ? C.up : C.down }}>{k === 'gainers' ? 'Top gainers' : 'Top losers'}</b>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, marginTop: 4 }}>
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
                    <td style={{ ...td, color: SIDE[p?.side] || C.dim, fontWeight: 700 }}>{p?.side || '—'}</td>
                    <td style={td} title={p?.why}>{p?.strategy || <span style={{ color: C.dim }}>waiting for AI</span>}</td>
                    <td style={td}>{num(p?.entry)}</td>
                    <td style={{ ...td, color: C.down }}>{num(p?.stoploss)}</td>
                    <td style={{ ...td, color: C.up }}>{num(p?.target)}</td>
                    <td style={{ ...td, whiteSpace: 'nowrap' }}>
                      <button style={btn} onClick={() => view(`NSE:${s.symbol}`, 'india', trade)} title={trade ? 'Open the chart with the AI entry / stoploss / target lines' : 'Open the chart'}>
                        {trade ? 'View strategy' : 'View chart'}
                      </button>
                    </td>
                  </tr>)
              })}
              </tbody>
            </table>
          </div>))}

        {/* Crypto */}
        <div style={h}>Crypto (24h)</div>
        <div style={grid}>
          {Object.entries(d.crypto || {}).map(([name, x]) => (
            <div key={name} style={card}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}><b>{name}</b><button style={btn} onClick={() => view(CRYPTO_CHART[name], 'crypto')}>View chart</button></div>
              {x.error ? <div style={{ color: C.down }}>data unavailable ({x.error})</div> : <>
                <div style={{ fontSize: 18, margin: '4px 0' }}>${num(x.price)} {pct(x.chg_pct)}</div>
                <div style={{ color: C.dim }}>24h H {num(x.high)} · L {num(x.low)}</div>
                <div style={{ marginTop: 4 }} title={(x.why || []).join('\n')}><b>{x.state.replace('_', ' ')}</b></div>
              </>}
            </div>))}
          <div style={card}><b>Top crypto movers</b>
            {(d.crypto_movers || []).map((m) => (
              <div key={m.symbol} style={{ display: 'flex', justifyContent: 'space-between', marginTop: 3 }}>
                <a style={{ color: C.text, cursor: 'pointer' }} onClick={() => view(`BINANCE:${m.symbol}`, 'crypto')}>{m.symbol}</a><span>{num(m.price)} {pct(m.chg_pct)}</span>
              </div>))}
          </div>
        </div>

        {/* Forex + global */}
        <div style={h}>Forex &amp; global cues</div>
        <div style={{ ...grid, gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))' }}>
          {Object.entries(d.global || {}).filter(([n, x]) => n !== 'India VIX' && x && typeof x === 'object').map(([n, x]) => (
            <div key={n} style={card}><div style={{ color: C.dim, fontSize: 11 }}>{n}</div><div>{num(x.price)} {pct(x.chg_pct)}</div></div>))}
        </div>

        {/* News */}
        <div style={h}>News (last 8 hours)</div>
        <div style={card}>
          {(d.news || []).length === 0 && <div style={{ color: C.dim }}>No recent news.</div>}
          {(d.news || []).map((n, i) => (
            <div key={i} style={{ padding: '4px 0', borderBottom: `1px solid ${C.line}` }}>
              <span style={{ color: IMPACT[n.impact], fontSize: 11, marginRight: 6 }}>{n.impact}</span>
              <a href={n.link} target="_blank" rel="noreferrer" style={{ color: C.text }}>{n.title}</a>
              <span style={{ color: C.dim, fontSize: 11 }}> · {n.source} {n.ts.slice(11)}{n.affects.length ? ` · ${n.affects.join(', ')}` : ''}</span>
            </div>))}
        </div>
      </>}
    </div>
  )
}
