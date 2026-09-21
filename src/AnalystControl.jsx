import { useEffect, useState } from 'react'
import { apiFetch } from './api'

const HOURS = { india: 'Mon–Fri 09:15–15:30 IST', crypto: '24/7' }

// Admin-only status + Start/Stop/Restart for one market's analysis process (analyst.py --market <m>).
// India and crypto are separate processes, so each can be stopped and started on its own.
export default function AnalystControl({ market }) {
  const [s, setS] = useState(null)
  const [busy, setBusy] = useState(false)
  const name = market === 'crypto' ? 'Crypto' : 'India'

  async function refresh() {
    try {
      const res = await apiFetch(`/api/admin/analyst/${market}`)
      setS(await res.json())
    } catch { /* backend restarting — next tick */ }
  }

  async function act(action) {
    setBusy(true)
    try {
      const res = await apiFetch(`/api/admin/analyst/${market}/${action}`, { method: 'POST' })
      setS(await res.json())
    } catch { /* leave the last status showing */ }
    setBusy(false)
  }

  useEffect(() => {
    refresh()
    const id = setInterval(refresh, 15000)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [market])

  const btn = (label, action) => (
    <button
      onClick={() => act(action)}
      disabled={busy}
      style={{ background: 'transparent', color: '#d1d4dc', border: '1px solid #2a2e39', borderRadius: 4, padding: '4px 10px', cursor: busy ? 'default' : 'pointer', fontSize: 12 }}
    >
      {label}
    </button>
  )

  if (!s || !s.success) return null
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 12, flexWrap: 'wrap' }}>
      <span style={{ width: 8, height: 8, borderRadius: '50%', background: s.running ? '#26a69a' : '#ef5350' }} />
      <span style={{ color: s.running ? '#d1d4dc' : '#ef5350' }}>
        {s.running
          ? `${name} analysis running (${HOURS[market]}) · pid ${s.pid} · up ${s.uptime}`
          : `${name} analysis STOPPED — no new ${name} reports or alerts`}
      </span>
      {btn(busy ? '…' : s.running ? 'Restart' : 'Start', s.running ? 'restart' : 'start')}
      {s.running && btn('Stop', 'stop')}
    </span>
  )
}
