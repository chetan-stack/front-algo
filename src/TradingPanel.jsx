import { Fragment, useEffect, useState } from 'react'
import { parseContract } from './contracts'
import { apiFetch } from './api'

const box = { background: '#1e222d', border: '1px solid #2a2e39', borderRadius: 6, padding: 12 }
const input = { background: '#131722', color: '#d1d4dc', border: '1px solid #2a2e39', borderRadius: 4, padding: '4px 8px', width: 90 }
const th = { textAlign: 'left', padding: '6px 10px', color: '#787b86', fontWeight: 500, fontSize: 12, borderBottom: '1px solid #2a2e39' }
const td = { padding: '6px 10px', borderBottom: '1px solid #1e222d' }

function profitColor(v) {
  const n = typeof v === 'string' ? parseFloat(v) : v
  return n > 0 ? '#26a69a' : n < 0 ? '#ef5350' : '#d1d4dc'
}

export default function TradingPanel({ onViewOnChart, market = 'india' }) {
  const prefix = market === 'crypto' ? '/api/crypto/trading' : '/api/trading'
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [config, setConfig] = useState(null)
  const [savingConfig, setSavingConfig] = useState(false)
  const [orderEdits, setOrderEdits] = useState({})
  const [savingOrder, setSavingOrder] = useState(null)
  const [chartLoading, setChartLoading] = useState(null)
  const [expandedSignal, setExpandedSignal] = useState(null)

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const client = data?.selectclient?.[0]
      const params = new URLSearchParams({ date, ...(client ? { selectclient: client } : {}) })
      const res = await apiFetch(`${prefix}/dashboard?${params}`)
      const d = await res.json()
      if (d.status !== 'success') throw new Error(d.message || 'failed to load')
      setData(d)
      setConfig(d.form_data)
    } catch (e) {
      setError(e.message)
    }
    setLoading(false)
  }

  useEffect(() => { load() }, [date])

  async function saveConfig() {
    setSavingConfig(true)
    // update_dashboard_config reads these back under different keys than
    // /api/dashboard returns them under (NIFTY -> trade_nifty, etc.) —
    // without this, they silently read as undefined and get saved as false.
    const payload = {
      ...config,
      selectclient: data.selectclient?.[0],
      trade_nifty: config.NIFTY,
      trade_banknifty: config.BANKNIFTY,
      trade_SENSEX: config.SENSEX,
    }
    const res = await apiFetch(`${prefix}/config`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    })
    const d = await res.json()
    setSavingConfig(false)
    if (d.status === 'success') setConfig(d.form_data)
    else setError(d.message)
  }

  async function saveOrder(symbol) {
    setSavingOrder(symbol)
    const edit = orderEdits[symbol] || {}
    const payload = {
      symbol,
      selectclient: data.selectclient?.[0],
      stoplosspoint: edit.stoplosspoint,
      targetpoint: edit.targetpoint,
    }
    const res = await apiFetch(`${prefix}/order`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    })
    const d = await res.json()
    setSavingOrder(null)
    if (d.status === 'success') load()
    else setError(d.message)
  }

  async function exitOrder(symbol) {
    setSavingOrder(symbol)
    const res = await apiFetch(`${prefix}/exit-order`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol, selectclient: data.selectclient?.[0] }),
    })
    const d = await res.json()
    setSavingOrder(null)
    if (d.status === 'success') load()
    else setError(d.message)
  }

  async function deleteOrder(symbol) {
    if (!confirm(`Remove ${symbol} from the tracked order list? This only affects local tracking data, not any live broker position.`)) return
    setSavingOrder(symbol)
    const res = await apiFetch(`${prefix}/delete-order`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol, selectclient: data.selectclient?.[0] }),
    })
    const d = await res.json()
    setSavingOrder(null)
    if (d.status === 'success') load()
    else setError(d.message)
  }

  // Resolves via TradingView search (underlying+strike+right) rather than
  // reconstructing the exact date, since we deliberately don't decode the
  // broker's two different expiry encodings (see contracts.js). Takes the
  // nearest-expiry match — usually right for a weekly-options bot, but not
  // guaranteed to be the *exact* expiry of the held position if multiple exist.
  // TradingView's search interleaves calls and puts regardless of the CE/PE in
  // the query text, so results must be filtered by parsed right, not just [0].
  async function viewOnChart(symbol) {
    const c = parseContract(symbol)
    if (!c) { setError(`Could not parse contract from ${symbol}`); return }
    setChartLoading(symbol)
    const right = c.right === 'C' ? 'CE' : 'PE'
    const res = await apiFetch(`/api/search?query=${encodeURIComponent(`${c.underlying} ${c.strike} ${right}`)}&type=options`)
    const d = await res.json()
    setChartLoading(null)
    const match = d.success && d.results.find((r) => parseContract(r.symbol)?.right === c.right)
    if (!match) { setError(`No TradingView listing found for ${symbol}`); return }
    onViewOnChart({
      symbol: `${match.exchange}:${match.symbol}`,
      label: `${match.exchange}:${match.symbol} — ${match.description}`,
    })
  }

  if (loading && !data) return <div style={{ padding: 24, color: '#d1d4dc' }}>Loading trading dashboard…</div>
  if (error && !data) return <div style={{ padding: 24, color: '#ef5350' }}>Error: {error} — is the trading bot running on localhost:{market === 'crypto' ? 4101 : 4100}?</div>
  if (!data) return null

  return (
    <div style={{ height: '100%', overflowY: 'auto', color: '#d1d4dc', padding: 16, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={input} />
        <button onClick={load} style={{ ...input, cursor: 'pointer', width: 'auto' }}>{loading ? 'Refreshing…' : 'Refresh'}</button>
        <span style={{ fontSize: 13 }}>Today: <b style={{ color: profitColor(data.allprofit) }}>{data.allprofit}</b></span>
        <span style={{ fontSize: 13 }}>Last 300d: <b style={{ color: profitColor(data.totalProfit) }}>{data.totalProfit}</b></span>
        {error && <span style={{ color: '#ef5350', fontSize: 12 }}>{error}</span>}
      </div>

      <div style={box}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
          <b>Bot config</b>
          <button onClick={saveConfig} disabled={savingConfig} style={{ ...input, cursor: 'pointer', width: 'auto', background: '#2a2e39' }}>
            {savingConfig ? 'Saving…' : 'Save config'}
          </button>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 10, fontSize: 13 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, border: '1px solid #ef5350', borderRadius: 4, padding: '4px 8px' }}>
            <input type="checkbox" checked={!!config.auto_place_order} onChange={(e) => setConfig({ ...config, auto_place_order: e.target.checked })} />
            Auto place order (real money)
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input type="checkbox" checked={!!config.withmoney} onChange={(e) => setConfig({ ...config, withmoney: e.target.checked })} />
            With money
          </label>
          {market === 'india' && (
            <>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <input type="checkbox" checked={!!config.check_all_level} onChange={(e) => setConfig({ ...config, check_all_level: e.target.checked })} />
                Check all level
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <input type="checkbox" checked={!!config.confirmwithai} onChange={(e) => setConfig({ ...config, confirmwithai: e.target.checked })} />
                Confirm with AI
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <input type="checkbox" checked={!!config.send_alert} onChange={(e) => setConfig({ ...config, send_alert: e.target.checked })} />
                Send alert
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <input type="checkbox" checked={!!config.NIFTY} onChange={(e) => setConfig({ ...config, NIFTY: e.target.checked })} />
                Trade NIFTY
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <input type="checkbox" checked={!!config.BANKNIFTY} onChange={(e) => setConfig({ ...config, BANKNIFTY: e.target.checked })} />
                Trade BANKNIFTY
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <input type="checkbox" checked={!!config.SENSEX} onChange={(e) => setConfig({ ...config, SENSEX: e.target.checked })} />
                Trade SENSEX
              </label>
            </>
          )}
          <label>Stop loss <input style={input} value={config.stop_loss ?? ''} onChange={(e) => setConfig({ ...config, stop_loss: e.target.value })} /></label>
          {market === 'india' && (
            <label>OTM offset <input style={input} value={config.set_otm ?? ''} onChange={(e) => setConfig({ ...config, set_otm: e.target.value })} /></label>
          )}
          <label>Lot size <input style={input} value={config.lotsize ?? ''} onChange={(e) => setConfig({ ...config, lotsize: e.target.value })} /></label>
          <label>Target pts <input style={input} value={config.target_points ?? ''} onChange={(e) => setConfig({ ...config, target_points: e.target.value })} /></label>
          <label>Loss pts <input style={input} value={config.loss_points ?? ''} onChange={(e) => setConfig({ ...config, loss_points: e.target.value })} /></label>
          <label>Range min <input style={input} value={config.trade_range_min ?? ''} onChange={(e) => setConfig({ ...config, trade_range_min: e.target.value })} /></label>
          <label>Range max <input style={input} value={config.trade_range_max ?? ''} onChange={(e) => setConfig({ ...config, trade_range_max: e.target.value })} /></label>
          <label>Buy/Sell
            <select style={{ ...input, width: '100%' }} value={config.buy_or_sell ?? 'BUY'} onChange={(e) => setConfig({ ...config, buy_or_sell: e.target.value })}>
              <option>BUY</option><option>SELL</option>
            </select>
          </label>
          {market === 'india' && (
            <label>Side
              <select style={{ ...input, width: '100%' }} value={config.buy_or_sell_side ?? 'BOTH'} onChange={(e) => setConfig({ ...config, buy_or_sell_side: e.target.value })}>
                <option>BOTH</option><option>CALL</option><option>PUT</option>
              </select>
            </label>
          )}
        </div>
      </div>

      {data.storeorder?.length > 0 && (
        <div style={box}>
          <b>Open / recent orders</b>
          <div style={{ overflowX: 'auto', marginTop: 8 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead><tr>
                <th style={th}>Symbol</th><th style={th}>Status</th><th style={th}>Term</th><th style={th}>Trend</th>
                <th style={th}>Profit</th><th style={th}>Stoploss pt</th><th style={th}>Target pt</th><th style={th} colSpan={4}></th>
              </tr></thead>
              <tbody>
                {data.storeorder.map((o) => {
                  const edit = orderEdits[o.symbol] || { stoplosspoint: o.stoplosspoint, targetpoint: o.targetpoint }
                  const busy = savingOrder === o.symbol
                  return (
                    <tr key={o.symbol}>
                      <td style={td}>{o.symbol}</td>
                      <td style={td}>{o.orderstatus}</td>
                      <td style={td}>{o.orderterm}</td>
                      <td style={td}>{o.trend}</td>
                      <td style={{ ...td, color: profitColor(o.profit) }}>{Math.round(o.profit)}</td>
                      <td style={td}>
                        <input style={input} value={edit.stoplosspoint} onChange={(e) => setOrderEdits({ ...orderEdits, [o.symbol]: { ...edit, stoplosspoint: e.target.value } })} />
                      </td>
                      <td style={td}>
                        <input style={input} value={edit.targetpoint} onChange={(e) => setOrderEdits({ ...orderEdits, [o.symbol]: { ...edit, targetpoint: e.target.value } })} />
                      </td>
                      <td style={td}>
                        {market === 'india' && o.orderterm === 'hold' && (
                          <button onClick={() => viewOnChart(o.symbol)} disabled={chartLoading === o.symbol} style={{ ...input, cursor: 'pointer', width: 'auto' }}>
                            {chartLoading === o.symbol ? '…' : 'View chart'}
                          </button>
                        )}
                      </td>
                      <td style={td}>
                        <button onClick={() => saveOrder(o.symbol)} disabled={busy} style={{ ...input, cursor: 'pointer', width: 'auto' }}>
                          {busy ? '…' : 'Save'}
                        </button>
                      </td>
                      <td style={td}>
                        <button onClick={() => exitOrder(o.symbol)} disabled={busy || o.orderterm === 'exit'} style={{ ...input, cursor: 'pointer', width: 'auto' }}>
                          {o.orderterm === 'exit' ? 'Exited' : 'Exit'}
                        </button>
                      </td>
                      <td style={td}>
                        <button onClick={() => deleteOrder(o.symbol)} disabled={busy} style={{ ...input, cursor: 'pointer', width: 'auto', borderColor: '#ef5350', color: '#ef5350' }}>
                          Delete
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {data.store?.length > 0 && (
        <div style={box}>
          <b>Live signals</b>
          <div style={{ overflowX: 'auto', marginTop: 8 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead><tr>
                <th style={th}>Symbol</th><th style={th}>Trend</th><th style={th}>Signal</th>
                <th style={th}>Price</th><th style={th}>Support</th><th style={th}>Resistance</th><th style={th}></th>
              </tr></thead>
              <tbody>
                {data.store.map((s) => {
                  const expanded = expandedSignal === s.symbol
                  return (
                    <Fragment key={s.symbol}>
                      <tr
                        onClick={() => setExpandedSignal(expanded ? null : s.symbol)}
                        style={{ cursor: 'pointer' }}
                      >
                        <td style={td}>{s.symbol}</td>
                        <td style={{ ...td, color: s.trend === 'buy' ? '#26a69a' : s.trend === 'sell' ? '#ef5350' : '#d1d4dc' }}>{s.trend}</td>
                        <td style={td}>{s.mainsignal}</td>
                        <td style={td}>{s.current_price}</td>
                        <td style={td}>{s.support}</td>
                        <td style={td}>{s.resistance}</td>
                        <td style={{ ...td, color: '#787b86' }}>{expanded ? '▲' : '▼'}</td>
                      </tr>
                      {expanded && (
                        <tr>
                          <td colSpan={7} style={{ ...td, background: '#131722' }}>
                            <div style={{ display: 'grid', gap: 10 }}>
                              <div>
                                <div style={{ color: '#787b86', fontSize: 11, marginBottom: 2 }}>Buy conditions</div>
                                <div style={{ whiteSpace: 'pre-wrap' }}>{s.returncorebuy}</div>
                              </div>
                              <div>
                                <div style={{ color: '#787b86', fontSize: 11, marginBottom: 2 }}>Sell conditions</div>
                                <div style={{ whiteSpace: 'pre-wrap' }}>{s.returncoresell}</div>
                              </div>
                              <div>
                                <div style={{ color: '#787b86', fontSize: 11, marginBottom: 2 }}>Trend message</div>
                                <div style={{ whiteSpace: 'pre-wrap' }}>{s.trend_message}</div>
                              </div>
                              <div>
                                <div style={{ color: '#787b86', fontSize: 11, marginBottom: 2 }}>Sideways info</div>
                                <div style={{ whiteSpace: 'pre-wrap' }}>{s.sideways_info}</div>
                              </div>
                              <div>
                                <div style={{ color: '#787b86', fontSize: 11, marginBottom: 2 }}>Fibonacci levels</div>
                                <div style={{ whiteSpace: 'pre-wrap', fontFamily: 'monospace', fontSize: 12 }}>{s.fibonacci_levels}</div>
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {data.fetchdata?.length > 0 && (
        <div style={box}>
          <b>Trade history — {date}</b>
          <div style={{ overflowX: 'auto', marginTop: 8 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead><tr>
                <th style={th}>ID</th><th style={th}>Script</th><th style={th}>Token</th><th style={th}>Lot size</th>
                <th style={th}>Buy price</th><th style={th}>Exit price</th><th style={th}>Trailing SL</th>
                <th style={th}>Target price</th><th style={th}>Max price</th><th style={th}>Profit</th><th style={th}>Created</th>
              </tr></thead>
              <tbody>
                {data.fetchdata.map((t) => (
                  <tr key={t.id}>
                    <td style={td}>{t.id}</td>
                    <td style={td}>{t.script}</td>
                    <td style={td}>{t.token}</td>
                    <td style={td}>{t.lotsize}</td>
                    <td style={td}>{t.buyPrice}</td>
                    <td style={td}>{t.nltp}</td>
                    <td style={td}>{t.trailing_stoploss_price}</td>
                    <td style={td}>{t.target_price}</td>
                    <td style={td}>{t.max_price_achieved}</td>
                    <td style={{ ...td, color: profitColor(t.profit) }}>{typeof t.profit === 'number' ? t.profit.toFixed(2) : t.profit}</td>
                    <td style={td}>{t.createddate}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {data.monthwisedata?.dailyBreakdown && (
        <div style={box}>
          <b>This month — {data.monthwisedata.totalOrder} orders, {data.monthwisedata.stoplossOrder} stoplosses, total <span style={{ color: profitColor(data.monthwisedata.totalProfit) }}>{data.monthwisedata.totalProfit}</span></b>
          <div style={{ overflowX: 'auto', marginTop: 8 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead><tr><th style={th}>Date</th><th style={th}>Day</th><th style={th}>Orders</th><th style={th}>Stoplosses</th><th style={th}>Profit</th></tr></thead>
              <tbody>
                {Object.entries(data.monthwisedata.dailyBreakdown).map(([d, v]) => (
                  <tr key={d}>
                    <td style={td}>{d}</td><td style={td}>{v.day}</td><td style={td}>{v.orders}</td>
                    <td style={td}>{v.stoplosses}</td>
                    <td style={{ ...td, color: profitColor(v.profit) }}>{v.profit}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
