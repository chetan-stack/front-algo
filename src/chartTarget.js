import { apiFetch } from './api'
import { parseContract } from './contracts'

// Order symbol -> the chart to open for it ({ symbol, label }), used by the Trading
// panel's "View chart" and the Alerts tab. Throws with a readable message.
//  - crypto options (C-BTC-78200-310826) are directly chartable (server.py DELTA_OPTION_RE)
//  - crypto futures BTCUSD / ETHUSD open Binance spot (the chart draws the position's
//    entry / target / stoploss; DeltaEx levels can sit a few $ off Binance's)
//  - gold XAUTUSD has no Binance pair, so Delta's own perpetual candles
//  - india option contracts are resolved to a TradingView listing via /api/search
export async function chartTarget(symbol, market) {
  if (market === 'crypto') {
    if (symbol === 'BTCUSD' || symbol === 'ETHUSD') return { symbol: `BINANCE:${symbol}T`, label: `BINANCE:${symbol}T — ${symbol} futures position` }
    if (symbol === 'XAUTUSD') return { symbol: 'DELTA:XAUTUSD', label: 'DELTA:XAUTUSD — gold futures position' }
    return { symbol, label: symbol }
  }
  const c = parseContract(symbol)
  if (!c) throw new Error(`Could not parse contract from ${symbol}`)
  const right = c.right === 'C' ? 'CE' : 'PE'
  const res = await apiFetch(`/api/search?query=${encodeURIComponent(`${c.underlying} ${c.strike} ${right}`)}&type=options`)
  const d = await res.json()
  const match = d.success && d.results.find((r) => parseContract(r.symbol)?.right === c.right)
  if (!match) throw new Error(`No TradingView listing found for ${symbol}`)
  return { symbol: `${match.exchange}:${match.symbol}`, label: `${match.exchange}:${match.symbol} — ${match.description}` }
}
