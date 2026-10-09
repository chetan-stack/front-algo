import { useEffect, useState } from 'react'
import { apiFetch } from './api'

// The user's own AngelOne (India) and Delta Exchange (crypto) keys. Secrets are
// write-only: the backend only says whether they're set. Saving restarts that
// market's bots, which takes a few seconds.
const box = { background: '#1e222d', border: '1px solid #2a2e39', borderRadius: 6, padding: 16, maxWidth: 520 }
const input = { background: '#131722', color: '#d1d4dc', border: '1px solid #2a2e39', borderRadius: 4, padding: '8px 10px', width: '100%', boxSizing: 'border-box' }
const label = { display: 'block', color: '#787b86', fontSize: 12, margin: '10px 0 4px' }
const btn = (bg) => ({ background: bg, color: '#fff', border: 'none', borderRadius: 4, padding: '8px 14px', cursor: 'pointer', marginRight: 8 })

const MARKETS = {
  india: {
    title: 'India: AngelOne',
    fields: [['user_id', 'Client ID'], ['password', 'PIN'], ['api_key', 'SmartAPI key'], ['totp', 'TOTP secret (from the SmartAPI QR setup)']],
  },
  crypto: {
    title: 'Crypto: Delta Exchange',
    fields: [['api_key', 'API key'], ['api_secret', 'API secret']],
  },
}

function Market({ market, info, onSaved }) {
  const { title, fields } = MARKETS[market]
  const [form, setForm] = useState({})
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  async function save(live) {
    if (!live && !confirm('Switch to paper mode? Your saved keys for this market are removed.')) return
    setBusy(true)
    setMsg('Saving and restarting your bots…')
    try {
      const res = await apiFetch(`/api/account/broker/${market}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ live, ...(live ? form : {}) }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || 'save failed')
      setForm({})
      setMsg(live ? 'Saved. Real orders still need "With money" turned on in the Trading tab.' : 'Switched to paper mode.')
      onSaved()
    } catch (err) {
      setMsg(`Error: ${err.message}`)
    }
    setBusy(false)
  }

  const status = market === 'crypto' && !info.provisioned ? 'not set up' : info.live ? 'LIVE' : 'paper'
  return (
    <div style={{ ...box, marginBottom: 16 }}>
      <h3 style={{ color: '#d1d4dc', margin: 0 }}>{title}</h3>
      <div style={{ color: info.live ? '#26a69a' : '#787b86', fontSize: 13, marginTop: 4 }}>
        Status: {status}{info.user_id && ` · ${info.user_id}`}{info.api_key && ` · key ${info.api_key}`}
      </div>
      {fields.map(([k, l]) => (
        <label key={k}>
          <span style={label}>{l}</span>
          <input
            style={input} type={k === 'user_id' ? 'text' : 'password'} autoComplete="off"
            value={form[k] || ''} onChange={(e) => setForm({ ...form, [k]: e.target.value })}
          />
        </label>
      ))}
      <div style={{ marginTop: 14 }}>
        <button style={btn('#2962ff')} disabled={busy || fields.some(([k]) => !form[k]?.trim())} onClick={() => save(true)}>
          Save keys
        </button>
        {(info.live || (market === 'crypto' && !info.provisioned)) && (
          <button style={btn('#363a45')} disabled={busy} onClick={() => save(false)}>
            {market === 'crypto' && !info.provisioned ? 'Start crypto in paper mode' : 'Switch to paper'}
          </button>
        )}
      </div>
      {msg && <div style={{ color: msg.startsWith('Error') ? '#ef5350' : '#d1d4dc', fontSize: 13, marginTop: 10 }}>{msg}</div>}
    </div>
  )
}

export default function BrokerAccount() {
  const [info, setInfo] = useState(null)
  const load = () => apiFetch('/api/account/broker').then((r) => r.json()).then((d) => d.success && setInfo(d)).catch(() => {})
  useEffect(() => { load() }, [])

  if (!info) return <div style={{ color: '#787b86', padding: 16 }}>Loading…</div>
  return (
    <div style={{ padding: 16 }}>
      <p style={{ color: '#787b86', fontSize: 13, maxWidth: 520, marginTop: 0 }}>
        Add your own broker keys to trade on your account. Your keys are stored on our server only to log in to your broker,
        and are never shown again after saving. Saving keys does not place real orders by itself.
      </p>
      <Market market="india" info={info.india} onSaved={load} />
      <Market market="crypto" info={info.crypto} onSaved={load} />
    </div>
  )
}
