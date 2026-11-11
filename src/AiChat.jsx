import { useEffect, useState } from 'react'
import AiOrderControls from './AiOrderControls'
import { apiFetch } from './api'

function candleContext(symbol, candles) {
  return candles.length
    ? `\n\nSymbol: ${symbol}\nLast ${candles.length} candles (time,open,high,low,close):\n` +
      candles.map((c) => `${c.time},${c.open},${c.high},${c.low},${c.close}`).join(';')
    : ''
}

function formatAnalysis(data) {
  const levels = (data.levels || [])
    .slice().sort((a, b) => b.price - a.price)
    .map((l) => `  ${l.type === 'support' ? 'Support' : 'Resistance'}  ${l.price}${l.label ? ' — ' + l.label : ''}`)
    .join('\n')
  const t = data.trade || {}
  const tradeLine = t.direction
    ? `\n\nTrade idea: ${t.direction.replace(/_/g, ' ').toUpperCase()}` +
      (t.entry != null || t.target != null || t.stoploss != null
        ? '\n  ' + [t.entry != null && `Entry ${t.entry}`, t.target != null && `Target ${t.target}`, t.stoploss != null && `Stoploss ${t.stoploss}`].filter(Boolean).join(' | ')
        : '') +
      (t.reason ? `\n  ${t.reason}` : '')
    : ''
  return `${(data.bias || '').toUpperCase()} — ${data.summary || ''}\n\n${levels ? 'Levels:\n' + levels : ''}${tradeLine}`
}

// Chart chat is kept for the current day (per browser, per acted-as user); a new day starts empty.
function storeKey() {
  try { return `aiChartChat:${localStorage.getItem('actingAs') || ''}` } catch { return 'aiChartChat:' }
}
function loadToday() {
  try {
    const d = JSON.parse(localStorage.getItem(storeKey()))
    if (d?.date === new Date().toDateString()) return d
  } catch { /* storage blocked / bad JSON */ }
  return {}
}

export default function AiChat({ symbol, getCandles, takeScreenshot, onAnalysis }) {
  const [messages, setMessages] = useState(() => loadToday().messages || [])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [lastTrade, setLastTrade] = useState(() => loadToday().lastTrade || null)

  useEffect(() => {
    try {
      localStorage.setItem(storeKey(), JSON.stringify({ date: new Date().toDateString(), messages: messages.slice(-60), lastTrade }))
    } catch { /* storage blocked/full */ }
  }, [messages, lastTrade])

  async function analyze() {
    if (busy) return
    const shown = [...messages, { role: 'user', content: '🎯 Professional chart analysis' }]
    setMessages(shown)
    setBusy(true)
    const image = takeScreenshot()
    const context = candleContext(symbol, getCandles().slice(-50))
    try {
      const res = await apiFetch(`/api/ai/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image, context }),
      })
      const data = await res.json()
      if (data.success) {
        onAnalysis?.(data)
        setLastTrade(data.trade || null)
        setMessages([...shown, { role: 'assistant', content: formatAnalysis(data) }])
      } else {
        setMessages([...shown, { role: 'assistant', content: `Error: ${data.detail || 'analysis failed'}` }])
      }
    } catch {
      setMessages([...shown, { role: 'assistant', content: 'Error: could not reach server.' }])
    }
    setBusy(false)
  }

  async function send(withScreenshot) {
    const text = input.trim() || (withScreenshot ? 'Analyze this chart and suggest a strategy with entry, target and stoploss levels.' : '')
    if (!text || busy) return
    const shown = [...messages, { role: 'user', content: text }]
    setMessages(shown)
    setInput('')
    setBusy(true)

    const image = withScreenshot ? takeScreenshot() : null
    const context = candleContext(symbol, getCandles().slice(-50))

    try {
      const res = await apiFetch(`/api/ai/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          image,
          messages: [...shown.slice(0, -1), { role: 'user', content: text + context }],
        }),
      })
      const data = await res.json()
      setMessages([...shown, { role: 'assistant', content: data.success ? data.reply : `Error: ${data.detail || 'request failed'}` }])
    } catch {
      setMessages([...shown, { role: 'assistant', content: 'Error: could not reach server.' }])
    }
    setBusy(false)
  }

  return (
    <div style={{ width: 320, height: 480, maxWidth: '92vw', maxHeight: '75vh', minWidth: 240, minHeight: 200, resize: 'both', overflow: 'hidden', background: '#1e222d', border: '1px solid #2a2e39', borderTop: 'none', borderRadius: '0 0 6px 6px', display: 'flex', flexDirection: 'column' }}>
      <div style={{ flex: 1, overflowY: 'auto', padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {messages.length > 0 && (
          <button
            onClick={() => { if (window.confirm('Start a new chat? Today\'s chat will be deleted.')) { setMessages([]); setLastTrade(null) } }}
            disabled={busy}
            style={{ position: 'sticky', top: 0, zIndex: 1, alignSelf: 'flex-end', background: '#1e222d', color: '#787b86', border: '1px solid #2a2e39', borderRadius: 4, padding: '2px 8px', cursor: 'pointer', fontSize: 11 }}
          >
            ＋ New chat
          </button>
        )}
        {messages.length === 0 && (
          <div style={{ color: '#787b86', fontSize: 12 }}>
            Tap "Analyze this chart" for a screenshot-based read, or ask a question below.
          </div>
        )}
        {messages.map((m, i) => (
          <div
            key={i}
            style={{
              alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start',
              background: m.role === 'user' ? '#2962ff' : '#2a2e39',
              color: '#d1d4dc', borderRadius: 6, padding: '6px 10px', fontSize: 13, maxWidth: '90%', whiteSpace: 'pre-wrap',
            }}
          >
            {m.content}
          </div>
        ))}
        {busy && <div style={{ color: '#787b86', fontSize: 12 }}>Thinking…</div>}
      </div>
      <AiOrderControls
        symbol={symbol}
        direction={lastTrade?.direction}
        entry={lastTrade?.entry}
        target={lastTrade?.target}
        stoploss={lastTrade?.stoploss}
        onMessage={(content) => setMessages((m) => [...m, { role: 'assistant', content }])}
      />
      <div style={{ padding: 10, borderTop: '1px solid #2a2e39', display: 'flex', flexDirection: 'column', gap: 6 }}>
        <button
          onClick={analyze}
          disabled={busy}
          style={{ background: '#2962ff', color: '#fff', border: '1px solid #2962ff', borderRadius: 4, padding: '6px 0', cursor: 'pointer', fontSize: 13, fontWeight: 600 }}
        >
          🎯 Mark levels & suggest trade
        </button>
        <button
          onClick={() => send(true)}
          disabled={busy}
          style={{ background: '#2a2e39', color: '#d1d4dc', border: '1px solid #2a2e39', borderRadius: 4, padding: '6px 0', cursor: 'pointer', fontSize: 13 }}
        >
          📷 Analyze this chart
        </button>
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && send(false)}
            placeholder="Ask about this setup..."
            style={{ flex: 1, background: '#131722', color: '#d1d4dc', border: '1px solid #2a2e39', borderRadius: 4, padding: '6px 8px', fontSize: 13 }}
          />
          <button onClick={() => send(false)} disabled={busy} style={{ background: '#2a2e39', color: '#d1d4dc', border: '1px solid #2a2e39', borderRadius: 4, padding: '6px 10px', cursor: 'pointer' }}>
            Send
          </button>
        </div>
      </div>
    </div>
  )
}
