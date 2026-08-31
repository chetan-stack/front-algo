import { useEffect, useState } from 'react'
import { apiFetch } from './api'

const STATUS_COLORS = {
  complete: '#26a69a', open: '#2962ff', pending: '#ffb74d',
  'trigger pending': '#ffb74d', rejected: '#ef5350', cancelled: '#787b86', modified: '#ab47bc',
}

function statusColor(status) {
  return STATUS_COLORS[(status || '').toLowerCase()] || '#787b86'
}

export default function OrderBook() {
  const [orders, setOrders] = useState([])
  const [note, setNote] = useState('')
  const [funds, setFunds] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [autoRefresh, setAutoRefresh] = useState(true)
  const [statusFilter, setStatusFilter] = useState('all')

  async function load() {
    setBusy(true)
    setError('')
    try {
      const res = await apiFetch('/api/trading/orderbook')
      const data = await res.json()
      if (data.status === 'success') {
        setOrders(data.orders || [])
        setNote(data.note || '')
      } else {
        setError(data.message || 'failed to load order book')
      }
      const fundsRes = await apiFetch('/api/trading/funds')
      const fundsData = await fundsRes.json()
      if (fundsData.status === 'success') setFunds(fundsData.funds)
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

  const statuses = [...new Set(orders.map((o) => (o.status || o.orderstatus || '').toLowerCase()).filter(Boolean))].sort()
  const filtered = orders.filter((o) => {
    const s = (o.status || o.orderstatus || '').toLowerCase()
    return statusFilter === 'all' || s === statusFilter
  })

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', color: '#d1d4dc' }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: 12, borderBottom: '1px solid #2a2e39' }}>
        <select
          value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}
          style={{ background: '#131722', color: '#d1d4dc', border: '1px solid #2a2e39', borderRadius: 4, padding: '5px 8px' }}
        >
          <option value="all">All statuses</option>
          {statuses.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
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

      {note && <div style={{ padding: '6px 12px', fontSize: 12, color: '#787b86', borderBottom: '1px solid #2a2e39' }}>{note}</div>}
      {error && <div style={{ padding: '6px 12px', fontSize: 12, color: '#ef5350', borderBottom: '1px solid #2a2e39' }}>{error}</div>}
      {funds && (
        <div style={{
          padding: '6px 12px', fontSize: 12, borderBottom: '1px solid #2a2e39',
          color: Number(funds.availablecash) <= 0 ? '#ef5350' : '#26a69a',
        }}>
          Available funds: ₹{funds.availablecash} {Number(funds.availablecash) <= 0 && '— live orders will be rejected until this account is funded'}
        </div>
      )}

      <div style={{ flex: 1, overflow: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ color: '#787b86', textAlign: 'left', position: 'sticky', top: 0, background: '#131722' }}>
              <th style={{ padding: '6px 10px' }}>Symbol</th>
              <th style={{ padding: '6px 10px' }}>Side</th>
              <th style={{ padding: '6px 10px' }}>Status</th>
              <th style={{ padding: '6px 10px' }}>Qty</th>
              <th style={{ padding: '6px 10px' }}>Price</th>
              <th style={{ padding: '6px 10px' }}>Avg price</th>
              <th style={{ padding: '6px 10px' }}>Order ID</th>
              <th style={{ padding: '6px 10px' }}>Time</th>
              <th style={{ padding: '6px 10px' }}>Detail</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr><td colSpan={9} style={{ padding: 12, color: '#787b86' }}>{busy ? 'Loading…' : 'No orders'}</td></tr>
            ) : (
              filtered.map((o, i) => {
                const status = o.status || o.orderstatus || '—'
                return (
                  <tr key={o.orderid || i} style={{ borderTop: '1px solid #2a2e39' }}>
                    <td style={{ padding: '6px 10px' }}>{o.tradingsymbol}</td>
                    <td style={{ padding: '6px 10px' }}>{o.transactiontype}</td>
                    <td style={{ padding: '6px 10px', color: statusColor(status), fontWeight: 600 }}>{status}</td>
                    <td style={{ padding: '6px 10px' }}>{o.quantity}</td>
                    <td style={{ padding: '6px 10px' }}>{o.price}</td>
                    <td style={{ padding: '6px 10px' }}>{o.averageprice}</td>
                    <td style={{ padding: '6px 10px', color: '#787b86' }}>{o.orderid}</td>
                    <td style={{ padding: '6px 10px', color: '#787b86' }}>{o.updatetime || o.exchtime}</td>
                    <td style={{ padding: '6px 10px', color: '#ef5350' }}>{o.text}</td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
