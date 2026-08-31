import { useEffect, useState } from 'react'
import { apiFetch } from './api'

const SOURCE_LABELS = {
  storesupportzone: 'Auto-strategy', store_exit: 'Auto-exit', ai_order_service: 'AI/manual order',
}

export default function FailedOrders() {
  const [failures, setFailures] = useState([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [autoRefresh, setAutoRefresh] = useState(true)

  async function load() {
    setBusy(true)
    setError('')
    try {
      const res = await apiFetch('/api/trading/failed-orders')
      const data = await res.json()
      if (data.status === 'success') {
        setFailures(data.failures || [])
      } else {
        setError(data.message || 'failed to load failed orders')
      }
    } catch (err) {
      setError(err.message)
    }
    setBusy(false)
  }

  useEffect(() => { load() }, [])

  useEffect(() => {
    if (!autoRefresh) return
    const id = setInterval(load, 8000)
    return () => clearInterval(id)
  }, [autoRefresh])

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', color: '#d1d4dc' }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: 12, borderBottom: '1px solid #2a2e39' }}>
        <span style={{ fontSize: 12, color: '#787b86' }}>
          Live orders that never executed — SmartAPI rejected them, or the request itself failed. Never recorded as a trade (demo or real).
        </span>
        <label style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#787b86' }}>
          <input type="checkbox" checked={autoRefresh} onChange={(e) => setAutoRefresh(e.target.checked)} />
          Auto-refresh (8s)
        </label>
        <button
          onClick={load} disabled={busy}
          style={{ background: 'transparent', color: '#2962ff', border: '1px solid #2a2e39', borderRadius: 4, padding: '5px 10px', cursor: 'pointer', fontSize: 13 }}
        >
          {busy ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      {error && <div style={{ padding: '6px 12px', fontSize: 12, color: '#ef5350', borderBottom: '1px solid #2a2e39' }}>{error}</div>}

      <div style={{ flex: 1, overflow: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ color: '#787b86', textAlign: 'left', position: 'sticky', top: 0, background: '#131722' }}>
              <th style={{ padding: '6px 10px' }}>Time</th>
              <th style={{ padding: '6px 10px' }}>Symbol</th>
              <th style={{ padding: '6px 10px' }}>Side</th>
              <th style={{ padding: '6px 10px' }}>Source</th>
              <th style={{ padding: '6px 10px' }}>Reason</th>
            </tr>
          </thead>
          <tbody>
            {failures.length === 0 ? (
              <tr><td colSpan={5} style={{ padding: 12, color: '#787b86' }}>{busy ? 'Loading…' : 'No failed orders'}</td></tr>
            ) : (
              failures.map((f, i) => (
                <tr key={i} style={{ borderTop: '1px solid #2a2e39' }}>
                  <td style={{ padding: '6px 10px', color: '#787b86', whiteSpace: 'nowrap' }}>{f.time}</td>
                  <td style={{ padding: '6px 10px' }}>{f.symbol}</td>
                  <td style={{ padding: '6px 10px' }}>{f.side}</td>
                  <td style={{ padding: '6px 10px', color: '#787b86' }}>{SOURCE_LABELS[f.source] || f.source}</td>
                  <td style={{ padding: '6px 10px', color: '#ef5350' }}>{f.reason}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
