import { useEffect, useState } from 'react'
import { apiFetch } from './api'
import { configPayload } from './tradingConfig'

// Admin tab, right side: one card per user with their auto-strategy switches (saved straight
// to their dashboard, no "Act as" needed) + today's P&L, order count, stoploss hits, open positions.
// Same routes as the Trading panel, with a per-request asUser. Loads once / ⟳ only (no timer).
const MARKETS = {
  india: { prefix: '/api/trading', label: 'India', color: '#2962ff', flags: [['auto_place_order', 'Auto'], ['NIFTY', 'NIFTY'], ['BANKNIFTY', 'BANKNIFTY'], ['SENSEX', 'SENSEX']] },
  crypto: { prefix: '/api/crypto/trading', label: 'Crypto', color: '#f0b90b', flags: [['auto_place_order', 'Auto'], ['BTCUSD', 'BTC'], ['ETHUSD', 'ETH'], ['XAUTUSD', 'XAUT']] },
}
const C = { text: '#d1d4dc', dim: '#787b86', line: '#2a2e39', bg: '#131722', up: '#26a69a', down: '#ef5350', warn: '#ffb74d' }
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })  // YYYY-MM-DD IST

// "123.5 - no. of order: 5 - brokreg: 250- stoploss: 2"
function parseProfit(s) {
  const m = /^(-?[\d.]+) - no\. of order: (\d+).*stoploss: (\d+)/.exec(String(s ?? ''))
  return m ? { pnl: Number(m[1]), orders: Number(m[2]), losses: Number(m[3]) } : null
}

function Stat({ label, value, color = C.text }) {
  return (
    <div style={{ background: C.bg, border: `1px solid ${C.line}`, borderRadius: 6, padding: '6px 8px', minWidth: 0 }}>
      <div style={{ color: C.dim, fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</div>
      <div style={{ color, fontSize: 15, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{value}</div>
    </div>
  )
}

function MarketBlock({ username, market }) {
  const { prefix, label, color, flags } = MARKETS[market]
  const [d, setD] = useState(null)
  const [err, setErr] = useState('')
  const [saving, setSaving] = useState(null)
  const [busy, setBusy] = useState(false)

  async function load() {
    setBusy(true)
    try {
      const r = await (await apiFetch(`${prefix}/dashboard?date=${today()}`, { asUser: username })).json()
      if (r.status !== 'success') throw new Error(r.message || 'failed to load')
      setD(r); setErr('')
    } catch (e) { setErr(e.message) }
    setBusy(false)
  }
  useEffect(() => { load() }, [username])

  async function toggle(key, value) {
    setSaving(key)
    try {
      const body = configPayload({ ...d.form_data, [key]: value }, d.selectclient?.[0], market)
      const r = await (await apiFetch(`${prefix}/config`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), asUser: username,
      })).json()
      if (r.status !== 'success') throw new Error(r.message || 'save failed')
      setD({ ...d, form_data: r.form_data }); setErr('')
    } catch (e) { setErr(`Not saved: ${e.message}`) }
    setSaving(null)
  }

  const p = parseProfit(d?.allprofit)
  const open = (d?.storeorder || []).filter((o) => String(o?.orderterm ?? '').toLowerCase() === 'hold').length
  const auto = !!d?.form_data?.auto_place_order

  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
        <span style={{ width: 8, height: 8, borderRadius: 4, background: color }} />
        <b style={{ color: C.text, fontSize: 12 }}>{label}</b>
        {market === 'crypto' && d && <span style={{ color: C.dim, fontSize: 11 }}>· {d.instrument || 'options'}</span>}
        {d && <span style={{ fontSize: 11, color: auto ? C.up : C.dim }}>· {auto ? 'auto trading on' : 'auto trading off'}</span>}
        <button onClick={load} disabled={busy} aria-label={`Reload ${label}`} title="Reload settings and today's orders"
          style={{ marginLeft: 'auto', background: 'transparent', color: C.dim, border: `1px solid ${C.line}`, borderRadius: 4, padding: '1px 7px', cursor: busy ? 'wait' : 'pointer', fontSize: 12 }}>
          {busy ? '…' : '⟳'}
        </button>
      </div>
      {err && <div style={{ color: C.down, fontSize: 12, marginBottom: 6 }}>{err}</div>}
      {!d && !err && <div style={{ color: C.dim, fontSize: 12 }}>Loading…</div>}
      {d && <>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
          {flags.map(([key, text]) => {
            const on = !!d.form_data?.[key]
            return (
              <button key={key} role="switch" aria-checked={on} disabled={saving !== null} onClick={() => toggle(key, !on)}
                title={on ? `Turn ${text} off` : `Turn ${text} on`}
                style={{
                  padding: '5px 12px', borderRadius: 14, fontSize: 12, fontWeight: 600, minHeight: 28,
                  cursor: saving !== null ? 'wait' : 'pointer', opacity: saving === key ? 0.5 : 1,
                  border: `1px solid ${on ? color : C.line}`, background: on ? color : 'transparent',
                  color: on ? (market === 'crypto' ? '#131722' : '#fff') : C.dim,
                }}>
                {on ? '✓ ' : ''}{text}
              </button>)
          })}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(72px, 1fr))', gap: 6 }}>
          <Stat label="Today P&L" value={p ? `${p.pnl >= 0 ? '+' : ''}${p.pnl.toFixed(2)}` : '—'} color={!p ? C.dim : p.pnl >= 0 ? C.up : C.down} />
          <Stat label="Orders" value={p?.orders ?? '—'} />
          <Stat label="SL hits" value={p?.losses ?? '—'} color={p?.losses ? C.down : C.text} />
          <Stat label="Open" value={open} color={open ? C.warn : C.text} />
        </div>
      </>}
    </div>
  )
}

export default function AdminUserTrading({ user, onActAsUser }) {
  return (
    <div style={{ background: '#1a1e29', border: `1px solid ${C.line}`, borderRadius: 8, padding: 12, minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ width: 28, height: 28, borderRadius: 14, background: C.line, color: C.text, display: 'grid', placeItems: 'center', fontWeight: 700, fontSize: 13, flexShrink: 0 }}>
          {user.username[0]?.toUpperCase()}
        </span>
        <b style={{ color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{user.username}</b>
        {user.is_admin ? <span style={{ color: C.dim, fontSize: 10, border: `1px solid ${C.line}`, borderRadius: 8, padding: '0 6px' }}>ADMIN</span> : null}
        <button onClick={() => onActAsUser(user.username)} title="Open this user's full dashboard"
          style={{ marginLeft: 'auto', background: 'transparent', color: C.warn, border: `1px solid ${C.line}`, borderRadius: 4, padding: '4px 10px', cursor: 'pointer', fontSize: 12, flexShrink: 0 }}>
          Act as
        </button>
      </div>
      <MarketBlock username={user.username} market="india" />
      {user.crypto_port != null && <MarketBlock username={user.username} market="crypto" />}
    </div>
  )
}
