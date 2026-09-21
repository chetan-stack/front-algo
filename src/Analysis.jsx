import { useEffect, useState } from 'react'
import { apiFetch } from './api'
import AnalystControl from './AnalystControl'

const COLORS = [
  [/ATTENTION|FIX:|CYCLE FAILED|data unavailable|ORDER_WRONG|ORDER-WRONG|ORDER_EXIT|ORDER-EXIT/, '#ef5350'],
  [/ALERT \[|START:|BREAKOUT_UP|BREAKDOWN|ORDER_TRAIL|ORDER-TRAIL/, '#26a69a'],
  [/REVIEW|PAUSE:|PREPARE:|COILED|BIG MOVE|DELAYED/, '#ffb74d'],
  [/WATCH|NOTE|NO_SIGNAL/, '#4fc3f7'],
]
const lineColor = (l) => (COLORS.find(([re]) => re.test(l)) || [null, '#d1d4dc'])[1]

// Admin-only: the backend route enforces it, this tab is just hidden from everyone else.
export default function Analysis({ market = 'india' }) {
  const [lines, setLines] = useState([])
  const [path, setPath] = useState('')
  const [auto, setAuto] = useState(true)
  const [err, setErr] = useState('')

  async function load() {
    try {
      const res = await apiFetch(`/api/admin/analysis?market=${market}`)
      const data = await res.json()
      setLines(data.lines || [])
      setPath(data.path || '')
      setErr('')
    } catch (e) {
      setErr(e.message)
    }
  }

  useEffect(() => { load() }, [])
  useEffect(() => {
    if (!auto) return
    const id = setInterval(load, 30000)
    return () => clearInterval(id)
  }, [auto])

  // Log is oldest-first; group by "=== time ===" header and show newest cycle on top.
  const blocks = []
  lines.forEach((l) => {
    if (l.startsWith('=== ')) blocks.push([l])
    else if (blocks.length) blocks[blocks.length - 1].push(l)
  })
  blocks.reverse()

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', color: '#d1d4dc' }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', padding: 12, borderBottom: '1px solid #2a2e39', fontSize: 12, color: '#787b86' }}>
        <span>{market === 'crypto' ? 'Crypto' : 'India'} market &amp; auto-strategy report — today only, read-only, recommendations only{path ? ` · ${path}` : ''}</span>
        <span style={{ marginLeft: 'auto' }}><AnalystControl market={market} /></span>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
          Auto-refresh (30s)
        </label>
        <button onClick={load} style={{ background: 'transparent', color: '#2962ff', border: '1px solid #2a2e39', borderRadius: 4, padding: '5px 10px', cursor: 'pointer', fontSize: 13 }}>
          Refresh
        </button>
      </div>
      <div style={{ flex: 1, overflow: 'auto', background: '#0c0e15', padding: 12, fontFamily: 'monospace', fontSize: 12, lineHeight: 1.5 }}>
        {err && <div style={{ color: '#ef5350' }}>Error: {err}</div>}
        {!err && blocks.length === 0 && <div style={{ color: '#787b86' }}>No analysis yet — start analyst.py (market hours only).</div>}
        {blocks.map((b, i) => (
          <div key={i} style={{ marginBottom: 14, paddingBottom: 10, borderBottom: '1px solid #1a1d26' }}>
            {b.filter((l) => l.trim()).map((l, j) => (
              <div key={j} style={{ whiteSpace: 'pre-wrap', color: j === 0 ? '#2962ff' : lineColor(l), fontWeight: j === 0 ? 700 : 400 }}>{l}</div>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}
