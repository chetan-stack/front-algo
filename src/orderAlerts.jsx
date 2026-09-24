import { useEffect, useState } from 'react'
import { apiFetch } from './api'

// Order-level alerts analyst.py writes for the signed-in (or acted-as) user:
// ORDER_WRONG (bad entry), ORDER_EXIT (exit needed), ORDER_TRAIL (trail the stop).
export const ORDER_ALERT_STYLE = {
  ORDER_WRONG: { label: 'Wrong entry', color: '#ef5350' },
  ORDER_EXIT: { label: 'Exit needed', color: '#ff9800' },
  ORDER_TRAIL: { label: 'Trail stop', color: '#26a69a' },
}

const MARKET_ALERT_LABEL = { TRENDING: 'Trending', TREND_COMING: 'Trend coming', NEAR_MOVE: 'Near a move', BIG_MOVE: 'Big move' }

const todayIST = () => new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Kolkata' }).slice(0, 10)

// All of this user's alerts (own order alerts + market alerts for their enabled symbols).
export function useAlerts() {
  const [alerts, setAlerts] = useState([])
  useEffect(() => {
    let cancelled = false
    async function poll() {
      try {
        const res = await apiFetch('/api/alerts?limit=500')
        const d = await res.json()
        if (!cancelled) setAlerts(d.items || [])
      } catch { /* backend restarting — next poll */ }
    }
    poll()
    const id = setInterval(poll, 30000)
    return () => { cancelled = true; clearInterval(id) }
  }, [])
  return alerts
}

// The single newest order alert for this symbol, only from this position's
// lifetime — the same symbol is often re-entered the same day, and an old
// "wrong entry" must not stick to the new position. `since` is the entry time
// ("YYYY-MM-DD HH:MM:SS..."); without it, today only. Both are IST strings.
export function latestOrderAlert(alerts, symbol, since) {
  const from = (since || todayIST()).slice(0, 19)
  let latest = null
  for (const a of alerts) {
    if (ORDER_ALERT_STYLE[a.kind] && a.symbol === symbol && a.ts >= from && (!latest || a.ts > latest.ts)) latest = a
  }
  return latest
}

export function OrderAlert({ alert }) {
  if (!alert) return null
  const st = ORDER_ALERT_STYLE[alert.kind]
  return (
    <div style={{ borderLeft: `3px solid ${st.color}`, background: `${st.color}1a`, padding: '3px 6px', borderRadius: 3, fontSize: 12, color: '#d1d4dc' }}>
      <b style={{ color: st.color }}>{st.label}</b>
      <span style={{ color: '#787b86' }}> · {alert.ts.slice(11, 16)}</span>
      <div>{alert.text}</div>
    </div>
  )
}

// Current state per index from analyst.py's latest cycle (/api/market-state).
export function useMarketState(market) {
  const [state, setState] = useState({})
  useEffect(() => {
    let cancelled = false
    async function poll() {
      try {
        const res = await apiFetch(`/api/market-state?market=${market}`)
        const d = await res.json()
        if (!cancelled) setState(d.symbols || {})
      } catch { /* next poll */ }
    }
    poll()
    const id = setInterval(poll, 60000)
    return () => { cancelled = true; clearInterval(id) }
  }, [market])
  return state
}

// Small badge next to an index checkbox: current state (trending/sideways) plus
// that index's newest market alert today, with the description on hover.
export function IndexStatus({ name, state, alerts }) {
  const entry = state?.[name]
  const s = entry?.state ? entry : null
  // /api/market-state carries each index's newest alert whether or not it's ticked;
  // the user's own /api/alerts (ticked indices only) is the fallback.
  let alert = MARKET_ALERT_LABEL[entry?.alert?.kind] ? entry.alert : null
  const today = todayIST()
  for (const a of alerts) {
    if (!a.user && a.symbol === name && MARKET_ALERT_LABEL[a.kind] && a.ts >= today && (!alert || a.ts > alert.ts)) alert = a
  }
  if (!s && !alert) return null
  const trending = s?.state === 'TRENDING_UP' || s?.state === 'TRENDING_DOWN'
  const color = s?.delayed ? '#787b86' : trending ? '#26a69a' : s?.state === 'SIDEWAYS' ? '#ff9800' : '#d1d4dc'
  const stateText = s ? (s.state === 'TRENDING_UP' ? 'Trending ▲' : s.state === 'TRENDING_DOWN' ? 'Trending ▼' : s.state === 'SIDEWAYS' ? 'Sideways' : 'Mixed') : null
  // Full "why" from analyst.py's explain(): trend direction, efficiency, EMA, 3-min move,
  // day change, nearest strong levels, outlook — one reason per line.
  const title = [
    s && (s.why?.length ? s.why.map((w) => `• ${w}`).join('\n') : `${stateText}${s.delayed ? ' (feed delayed)' : ''} — ${s.text}`),
    alert && `\n🔔 ${alert.ts.slice(11, 16)} ${MARKET_ALERT_LABEL[alert.kind]}: ${alert.text}`,
  ].filter(Boolean).join('\n')
  return (
    <span title={title} style={{ fontSize: 11, marginLeft: 4, color, whiteSpace: 'nowrap' }}>
      {stateText && <>{stateText}{s.delayed ? ' ⏱' : ''}</>}
      {alert && <span style={{ color: '#f0b90b' }}>{stateText ? ' · ' : ''}🔔 {MARKET_ALERT_LABEL[alert.kind]} {alert.ts.slice(11, 16)}</span>}
    </span>
  )
}
