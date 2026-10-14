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
