import { useEffect, useRef, useState } from 'react'
import { parseContract, normalizeContract } from './contracts'
import { apiFetch } from './api'

const TRADEABLE_UNDERLYINGS = ['NIFTY', 'BANKNIFTY', 'SENSEX']
const OPTION_EXCHANGE = { NIFTY: 'NFO', BANKNIFTY: 'NFO', SENSEX: 'BFO' }

// New component: watches price and places a real order via the standalone
// ai_order_service.py (a separate process, see that file's docstring) only once
// the AI's suggested entry level is actually hit — same crossing check
// Chart.jsx's checkAlerts() uses for price alerts (prev/new straddle the
// target), copied here rather than imported so this stays fully independent
// of Chart.jsx. Fires the same place_order()/withmoney (real vs paper)
// pipeline as before — just gated on the price condition instead of firing
// immediately.
//
// Two modes, told apart by parseContract() on the symbol currently on screen
// (same helper TradingPanel/Chart already use for option symbols):
//  - Option contract on screen (e.g. viewing NFO:NIFTY27JAN2625200PE itself):
//    the AI's entry/target/stoploss are the option's own premium levels, so
//    the order is placed on the *exact* strike/right being viewed, and once
//    filled the stoploss trails the peak premium (entirely client-side —
//    no server-side polling loop). If price falls back to peak minus the
//    original stoploss distance, it exits immediately, same as hitting a
//    fixed stoploss would.
//  - Bare index on screen (e.g. NSE:NIFTY): falls back to the original
//    ATM-from-spot-price entry (ai_enter_order); target/stoploss are index
//    levels, not option-premium points, so there's nothing to trail — shown
//    for reference only.
export default function AiOrderControls({ symbol, direction, entry, target, stoploss, onMessage }) {
  const [pending, setPending] = useState(null) // { entry, ...order params } once queued
  const [trailing, setTrailing] = useState(null) // { symbol, quoteSymbol, distance, peak } once filled
  const [busy, setBusy] = useState(false)
  const lastPriceRef = useRef(null)

  const rawSymbol = symbol.includes(':') ? symbol.split(':')[1] : symbol
  const contract = normalizeContract(parseContract(rawSymbol))
  const isOption = !!contract && TRADEABLE_UNDERLYINGS.includes(contract.underlying)
  const isIndex = !contract && TRADEABLE_UNDERLYINGS.includes(rawSymbol)
  const underlying = isOption ? contract.underlying : rawSymbol

  useEffect(() => {
    // A new suggestion for a different symbol/direction/entry cancels any stale watch.
    setPending(null)
    lastPriceRef.current = null
  }, [symbol, direction, entry])

  // Watch for the AI's entry level to be hit, then place the order.
  useEffect(() => {
    if (!pending) return
    let cancelled = false
    const pollId = setInterval(async () => {
      try {
        const res = await apiFetch(`/api/quote?symbol=${encodeURIComponent(symbol)}`)
        const q = await res.json()
        if (cancelled || !q.success) return
        const prev = lastPriceRef.current
        lastPriceRef.current = q.close
        if (prev == null) return
        const hit = (prev < pending.entry && q.close >= pending.entry) || (prev > pending.entry && q.close <= pending.entry)
        if (!hit) return

        setPending(null)
        setBusy(true)
        const orderRes = await apiFetch(`${pending.endpoint}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(pending.body),
        })
        const d = await orderRes.json()
        if (d.status === 'success') {
          onMessage(`Triggered @ ${q.close}: order placed ${d.symbol} x${d.lotsize} @ ${d.ltp} (id ${d.orderId})`)
          if (pending.stoplossPoint) {
            setTrailing({ symbol: d.symbol, quoteSymbol: `${OPTION_EXCHANGE[underlying]}:${d.symbol}`, distance: pending.stoplossPoint, peak: d.ltp })
            onMessage(`Trailing stoploss armed on ${d.symbol}: exits if price falls back to ${(d.ltp - pending.stoplossPoint).toFixed(2)} or below.`)
          }
        } else {
          onMessage(`Triggered @ ${q.close}, but order failed: ${d.message}`)
        }
        setBusy(false)
      } catch {
        // transient network hiccup — next 3s tick retries
      }
    }, 3000)
    return () => { cancelled = true; clearInterval(pollId) }
  }, [pending, symbol, underlying, onMessage])

  // Trail the stoploss on the filled position: track the peak premium seen so
  // far, exit the moment price falls back to peak - distance. Same as hitting
  // a normal stoploss — on trigger, target/stoploss are set to 0 and the
  // position is closed (see ai_exit_order in ai_order_service.py).
  useEffect(() => {
    if (!trailing) return
    let cancelled = false
    const pollId = setInterval(async () => {
      try {
        const res = await apiFetch(`/api/quote?symbol=${encodeURIComponent(trailing.quoteSymbol)}`)
        const q = await res.json()
        if (cancelled || !q.success) return

        const peak = Math.max(trailing.peak, q.close)
        const stopLevel = peak - trailing.distance
        if (q.close <= stopLevel) {
          setTrailing(null)
          setBusy(true)
          const res2 = await apiFetch(`/api/trading/ai-exit-order`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ underlying }),
          })
          const d = await res2.json()
          onMessage(d.status === 'success' ? `Trailing stoploss hit @ ${stopLevel.toFixed(2)}: exited ${d.symbol} @ ${d.exitPrice} (P/L ${d.profit})` : `Trailing stoploss hit @ ${stopLevel.toFixed(2)}, but exit failed: ${d.message}`)
          setBusy(false)
        } else if (peak !== trailing.peak) {
          setTrailing((t) => (t ? { ...t, peak } : t))
        }
      } catch {
        // transient network hiccup — next 3s tick retries
      }
    }, 3000)
    return () => { cancelled = true; clearInterval(pollId) }
  }, [trailing, underlying, onMessage])

  if (!(isOption || isIndex) || (direction !== 'buy_ce' && direction !== 'buy_pe')) return null

  function queueOrder() {
    if (busy || entry == null) return
    const stoplossPoint = isOption && stoploss != null ? Math.abs(entry - stoploss) : null
    const watch = isOption
      ? {
          entry,
          endpoint: '/api/trading/ai-enter-option-order',
          body: { underlying: contract.underlying, strike: contract.strike, right: contract.right === 'C' ? 'CE' : 'PE' },
          stoplossPoint,
        }
      : { entry, endpoint: '/api/trading/ai-enter-order', body: { underlying, direction }, stoplossPoint: null }
    setPending(watch)
    setTrailing(null)
    lastPriceRef.current = null
    onMessage(
      isOption
        ? `Queued: will BUY this contract when its price reaches ${entry}${stoplossPoint != null ? ` (trailing stoploss of ${stoplossPoint} pts once filled)` : ''}.`
        : `Queued: will place ${direction === 'buy_ce' ? 'BUY CE' : 'BUY PE'} for ${underlying} when price reaches ${entry}${target != null || stoploss != null ? ` (AI target ${target}, stoploss ${stoploss} on the underlying — for reference only, not applied to the option order)` : ''}.`
    )
  }

  async function exitPosition() {
    if (busy) return
    if (!confirm(`Exit the open ${underlying} position now? This may use real money depending on the bot's "With money" setting.`)) return
    setTrailing(null)
    setBusy(true)
    try {
      const res = await apiFetch(`/api/trading/ai-exit-order`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ underlying }),
      })
      const d = await res.json()
      onMessage(d.status === 'success' ? `Exited: ${d.symbol} @ ${d.exitPrice} (P/L ${d.profit})` : `Exit failed: ${d.message}`)
    } catch {
      onMessage('Error: could not reach order server.')
    }
    setBusy(false)
  }

  return (
    <div style={{ padding: '0 10px 10px', display: 'flex', flexDirection: 'column', gap: 6 }}>
      {pending && (
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, color: '#787b86' }}>
          <span style={{ flex: 1 }}>Watching for {rawSymbol} to reach {pending.entry}…</span>
          <button
            onClick={() => setPending(null)}
            style={{ background: 'transparent', color: '#ef5350', border: '1px solid #ef5350', borderRadius: 4, padding: '4px 8px', cursor: 'pointer', fontSize: 12 }}
          >
            Cancel
          </button>
        </div>
      )}
      {trailing && (
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, color: '#787b86' }}>
          <span style={{ flex: 1 }}>Trailing {trailing.symbol}: peak {trailing.peak.toFixed(2)}, exits below {(trailing.peak - trailing.distance).toFixed(2)}</span>
          <button
            onClick={() => setTrailing(null)}
            style={{ background: 'transparent', color: '#ef5350', border: '1px solid #ef5350', borderRadius: 4, padding: '4px 8px', cursor: 'pointer', fontSize: 12 }}
          >
            Stop trailing
          </button>
        </div>
      )}
      {!pending && (
        <button
          onClick={queueOrder}
          disabled={busy || entry == null}
          style={{ background: '#26a69a', color: '#fff', border: '1px solid #26a69a', borderRadius: 4, padding: '6px 0', cursor: 'pointer', fontSize: 13, fontWeight: 600 }}
        >
          {busy ? '…' : isOption ? `Buy ${rawSymbol} at ${entry ?? '—'}` : `Place ${direction === 'buy_ce' ? 'BUY CE' : 'BUY PE'} order at ${entry ?? '—'}`}
        </button>
      )}
      <button
        onClick={exitPosition}
        disabled={busy}
        style={{ background: '#ef5350', color: '#fff', border: '1px solid #ef5350', borderRadius: 4, padding: '6px 0', cursor: 'pointer', fontSize: 13, fontWeight: 600 }}
      >
        Exit position
      </button>
    </div>
  )
}
