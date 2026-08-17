import { useEffect, useRef, useState } from 'react'
import { createChart, CandlestickSeries, LineSeries, LineStyle } from 'lightweight-charts'
import { parseContract, normalizeContract } from './contracts'
import AiChat from './AiChat'

const INTERVALS = ['1m', '5m', '15m', '1h', '4h', '1d']
const RESOLUTION = { '1m': '1', '5m': '5', '15m': '15', '1h': '60', '4h': '240', '1d': 'D' }
const INTERVAL_SECONDS = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400 }
const API = 'http://localhost:4001'
const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1]
const EMA_COLORS = ['#2962ff', '#ff6d00', '#00c853', '#e91e63', '#9c27b0', '#00bcd4']

function computeEMA(candles, period) {
  const k = 2 / (period + 1)
  let prev
  return candles.map((c, i) => {
    prev = i === 0 ? c.close : c.close * k + prev * (1 - k)
    return { time: c.time, value: prev }
  })
}

function formatCountdown(seconds) {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`
}

function profitColor(v) {
  return v > 0 ? '#26a69a' : v < 0 ? '#ef5350' : '#787b86'
}

function computeLevels(order) {
  if (order.entryPrice == null) return null
  const entry = order.entryPrice
  const t = Number(order.targetpoint)
  const s = Number(order.stoplosspoint)
  const isBuy = order.trend === 'buy'
  return { entry, target: isBuy ? entry + t : entry - t, stoploss: isBuy ? entry - s : entry + s }
}

export default function Chart({ jump, onJumpConsumed, market = 'india', defaultSymbol = 'NSE:NIFTY', defaultLabel = 'NSE:NIFTY' }) {
  const containerRef = useRef(null)
  const chartRef = useRef(null)
  const seriesRef = useRef(null)
  const tradingPrefix = market === 'crypto' ? '/api/crypto/trading' : '/api/trading'
  const [symbol, setSymbol] = useState(defaultSymbol)
  const [label, setLabel] = useState(defaultLabel)
  const [interval, setInterval_] = useState('15m')
  const [price, setPrice] = useState(null)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState([])
  const [optionsOnly, setOptionsOnly] = useState(false)
  const [nextClose, setNextClose] = useState(null)
  const [now, setNow] = useState(() => Date.now() / 1000)
  const [chain, setChain] = useState(null)
  const [chainLoading, setChainLoading] = useState(false)
  const [pendingOrders, setPendingOrders] = useState([])
  const [orderEdit, setOrderEdit] = useState({ stoplosspoint: '', targetpoint: '' })
  const [orderBusy, setOrderBusy] = useState(false)
  const priceLinesRef = useRef([])
  const candlesRef = useRef([])
  const [aiOpen, setAiOpen] = useState(false)
  const [alerts, setAlerts] = useState(() => {
    try { return JSON.parse(localStorage.getItem('chartAlerts') || '[]') } catch { return [] }
  })
  const [showAlertForm, setShowAlertForm] = useState(false)
  const [alertForm, setAlertForm] = useState({ price: '', message: '' })
  const [toasts, setToasts] = useState([])
  const alertsRef = useRef(alerts)
  const alertLinesRef = useRef([])
  const lastPriceRef = useRef(null)
  const [tool, setTool] = useState(null)
  const [trendArmed, setTrendArmed] = useState(false)
  const [fibArmed, setFibArmed] = useState(false)
  const [drawings, setDrawings] = useState([])
  const toolRef = useRef(null)
  const symbolRef = useRef(symbol)
  const fibFirstRef = useRef(null)
  const trendFirstRef = useRef(null)
  const drawLinesRef = useRef([])
  const trendSeriesRef = useRef({})
  const [emas, setEmas] = useState([])
  const [showEmaForm, setShowEmaForm] = useState(false)
  const [emaPeriod, setEmaPeriod] = useState('20')
  const emaSeriesRef = useRef({})

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now() / 1000), 1000)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    toolRef.current = tool
    if (tool !== 'fib') { fibFirstRef.current = null; setFibArmed(false) }
    if (tool !== 'trend') { trendFirstRef.current = null; setTrendArmed(false) }
  }, [tool])
  useEffect(() => { symbolRef.current = symbol }, [symbol])

  useEffect(() => {
    localStorage.setItem('chartAlerts', JSON.stringify(alerts))
    alertsRef.current = alerts
  }, [alerts])

  useEffect(() => {
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      Notification.requestPermission()
    }
  }, [])

  function checkAlerts(newPrice, sym) {
    const prev = lastPriceRef.current
    lastPriceRef.current = newPrice
    if (prev == null) return
    const hits = alertsRef.current.filter(
      (a) => a.symbol === sym && ((prev < a.price && newPrice >= a.price) || (prev > a.price && newPrice <= a.price))
    )
    if (hits.length === 0) return
    hits.forEach((a) => {
      const text = `${a.symbol} @ ${a.price}${a.message ? ' — ' + a.message : ''}`
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        new Notification('Price alert', { body: text })
      }
      fetch(`${API}/api/telegram/alert`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: `🔔 Price alert: ${text}` }),
      }).catch(() => {})
      setToasts((t) => [...t, { id: a.id, text }])
      setTimeout(() => setToasts((t) => t.filter((x) => x.id !== a.id)), 6000)
    })
    setAlerts((prevAlerts) => prevAlerts.filter((a) => !hits.some((h) => h.id === a.id)))
  }

  function addAlert() {
    const p = parseFloat(alertForm.price)
    if (!Number.isFinite(p)) return
    setAlerts((a) => [...a, { id: Date.now(), symbol, price: p, message: alertForm.message.trim() }])
    setShowAlertForm(false)
  }

  async function loadPendingOrders() {
    const res = await fetch(`${API}${tradingPrefix}/pending-orders`)
    const data = await res.json()
    if (data.status === 'success') setPendingOrders(data.orders)
  }

  useEffect(() => {
    loadPendingOrders()
    const id = setInterval(loadPendingOrders, 3000)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    if (!jump) return
    setSymbol(jump.symbol)
    setLabel(jump.label)
    onJumpConsumed?.()
  }, [jump])

  useEffect(() => {
    const chart = createChart(containerRef.current, {
      layout: { background: { color: '#131722' }, textColor: '#d1d4dc' },
      grid: { vertLines: { color: '#1e222d' }, horzLines: { color: '#1e222d' } },
      timeScale: { timeVisible: true, borderColor: '#2a2e39' },
      rightPriceScale: { borderColor: '#2a2e39' },
      autoSize: true,
    })
    const series = chart.addSeries(CandlestickSeries, {
      upColor: '#26a69a', downColor: '#ef5350',
      borderVisible: false,
      wickUpColor: '#26a69a', wickDownColor: '#ef5350',
    })
    chartRef.current = chart
    seriesRef.current = series

    chart.subscribeClick((param) => {
      if (!toolRef.current || !param.point) return
      const price = series.coordinateToPrice(param.point.y)
      if (price == null) return
      if (toolRef.current === 'sr') {
        setDrawings((d) => [...d, { id: Date.now(), symbol: symbolRef.current, type: 'sr', price }])
        setTool(null)
      } else if (toolRef.current === 'fib') {
        if (fibFirstRef.current == null) {
          fibFirstRef.current = price
          setFibArmed(true)
        } else {
          const high = Math.max(fibFirstRef.current, price)
          const low = Math.min(fibFirstRef.current, price)
          setDrawings((d) => [...d, { id: Date.now(), symbol: symbolRef.current, type: 'fib', high, low }])
          fibFirstRef.current = null
          setFibArmed(false)
          setTool(null)
        }
      } else if (toolRef.current === 'trend') {
        const time = param.time ?? chart.timeScale().coordinateToTime(param.point.x)
        if (time == null) return
        if (trendFirstRef.current == null) {
          trendFirstRef.current = { time, price }
          setTrendArmed(true)
        } else if (time !== trendFirstRef.current.time) {
          const [p1, p2] = time < trendFirstRef.current.time
            ? [{ time, price }, trendFirstRef.current]
            : [trendFirstRef.current, { time, price }]
          setDrawings((d) => [...d, { id: Date.now(), symbol: symbolRef.current, type: 'trend', p1, p2 }])
          trendFirstRef.current = null
          setTrendArmed(false)
          setTool(null)
        }
      }
    })

    return () => chart.remove()
  }, [])

  useEffect(() => {
    const series = seriesRef.current
    const chart = chartRef.current
    if (!series || !chart) return
    drawLinesRef.current.forEach((l) => series.removePriceLine(l))
    drawLinesRef.current = []
    Object.values(trendSeriesRef.current).forEach((s) => chart.removeSeries(s))
    trendSeriesRef.current = {}
    drawings.filter((d) => d.symbol === symbol).forEach((d) => {
      try {
        if (d.type === 'sr') {
          drawLinesRef.current.push(series.createPriceLine({
            price: d.price, color: d.color || '#787b86', lineWidth: 1, lineStyle: LineStyle.Solid,
            axisLabelVisible: true, title: d.label || 'S/R',
          }))
        } else if (d.type === 'ai-trade') {
          const lines = [
            d.entry != null && { price: d.entry, color: '#787b86', style: LineStyle.Dotted, title: 'AI Entry' },
            d.target != null && { price: d.target, color: '#26a69a', style: LineStyle.Dashed, title: 'AI Target' },
            d.stoploss != null && { price: d.stoploss, color: '#ef5350', style: LineStyle.Dashed, title: 'AI Stoploss' },
          ].filter(Boolean)
          lines.forEach((l) => drawLinesRef.current.push(series.createPriceLine({
            price: l.price, color: l.color, lineWidth: 1, lineStyle: l.style, axisLabelVisible: true, title: l.title,
          })))
        } else if (d.type === 'fib') {
          FIB_LEVELS.forEach((lvl) => {
            const price = d.high - (d.high - d.low) * lvl
            drawLinesRef.current.push(series.createPriceLine({
              price, color: '#f0b90b', lineWidth: 1, lineStyle: LineStyle.Dotted,
              axisLabelVisible: true, title: `Fib ${lvl}`,
            }))
          })
        } else if (d.type === 'trend') {
          const line = chart.addSeries(LineSeries, {
            color: '#2196f3', lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
          })
          line.setData([{ time: d.p1.time, value: d.p1.price }, { time: d.p2.time, value: d.p2.price }])
          trendSeriesRef.current[d.id] = line
        }
      } catch (err) {
        console.error('Failed to render drawing, skipping', d, err)
      }
    })
  }, [drawings, symbol])

  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return
    const liveIds = new Set(emas.map((e) => e.id))
    Object.keys(emaSeriesRef.current).forEach((id) => {
      if (!liveIds.has(Number(id))) {
        chart.removeSeries(emaSeriesRef.current[id])
        delete emaSeriesRef.current[id]
      }
    })
    const candles = candlesRef.current
    emas.forEach((e) => {
      let line = emaSeriesRef.current[e.id]
      if (!line) {
        line = chart.addSeries(LineSeries, {
          color: e.color, lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
        })
        emaSeriesRef.current[e.id] = line
      }
      line.setData(computeEMA(candles, e.period))
    })
  }, [emas, symbol, price])

  useEffect(() => {
    if (query.trim().length < 2) { setResults([]); return }
    let cancelled = false
    const id = setTimeout(async () => {
      const type = optionsOnly ? '&type=options' : ''
      const res = await fetch(`${API}/api/search?query=${encodeURIComponent(query)}${type}`)
      const data = await res.json()
      if (!cancelled && data.success) setResults(data.results)
    }, 300)
    return () => { cancelled = true; clearTimeout(id) }
  }, [query, optionsOnly])

  useEffect(() => {
    let cancelled = false
    let pollId

    async function load() {
      lastPriceRef.current = null
      const resolution = RESOLUTION[interval]
      const res = await fetch(`${API}/api/ohlcv?symbol=${encodeURIComponent(symbol)}&resolution=${resolution}&count=500`)
      const data = await res.json()
      if (cancelled || !data.success) return
      const candles = data.bars.map((b) => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close }))
      seriesRef.current.setData(candles)
      candlesRef.current = candles
      setPrice(candles.at(-1)?.close ?? null)
      setNextClose(candles.at(-1) ? candles.at(-1).time + INTERVAL_SECONDS[interval] : null)
      lastPriceRef.current = candles.at(-1)?.close ?? null
      chartRef.current.timeScale().fitContent()

      pollId = setInterval(async () => {
        const r = await fetch(`${API}/api/quote?symbol=${encodeURIComponent(symbol)}`)
        const q = await r.json()
        if (cancelled || !q.success) return
        seriesRef.current.update({ time: q.time, open: q.open, high: q.high, low: q.low, close: q.close })
        candlesRef.current = [...candlesRef.current.slice(0, -1), { time: q.time, open: q.open, high: q.high, low: q.low, close: q.close }]
        setPrice(q.close)
        setNextClose(q.time + INTERVAL_SECONDS[interval])
        checkAlerts(q.close, symbol)
      }, 3000)
    }

    load()

    return () => {
      cancelled = true
      clearInterval(pollId)
    }
  }, [symbol, interval])

  const rawSymbol = symbol.includes(':') ? symbol.split(':')[1] : symbol
  const chartContract = normalizeContract(parseContract(rawSymbol))
  const matchedOrder = chartContract
    ? pendingOrders.find((o) => {
        const oc = normalizeContract(parseContract(o.symbol))
        return oc && oc.underlying === chartContract.underlying && oc.strike === chartContract.strike && oc.right === chartContract.right
      })
    : null

  useEffect(() => {
    if (matchedOrder) setOrderEdit({ stoplosspoint: matchedOrder.stoplosspoint, targetpoint: matchedOrder.targetpoint })
  }, [matchedOrder?.symbol, matchedOrder?.stoplosspoint, matchedOrder?.targetpoint])

  useEffect(() => {
    const series = seriesRef.current
    if (!series) return
    priceLinesRef.current.forEach((l) => series.removePriceLine(l))
    priceLinesRef.current = []

    const levels = matchedOrder && computeLevels(matchedOrder)
    if (!levels) return
    priceLinesRef.current.push(
      series.createPriceLine({ price: levels.entry, color: '#787b86', lineWidth: 1, lineStyle: LineStyle.Dotted, axisLabelVisible: true, title: 'Entry' }),
      series.createPriceLine({ price: levels.target, color: '#26a69a', lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: 'Target' }),
      series.createPriceLine({ price: levels.stoploss, color: '#ef5350', lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: 'Stoploss' }),
    )
  }, [matchedOrder?.symbol, matchedOrder?.entryPrice, matchedOrder?.stoplosspoint, matchedOrder?.targetpoint, matchedOrder?.trend])

  useEffect(() => {
    const series = seriesRef.current
    if (!series) return
    alertLinesRef.current.forEach((l) => series.removePriceLine(l))
    alertLinesRef.current = alerts
      .filter((a) => a.symbol === symbol)
      .map((a) => series.createPriceLine({
        price: a.price, color: '#f0b90b', lineWidth: 1, lineStyle: LineStyle.Dashed,
        axisLabelVisible: true, title: a.message ? `Alert: ${a.message}` : 'Alert',
      }))
  }, [alerts, symbol])

  async function saveOrderEdit() {
    setOrderBusy(true)
    await fetch(`${API}${tradingPrefix}/order`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol: matchedOrder.symbol, stoplosspoint: orderEdit.stoplosspoint, targetpoint: orderEdit.targetpoint }),
    })
    await loadPendingOrders()
    setOrderBusy(false)
  }

  async function exitMatchedOrder() {
    setOrderBusy(true)
    await fetch(`${API}${tradingPrefix}/exit-order`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol: matchedOrder.symbol }),
    })
    await loadPendingOrders()
    setOrderBusy(false)
  }

  function pick(r) {
    setSymbol(`${r.exchange}:${r.symbol}`)
    setLabel(`${r.exchange}:${r.symbol} — ${r.description}`)
    setQuery('')
    setResults([])
  }

  async function openChain() {
    const [exchange, underlying] = symbol.split(':')
    setChain(null)
    setChainLoading(true)
    const res = await fetch(`${API}/api/option-chain?underlying=${encodeURIComponent(underlying)}&exchange=${encodeURIComponent(exchange)}`)
    const data = await res.json()
    setChainLoading(false)
    setChain(data.success ? data : { error: true })
  }

  function addAiDrawings(data) {
    const sym = symbolRef.current
    const levelDrawings = (data.levels || []).map((l, i) => ({
      id: Date.now() + i, symbol: sym, type: 'sr', price: l.price,
      color: l.type === 'support' ? '#26a69a' : '#ef5350',
      label: `${l.type === 'support' ? 'Support' : 'Resistance'}${l.label ? ': ' + l.label : ''}`,
    }))
    const t = data.trade
    const tradeDrawing = t && (t.entry != null || t.target != null || t.stoploss != null)
      ? [{ id: Date.now() + levelDrawings.length, symbol: sym, type: 'ai-trade', entry: t.entry, target: t.target, stoploss: t.stoploss, direction: t.direction }]
      : []
    setDrawings((d) => [...d, ...levelDrawings, ...tradeDrawing])
  }

  function pickLeg(exchange, sym) {
    setSymbol(`${exchange}:${sym}`)
    setLabel(`${exchange}:${sym}`)
    setChain(null)
  }

  return (
    <div style={{ height: '100%', minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', background: '#131722', position: 'relative' }}>
      <div style={{ display: 'flex', gap: 12, padding: '8px 12px', alignItems: 'center', borderBottom: '1px solid #2a2e39', position: 'relative' }}>
        <div style={{ position: 'relative' }}>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={optionsOnly ? 'e.g. NIFTY 24300 CE' : 'Search stocks, options, crypto...'}
            style={{ background: '#1e222d', color: '#d1d4dc', border: '1px solid #2a2e39', borderRadius: 4, padding: '6px 10px', width: 260 }}
          />
          {results.length > 0 && (
            <div style={{ position: 'absolute', top: '100%', left: 0, width: 360, maxHeight: 320, overflowY: 'auto', background: '#1e222d', border: '1px solid #2a2e39', zIndex: 10 }}>
              {results.map((r, i) => (
                <div
                  key={i}
                  onClick={() => pick(r)}
                  style={{ padding: '6px 10px', cursor: 'pointer', color: '#d1d4dc', borderBottom: '1px solid #2a2e39' }}
                  onMouseEnter={(e) => e.currentTarget.style.background = '#2a2e39'}
                  onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                >
                  <div>{r.exchange}:{r.symbol} <span style={{ color: '#787b86', fontSize: 11 }}>{r.type}</span></div>
                  <div style={{ fontSize: 12, color: '#787b86' }}>{r.description}</div>
                </div>
              ))}
            </div>
          )}
        </div>
        {market !== 'crypto' && (
          <>
            <label style={{ color: '#d1d4dc', fontSize: 13, display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
              <input type="checkbox" checked={optionsOnly} onChange={(e) => setOptionsOnly(e.target.checked)} />
              Options
            </label>
            <button
              onClick={openChain}
              style={{ background: 'transparent', color: '#d1d4dc', border: '1px solid #2a2e39', borderRadius: 4, padding: '4px 10px', cursor: 'pointer', fontSize: 13 }}
            >
              Chain
            </button>
          </>
        )}
        <span style={{ color: '#d1d4dc' }}>{label}</span>
        <select value={interval} onChange={(e) => setInterval_(e.target.value)}>
          {INTERVALS.map((i) => <option key={i} value={i}>{i}</option>)}
        </select>
        {nextClose != null && (
          <span style={{ color: '#787b86', fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>
            {formatCountdown(Math.max(0, Math.round(nextClose - now)))}
          </span>
        )}
        <span style={{ color: '#d1d4dc', marginLeft: 'auto', fontVariantNumeric: 'tabular-nums' }}>
          {price != null ? price.toLocaleString() : '...'}
        </span>
        <div style={{ position: 'relative' }}>
          <button
            onClick={() => { setAlertForm({ price: price != null ? String(price) : '', message: '' }); setShowAlertForm((v) => !v) }}
            style={{ background: showAlertForm ? '#2a2e39' : 'transparent', color: '#d1d4dc', border: '1px solid #2a2e39', borderRadius: 4, padding: '4px 10px', cursor: 'pointer', fontSize: 13 }}
          >
            Alert
          </button>
          {showAlertForm && (
            <div style={{ position: 'absolute', top: '100%', right: 0, marginTop: 4, background: '#1e222d', border: '1px solid #2a2e39', borderRadius: 6, padding: 10, fontSize: 12, color: '#d1d4dc', zIndex: 16, width: 200 }}>
              <div style={{ marginBottom: 6, fontWeight: 600 }}>New alert</div>
              <label style={{ display: 'block', marginBottom: 6 }}>
                Price
                <input
                  value={alertForm.price}
                  onChange={(e) => setAlertForm({ ...alertForm, price: e.target.value })}
                  style={{ width: '100%', boxSizing: 'border-box', background: '#131722', color: '#d1d4dc', border: '1px solid #2a2e39', borderRadius: 4, padding: '4px 6px', marginTop: 2 }}
                />
              </label>
              <label style={{ display: 'block', marginBottom: 8 }}>
                Message
                <input
                  value={alertForm.message}
                  onChange={(e) => setAlertForm({ ...alertForm, message: e.target.value })}
                  placeholder="optional"
                  style={{ width: '100%', boxSizing: 'border-box', background: '#131722', color: '#d1d4dc', border: '1px solid #2a2e39', borderRadius: 4, padding: '4px 6px', marginTop: 2 }}
                />
              </label>
              <div style={{ display: 'flex', gap: 6 }}>
                <button onClick={addAlert} disabled={!alertForm.price} style={{ flex: 1, background: '#2a2e39', color: '#d1d4dc', border: '1px solid #2a2e39', borderRadius: 4, padding: '4px 0', cursor: 'pointer' }}>
                  Add
                </button>
                <button onClick={() => setShowAlertForm(false)} style={{ flex: 1, background: 'transparent', color: '#787b86', border: '1px solid #2a2e39', borderRadius: 4, padding: '4px 0', cursor: 'pointer' }}>
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
        <button
          onClick={() => setTool((t) => t === 'sr' ? null : 'sr')}
          title="Click chart to place a support/resistance line"
          style={{ background: tool === 'sr' ? '#2a2e39' : 'transparent', color: '#d1d4dc', border: '1px solid #2a2e39', borderRadius: 4, padding: '4px 10px', cursor: 'pointer', fontSize: 13 }}
        >
          S/R
        </button>
        <button
          onClick={() => setTool((t) => t === 'fib' ? null : 'fib')}
          title="Click two points on the chart (swing high, swing low)"
          style={{ background: tool === 'fib' ? '#2a2e39' : 'transparent', color: '#d1d4dc', border: '1px solid #2a2e39', borderRadius: 4, padding: '4px 10px', cursor: 'pointer', fontSize: 13 }}
        >
          Fib
        </button>
        <button
          onClick={() => setTool((t) => t === 'trend' ? null : 'trend')}
          title="Click two points on the chart to draw a trendline"
          style={{ background: tool === 'trend' ? '#2a2e39' : 'transparent', color: '#d1d4dc', border: '1px solid #2a2e39', borderRadius: 4, padding: '4px 10px', cursor: 'pointer', fontSize: 13 }}
        >
          Trend
        </button>
        <div style={{ position: 'relative' }}>
          <button
            onClick={() => setShowEmaForm((v) => !v)}
            style={{ background: showEmaForm ? '#2a2e39' : 'transparent', color: '#d1d4dc', border: '1px solid #2a2e39', borderRadius: 4, padding: '4px 10px', cursor: 'pointer', fontSize: 13 }}
          >
            EMA
          </button>
          {showEmaForm && (
            <div style={{ position: 'absolute', top: '100%', left: 0, marginTop: 4, background: '#1e222d', border: '1px solid #2a2e39', borderRadius: 6, padding: 10, fontSize: 12, color: '#d1d4dc', zIndex: 16, width: 180 }}>
              <div style={{ marginBottom: 6, fontWeight: 600 }}>EMAs</div>
              {emas.map((e) => (
                <div key={e.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ width: 10, height: 10, borderRadius: '50%', background: e.color, display: 'inline-block' }} />
                    EMA {e.period}
                  </span>
                  <span onClick={() => setEmas((all) => all.filter((x) => x.id !== e.id))} style={{ cursor: 'pointer', color: '#787b86' }}>✕</span>
                </div>
              ))}
              <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                <input
                  type="number"
                  value={emaPeriod}
                  onChange={(e) => setEmaPeriod(e.target.value)}
                  style={{ width: 60, boxSizing: 'border-box', background: '#131722', color: '#d1d4dc', border: '1px solid #2a2e39', borderRadius: 4, padding: '4px 6px' }}
                />
                <button
                  onClick={() => {
                    const period = parseInt(emaPeriod, 10)
                    if (!Number.isFinite(period) || period < 1) return
                    const color = EMA_COLORS[emas.length % EMA_COLORS.length]
                    setEmas((all) => [...all, { id: Date.now(), period, color }])
                  }}
                  style={{ flex: 1, background: '#2a2e39', color: '#d1d4dc', border: '1px solid #2a2e39', borderRadius: 4, padding: '4px 0', cursor: 'pointer' }}
                >
                  Add
                </button>
              </div>
            </div>
          )}
        </div>
        <button
          onClick={() => setAiOpen((v) => !v)}
          style={{ background: aiOpen ? '#2a2e39' : 'transparent', color: '#d1d4dc', border: '1px solid #2a2e39', borderRadius: 4, padding: '4px 10px', cursor: 'pointer', fontSize: 13 }}
        >
          AI
        </button>
      </div>
      <div ref={containerRef} style={{ flex: 1, minWidth: 0, minHeight: 0 }} />

      {tool && (
        <div style={{ position: 'absolute', top: 44, left: '50%', transform: 'translateX(-50%)', zIndex: 15, background: '#f0b90b', color: '#131722', padding: '4px 10px', borderRadius: 6, fontSize: 12, fontWeight: 600 }}>
          {tool === 'sr'
            ? 'Click chart to place S/R line'
            : tool === 'fib'
              ? (fibArmed ? 'Click the other point' : 'Click swing high or low')
              : (trendArmed ? 'Click the trendline end' : 'Click the trendline start')}
        </div>
      )}

      {(drawings.some((d) => d.symbol === symbol) || alerts.some((a) => a.symbol === symbol)) && (
        <div style={{ position: 'absolute', top: 44, left: 8, zIndex: 15, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {drawings.some((d) => d.symbol === symbol) && (
            <div style={{ background: '#1e222d', border: '1px solid #2a2e39', borderRadius: 6, padding: 8, fontSize: 12, color: '#d1d4dc', minWidth: 160 }}>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>Drawings</div>
              {drawings.filter((d) => d.symbol === symbol).map((d) => (
                <div key={d.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                  <span>
                    {d.type === 'sr' ? `${d.label || 'S/R'} ${d.price.toFixed(2)}`
                      : d.type === 'ai-trade' ? `AI trade: ${d.direction}`
                      : d.type === 'fib' ? `Fib ${d.low.toFixed(2)}–${d.high.toFixed(2)}`
                      : `Trend ${d.p1.price.toFixed(2)}→${d.p2.price.toFixed(2)}`}
                  </span>
                  <span
                    onClick={() => setDrawings((all) => all.filter((x) => x.id !== d.id))}
                    style={{ cursor: 'pointer', color: '#787b86' }}
                  >
                    ✕
                  </span>
                </div>
              ))}
            </div>
          )}
          {alerts.some((a) => a.symbol === symbol) && (
            <div style={{ background: '#1e222d', border: '1px solid #2a2e39', borderRadius: 6, padding: 8, fontSize: 12, color: '#d1d4dc', minWidth: 160 }}>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>Alerts</div>
              {alerts.filter((a) => a.symbol === symbol).map((a) => (
                <div key={a.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                  <span>{a.price}{a.message ? ` — ${a.message}` : ''}</span>
                  <span
                    onClick={() => setAlerts((all) => all.filter((x) => x.id !== a.id))}
                    style={{ cursor: 'pointer', color: '#787b86' }}
                  >
                    ✕
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {toasts.length > 0 && (
        <div style={{ position: 'absolute', top: 8, left: '50%', transform: 'translateX(-50%)', zIndex: 30, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {toasts.map((t) => (
            <div key={t.id} style={{ background: '#f0b90b', color: '#131722', padding: '8px 14px', borderRadius: 6, fontSize: 13, fontWeight: 600, boxShadow: '0 2px 8px rgba(0,0,0,0.3)' }}>
              🔔 {t.text}
            </div>
          ))}
        </div>
      )}

      {matchedOrder && (
        <div style={{ position: 'absolute', top: 44, right: 8, background: '#1e222d', border: '1px solid #2a2e39', borderRadius: 6, padding: 10, fontSize: 12, color: '#d1d4dc', zIndex: 15, width: 190 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
            <b>Pending order</b>
            <span style={{ color: matchedOrder.trend === 'buy' ? '#26a69a' : '#ef5350' }}>{matchedOrder.trend}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
            <span style={{ color: '#787b86' }}>P&amp;L</span>
            <b style={{ color: profitColor(matchedOrder.profit) }}>{Math.round(matchedOrder.profit)}</b>
          </div>
          {matchedOrder.entryPrice == null ? (
            <div style={{ color: '#787b86' }}>No entry price found for this order.</div>
          ) : (
            <>
              <div style={{ color: '#787b86', marginBottom: 6 }}>Entry {matchedOrder.entryPrice}</div>
              <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                Target pt
                <input
                  value={orderEdit.targetpoint}
                  onChange={(e) => setOrderEdit({ ...orderEdit, targetpoint: e.target.value })}
                  style={{ width: 50, background: '#131722', color: '#d1d4dc', border: '1px solid #2a2e39', borderRadius: 4, padding: '2px 4px' }}
                />
              </label>
              <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                Stoploss pt
                <input
                  value={orderEdit.stoplosspoint}
                  onChange={(e) => setOrderEdit({ ...orderEdit, stoplosspoint: e.target.value })}
                  style={{ width: 50, background: '#131722', color: '#d1d4dc', border: '1px solid #2a2e39', borderRadius: 4, padding: '2px 4px' }}
                />
              </label>
            </>
          )}
          <div style={{ display: 'flex', gap: 6 }}>
            <button onClick={saveOrderEdit} disabled={orderBusy} style={{ flex: 1, background: '#2a2e39', color: '#d1d4dc', border: '1px solid #2a2e39', borderRadius: 4, padding: '4px 0', cursor: 'pointer' }}>
              {orderBusy ? '…' : 'Save'}
            </button>
            <button onClick={exitMatchedOrder} disabled={orderBusy || matchedOrder.orderterm === 'exit'} style={{ flex: 1, background: 'transparent', color: '#ef5350', border: '1px solid #ef5350', borderRadius: 4, padding: '4px 0', cursor: 'pointer' }}>
              {matchedOrder.orderterm === 'exit' ? 'Exited' : 'Exit'}
            </button>
          </div>
        </div>
      )}

      {aiOpen && (
        <AiChat
          symbol={symbol}
          getCandles={() => candlesRef.current}
          takeScreenshot={() => chartRef.current.takeScreenshot().toDataURL('image/png')}
          onAnalysis={addAiDrawings}
          onClose={() => setAiOpen(false)}
        />
      )}

      {(chainLoading || chain) && (
        <div
          onClick={() => { setChain(null); setChainLoading(false) }}
          style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 20 }}
        >
          <div onClick={(e) => e.stopPropagation()} style={{ background: '#1e222d', border: '1px solid #2a2e39', borderRadius: 6, maxHeight: '85%', overflowY: 'auto', minWidth: 360 }}>
            {chainLoading && <div style={{ padding: 24, color: '#d1d4dc' }}>Loading chain… (~10-20s, fetching each strike live)</div>}
            {chain?.error && <div style={{ padding: 24, color: '#ef5350' }}>No option chain found for this symbol.</div>}
            {chain && !chain.error && (
              <table style={{ borderCollapse: 'collapse', color: '#d1d4dc', fontSize: 13 }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid #2a2e39' }}>
                    <th style={{ padding: '8px 12px' }} colSpan={2}>CALL</th>
                    <th style={{ padding: '8px 12px' }}>Strike</th>
                    <th style={{ padding: '8px 12px' }} colSpan={2}>PUT</th>
                  </tr>
                </thead>
                <tbody>
                  {chain.chain.map((row) => (
                    <tr key={row.strike} style={{ background: row.strike === chain.atm ? '#2a2e39' : 'transparent' }}>
                      <td
                        onClick={() => pickLeg(symbol.split(':')[0], row.ce.symbol)}
                        style={{ padding: '6px 12px', cursor: 'pointer', textAlign: 'right' }}
                      >
                        {row.ce.ltp != null ? row.ce.ltp.toLocaleString() : '—'}
                      </td>
                      <td style={{ padding: '6px 4px', color: '#787b86', fontSize: 11 }}>{row.ce.volume != null ? `vol ${Math.round(row.ce.volume)}` : ''}</td>
                      <td style={{ padding: '6px 12px', textAlign: 'center', fontWeight: 600 }}>{row.strike}</td>
                      <td style={{ padding: '6px 4px', color: '#787b86', fontSize: 11 }}>{row.pe.volume != null ? `vol ${Math.round(row.pe.volume)}` : ''}</td>
                      <td
                        onClick={() => pickLeg(symbol.split(':')[0], row.pe.symbol)}
                        style={{ padding: '6px 12px', cursor: 'pointer', textAlign: 'left' }}
                      >
                        {row.pe.ltp != null ? row.pe.ltp.toLocaleString() : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
