import { Fragment, useEffect, useState } from 'react'
import { parseContract } from './contracts'
import { apiFetch } from './api'
import { useAlerts, latestOrderAlert, OrderAlert, ORDER_ALERT_STYLE, useMarketState, IndexStatus } from './orderAlerts'

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
  const alerts = useAlerts()
  const marketState = useMarketState(market)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7))
  const [config, setConfig] = useState(null)
  const [savingConfig, setSavingConfig] = useState(false)
  const [orderEdits, setOrderEdits] = useState({})
  const [savingOrder, setSavingOrder] = useState(null)
  const [chartLoading, setChartLoading] = useState(null)
  const [expandedSignal, setExpandedSignal] = useState(null)
  const [cryptoQuery, setCryptoQuery] = useState('')
  const [cryptoUnderlying, setCryptoUnderlying] = useState('BTC')
  // withmoney (india): the broker is the source of truth for what's held and
  // what executed — positions (qty, avg price, LTP, P&L) and the order book —
  // not the bot's own database, which can't see partial fills, rejected exits
  // or trades placed in the AngelOne app. Uses the SAVED setting, not an
  // unsaved checkbox tick.
  const brokerMode = market === 'india' && !!data?.form_data?.withmoney
  const [broker, setBroker] = useState({ positions: [], orders: [], error: null, loaded: false })
  useEffect(() => {
    if (!brokerMode) return
    let cancelled = false
    async function poll() {
      try {
        const [p, o] = await Promise.all([
          apiFetch(`${prefix}/positions`).then((r) => r.json()),
          apiFetch(`${prefix}/orderbook`).then((r) => r.json()),
        ])
        if (cancelled) return
        const err = [p, o].find((x) => x.status !== 'success')
        setBroker({ positions: p.positions || [], orders: o.orders || [], error: err ? (err.message || 'broker request failed') : null, loaded: true })
      } catch (e) {
        if (!cancelled) setBroker((b) => ({ ...b, error: e.message, loaded: true }))
      }
    }
    // AngelOne allows 1 getPosition + 1 getOrderBook per second for the WHOLE
    // account (bots included); a hidden tab needn't spend any of it.
    poll()
    const id = setInterval(() => { if (!document.hidden) poll() }, 15000)
    const onVisible = () => { if (!document.hidden) poll() }
    document.addEventListener('visibilitychange', onVisible)
    return () => { cancelled = true; clearInterval(id); document.removeEventListener('visibilitychange', onVisible) }
  }, [brokerMode, prefix])
  const [cryptoResults, setCryptoResults] = useState(null)
  const [cryptoSearchBusy, setCryptoSearchBusy] = useState(false)

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const client = data?.selectclient?.[0]
      const params = new URLSearchParams({ date, month, ...(client ? { selectclient: client } : {}) })
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

  useEffect(() => { load() }, [date, month])

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
      trade_btcusd: config.BTCUSD,
      trade_ethusd: config.ETHUSD,
    }
    const res = await apiFetch(`${prefix}/config`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    })
    const d = await res.json()
    setSavingConfig(false)
    if (d.status === 'success') setConfig(d.form_data)
    else setError(d.message)
  }

  async function searchCryptoOptions() {
    setCryptoSearchBusy(true)
    try {
      const params = new URLSearchParams({ underlying: cryptoUnderlying, ...(cryptoQuery ? { query: cryptoQuery } : {}) })
      const res = await apiFetch(`/api/crypto/search?${params}`)
      const d = await res.json()
      setCryptoResults(d.success ? d.results : [])
    } catch (e) {
      setCryptoResults([])
    }
    setCryptoSearchBusy(false)
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

  async function deleteAllOrders() {
    const symbols = data.storeorder.map((o) => o.symbol)
    if (!confirm(`Remove all ${symbols.length} tracked orders from this list? This only affects local tracking data, not any live broker position or open position — delete only positions you've confirmed are actually closed.`)) return
    setSavingOrder('__all__')
    for (const symbol of symbols) {
      const res = await apiFetch(`${prefix}/delete-order`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol, selectclient: data.selectclient?.[0] }),
      })
      const d = await res.json()
      if (d.status !== 'success') setError(d.message)
    }
    setSavingOrder(null)
    load()
  }

  // Resolves via TradingView search (underlying+strike+right) rather than
  // reconstructing the exact date, since we deliberately don't decode the
  // broker's two different expiry encodings (see contracts.js). Takes the
  // nearest-expiry match — usually right for a weekly-options bot, but not
  // guaranteed to be the *exact* expiry of the held position if multiple exist.
  // TradingView's search interleaves calls and puts regardless of the CE/PE in
  // the query text, so results must be filtered by parsed right, not just [0].
  async function viewOnChart(symbol) {
    if (market === 'crypto') {
      // DeltaEx option symbols (e.g. C-BTC-78200-310826) are already directly
      // chartable — /api/ohlcv, /api/quote, and the live feed all recognize
      // this exact format (server.py's DELTA_OPTION_RE), so no TradingView
      // search/resolution step is needed like india's contracts below.
      onViewOnChart({ symbol, label: symbol })
      return
    }
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
          {/* Live-money guards (SmartApi live_trade.py): checked before every live
              entry; exits of open live positions are never blocked. */}
          {market === 'india' && config.withmoney && (
            <>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, border: '1px solid #ef5350', borderRadius: 4, padding: '4px 8px', color: config.live_halt ? '#ef5350' : undefined }}
                title="Blocks every new live entry (auto, chart, AI). Open positions keep their broker stoploss and normal exits.">
                <input type="checkbox" checked={!!config.live_halt} onChange={(e) => setConfig({ ...config, live_halt: e.target.checked })} />
                Stop new live trades
              </label>
              <label title="Blocks new live entries once today's broker P&L (all positions) reaches this loss. Blank = no cap.">
                Max daily loss ₹ <input style={input} value={config.live_max_daily_loss ?? ''} onChange={(e) => setConfig({ ...config, live_max_daily_loss: e.target.value })} placeholder="no cap" />
              </label>
            </>
          )}
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
                Trade NIFTY <IndexStatus name="NIFTY" state={marketState} alerts={alerts} />
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <input type="checkbox" checked={!!config.BANKNIFTY} onChange={(e) => setConfig({ ...config, BANKNIFTY: e.target.checked })} />
                Trade BANKNIFTY <IndexStatus name="BANKNIFTY" state={marketState} alerts={alerts} />
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <input type="checkbox" checked={!!config.SENSEX} onChange={(e) => setConfig({ ...config, SENSEX: e.target.checked })} />
                Trade SENSEX <IndexStatus name="SENSEX" state={marketState} alerts={alerts} />
              </label>
            </>
          )}
          {market === 'crypto' && (
            <>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <input type="checkbox" checked={!!config.BTCUSD} onChange={(e) => setConfig({ ...config, BTCUSD: e.target.checked })} />
                Trade BTC <IndexStatus name="BTC" state={marketState} alerts={alerts} />
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <input type="checkbox" checked={!!config.ETHUSD} onChange={(e) => setConfig({ ...config, ETHUSD: e.target.checked })} />
                Trade ETH <IndexStatus name="ETH" state={marketState} alerts={alerts} />
              </label>
            </>
          )}
          <label>Stop loss <input style={input} value={config.stop_loss ?? ''} onChange={(e) => setConfig({ ...config, stop_loss: e.target.value })} /></label>
          {market === 'india' && (
            <label>OTM offset <input style={input} value={config.set_otm ?? ''} onChange={(e) => setConfig({ ...config, set_otm: e.target.value })} /></label>
          )}
          {/* Chart.jsx's Buy CE/PE buttons read lotsize from the backend's saved
              config, not from this input directly — typing here only updated
              local state, so a click on the chart still fired with whatever
              was last saved (the "10" default) until "Save config" was
              clicked separately on this page. Saving on blur closes that gap
              without turning every field here into an autosave. */}
          <label>Lot size <input style={input} value={config.lotsize ?? ''} onChange={(e) => setConfig({ ...config, lotsize: e.target.value })} onBlur={saveConfig} /></label>
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

      {brokerMode && (
        <div style={box}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <b>Positions — from broker (live money)</b>
            <span style={{ fontSize: 12, color: '#787b86' }}>AngelOne · refreshes every 8s</span>
          </div>
          {broker.error && <div style={{ color: '#ef5350', fontSize: 12, marginTop: 6 }}>Broker: {broker.error}</div>}
          {!broker.loaded ? <div style={{ color: '#787b86', marginTop: 8 }}>Loading…</div> : broker.positions.length === 0 ? (
            <div style={{ color: '#787b86', marginTop: 8 }}>No positions at the broker today.</div>
          ) : (
            <div style={{ overflowX: 'auto', marginTop: 8 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead><tr>
                  <th style={th}>Symbol</th><th style={th}>Status</th><th style={th}>Net qty</th><th style={th}>Lots</th>
                  <th style={th}>Buy avg</th><th style={th}>Sell avg</th><th style={th}>LTP</th><th style={th}>P&amp;L</th>
                  <th style={th}>Target / SL pt</th><th style={th} colSpan={2}></th>
                </tr></thead>
                <tbody>
                  {broker.positions.map((p) => {
                    const netqty = Number(p.netqty) || 0
                    const open = netqty !== 0
                    const pnl = Number(p.pnl ?? (Number(p.realised || 0) + Number(p.unrealised || 0)))
                    const tracked = (data.storeorder || []).find((o) => o.symbol === p.tradingsymbol)
                    const since = (data.fetchdata || []).filter((t) => t.script === p.tradingsymbol).map((t) => t.createddate).sort().at(-1)
                    const pAlert = open ? latestOrderAlert(alerts, p.tradingsymbol, since) : null
                    const hi = pAlert ? ORDER_ALERT_STYLE[pAlert.kind].color : null
                    const busy = savingOrder === p.tradingsymbol
                    return (
                      <Fragment key={`${p.tradingsymbol}-${p.producttype}`}>
                        <tr style={hi ? { background: `${hi}1f`, boxShadow: `inset 3px 0 0 ${hi}` } : undefined}>
                          <td style={td}>{p.tradingsymbol}</td>
                          <td style={{ ...td, color: open ? '#26a69a' : '#787b86' }}>{open ? (netqty > 0 ? 'Open (long)' : 'Open (short)') : 'Closed'}</td>
                          <td style={td}>{netqty}</td>
                          <td style={td}>{Number(p.lotsize) ? Math.abs(netqty) / Number(p.lotsize) : '—'}</td>
                          <td style={td}>{p.buyavgprice}</td>
                          <td style={td}>{p.sellavgprice}</td>
                          <td style={td}>{p.ltp}</td>
                          <td style={{ ...td, color: profitColor(pnl) }}>{Number.isFinite(pnl) ? pnl.toFixed(2) : '—'}</td>
                          <td style={td}>{tracked ? `${tracked.targetpoint} / ${tracked.stoplosspoint}` : '—'}</td>
                          <td style={td}>
                            {open && (
                              <button onClick={() => viewOnChart(p.tradingsymbol)} disabled={chartLoading === p.tradingsymbol} style={{ ...input, cursor: 'pointer', width: 'auto' }}>
                                {chartLoading === p.tradingsymbol ? '…' : 'View chart'}
                              </button>
                            )}
                          </td>
                          <td style={td}>
                            {open && tracked && tracked.orderterm !== 'exit' && (
                              <button onClick={() => exitOrder(p.tradingsymbol)} disabled={busy} style={{ ...input, cursor: 'pointer', width: 'auto' }}>
                                {busy ? '…' : 'Exit'}
                              </button>
                            )}
                          </td>
                        </tr>
                        {pAlert && (
                          <tr style={{ background: `${hi}14` }}>
                            <td style={td} colSpan={11}><OrderAlert alert={pAlert} /></td>
                          </tr>
                        )}
                      </Fragment>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {brokerMode && broker.orders.length > 0 && (
        <div style={box}>
          <b>Trade history — from broker order book (today)</b>
          <div style={{ overflowX: 'auto', marginTop: 8 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead><tr>
                <th style={th}>Time</th><th style={th}>Symbol</th><th style={th}>Side</th><th style={th}>Qty</th>
                <th style={th}>Filled</th><th style={th}>Avg price</th><th style={th}>Status</th><th style={th}>Broker message</th>
              </tr></thead>
              <tbody>
                {[...broker.orders].sort((a, b) => String(b.updatetime || '').localeCompare(String(a.updatetime || ''))).map((o) => {
                  const st = (o.status || o.orderstatus || '').toLowerCase()
                  return (
                    <tr key={o.orderid || `${o.tradingsymbol}-${o.updatetime}`}>
                      <td style={td}>{o.updatetime || o.exchtime || '—'}</td>
                      <td style={td}>{o.tradingsymbol}</td>
                      <td style={{ ...td, color: o.transactiontype === 'BUY' ? '#26a69a' : '#ef5350' }}>{o.transactiontype}</td>
                      <td style={td}>{o.quantity}</td>
                      <td style={td}>{o.filledshares ?? '—'}</td>
                      <td style={td}>{o.averageprice}</td>
                      <td style={{ ...td, color: st === 'complete' ? '#26a69a' : st === 'rejected' || st === 'cancelled' ? '#ef5350' : '#d1d4dc' }}>{o.status || o.orderstatus}</td>
                      <td style={{ ...td, color: '#787b86' }}>{o.text || ''}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {!brokerMode && data.storeorder?.length > 0 && (
        <div style={box}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <b>Open / recent orders</b>
            <button
              onClick={deleteAllOrders} disabled={savingOrder === '__all__'}
              style={{ ...input, cursor: 'pointer', width: 'auto', borderColor: '#ef5350', color: '#ef5350' }}
            >
              {savingOrder === '__all__' ? 'Deleting…' : 'Delete all'}
            </button>
          </div>
          <div style={{ overflowX: 'auto', marginTop: 8 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead><tr>
                <th style={th}>Symbol</th><th style={th}>Status</th><th style={th}>Term</th><th style={th}>Trend</th>
                <th style={th}>Profit</th><th style={th}>Stoploss pt</th><th style={th}>Target pt</th><th style={th} colSpan={4}></th>
              </tr></thead>
              <tbody>
                {data.storeorder.map((o) => {
                  const edit = orderEdits[o.symbol] || { stoplosspoint: o.stoplosspoint, targetpoint: o.targetpoint }
                  const busy = savingOrder === o.symbol || savingOrder === '__all__'
                  // Entry time of this symbol's newest trade in today's history, so
                  // alerts from an earlier position on the same symbol don't show.
                  const since = (data.fetchdata || []).filter((t) => t.script === o.symbol).map((t) => t.createddate).sort().at(-1)
                  // Only open positions, and only the newest alert.
                  const oAlert = o.orderterm === 'hold' ? latestOrderAlert(alerts, o.symbol, since) : null
                  const hi = oAlert ? ORDER_ALERT_STYLE[oAlert.kind].color : null
                  return (
                    <Fragment key={o.symbol}>
                    <tr style={hi ? { background: `${hi}1f`, boxShadow: `inset 3px 0 0 ${hi}` } : undefined}>
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
                        {o.orderterm === 'hold' && (
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
                    {oAlert && (
                      <tr style={{ background: `${hi}14` }}>
                        <td style={td} colSpan={11}><OrderAlert alert={oAlert} /></td>
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

      {market === 'crypto' && (
        <div style={box}>
          <b>Search options contracts</b>
          <div style={{ color: '#787b86', fontSize: 11, marginTop: 2, marginBottom: 8 }}>
            Real, currently-live DeltaEx contracts — not TradingView (it only lists CME's unrelated bitcoin options).
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <select style={{ ...input, width: 90 }} value={cryptoUnderlying} onChange={(e) => setCryptoUnderlying(e.target.value)}>
              <option value="BTC">BTC</option>
              <option value="ETH">ETH</option>
            </select>
            <input
              style={{ ...input, width: 160 }} placeholder="strike or symbol"
              value={cryptoQuery} onChange={(e) => setCryptoQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && searchCryptoOptions()}
            />
            <button onClick={searchCryptoOptions} disabled={cryptoSearchBusy} style={{ ...input, cursor: 'pointer', width: 'auto', background: '#2a2e39' }}>
              {cryptoSearchBusy ? 'Searching…' : 'Search'}
            </button>
          </div>
          {cryptoResults && (
            <div style={{ overflowX: 'auto', marginTop: 10, maxHeight: 260, overflowY: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead><tr>
                  <th style={th}>Symbol</th><th style={th}>Type</th><th style={th}>Strike</th><th style={th}>Expiry</th><th style={th}></th>
                </tr></thead>
                <tbody>
                  {cryptoResults.length === 0 ? (
                    <tr><td colSpan={5} style={{ ...td, color: '#787b86' }}>No live contracts matched.</td></tr>
                  ) : cryptoResults.map((r) => (
                    <tr key={r.symbol}>
                      <td style={td}>{r.symbol}</td>
                      <td style={{ ...td, color: r.type === 'call' ? '#26a69a' : '#ef5350' }}>{r.type}</td>
                      <td style={td}>{r.strike}</td>
                      <td style={td}>{new Date(r.expiry).toLocaleDateString()}</td>
                      <td style={td}>
                        <button
                          onClick={() => onViewOnChart({ symbol: r.symbol, label: `${r.symbol} — ${r.description}` })}
                          style={{ ...input, cursor: 'pointer', width: 'auto' }}
                        >
                          View chart
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
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

      {!brokerMode && data.fetchdata?.length > 0 && (
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
          <input type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} style={{ ...input, marginRight: 8 }} />
          <b>{month} — {data.monthwisedata.totalOrder} orders, {data.monthwisedata.stoplossOrder} stoplosses, total <span style={{ color: profitColor(data.monthwisedata.totalProfit) }}>{data.monthwisedata.totalProfit}</span></b>
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
