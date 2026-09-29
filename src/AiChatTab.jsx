import { useEffect, useRef, useState } from 'react'
import { apiFetch } from './api'

// "AI Chat" tab: Claude-backed market chat (news, chart explanation, levels,
// strategies, patterns) — backend in ai_chat.py. Claude's trade ideas arrive as
// plan cards; plotting them or placing an order is always the user's click.
const CRYPTO_RE = /^(BINANCE|DELTA|BYBIT|COINBASE|BITSTAMP|KRAKEN|BITFINEX|OKX):/
const SUGGESTIONS = [
  'Explain the NIFTY 5 min chart and give me support/resistance levels',
  'What news is moving BTC today?',
  'Best option strategy for BANKNIFTY right now — buy or sell?',
  'Any chart pattern forming on NSE:RELIANCE daily?',
]
const btn = { background: '#2a2e39', color: '#d1d4dc', border: '1px solid #363a45', borderRadius: 4, padding: '5px 10px', cursor: 'pointer', fontSize: 12 }

function PlanCard({ plan, onPlot }) {
  const [msg, setMsg] = useState('')
  const t = plan.trade || {}
  const canOrder = t.underlying && t.strike && t.right && (t.direction === 'buy_ce' || t.direction === 'buy_pe')

  async function placeOrder() {
    const strike = String(Math.round(t.strike))
    if (!window.confirm(`BUY ${t.underlying} ${strike} ${t.right} at market now?\nThis uses real money if your India bot's "With money" is on.`)) return
    setMsg('Placing…')
    try {
      const res = await apiFetch('/api/trading/ai-enter-option-order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ underlying: t.underlying, strike, right: t.right }),
      })
      const d = await res.json()
      setMsg(d.status === 'success' ? `Order placed: ${d.symbol} x${d.lotsize} @ ${d.ltp}` : `Order failed: ${d.message || 'unknown error'}`)
    } catch {
      setMsg('Order failed: could not reach order server.')
    }
  }

  const levels = [...(plan.levels || [])].sort((a, b) => b.price - a.price)
  return (
    <div style={{ border: '1px solid #363a45', borderRadius: 6, padding: 10, marginTop: 8, fontSize: 13, background: '#1a1e2b' }}>
      <div style={{ fontWeight: 600, marginBottom: 6 }}>
        {plan.symbol}{plan.bias && <span style={{ marginLeft: 8, color: plan.bias === 'bullish' ? '#26a69a' : plan.bias === 'bearish' ? '#ef5350' : '#f0b90b' }}>{plan.bias.toUpperCase()}</span>}
      </div>
      {levels.map((l, i) => (
        <div key={i} style={{ color: l.type === 'support' ? '#26a69a' : '#ef5350' }}>
          {l.type === 'support' ? 'S' : 'R'} {l.price}{l.label ? ` — ${l.label}` : ''}
        </div>
      ))}
      {t.direction && (
        <div style={{ marginTop: 6 }}>
          <b>{t.direction.replace(/_/g, ' ').toUpperCase()}</b>
          {t.underlying && t.strike ? ` ${t.underlying} ${t.strike} ${t.right || ''}` : ''}
          {[t.entry != null && ` Entry ${t.entry}`, t.target != null && ` Target ${t.target}`, t.stoploss != null && ` SL ${t.stoploss}`].filter(Boolean).join(' |')}
          {t.reason && <div style={{ color: '#9598a1' }}>{t.reason}</div>}
        </div>
      )}
      <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
        <button style={btn} onClick={() => onPlot(plan)}>Add levels to chart</button>
        {canOrder && <button style={{ ...btn, borderColor: '#26a69a', color: '#26a69a' }} onClick={placeOrder}>Place order…</button>}
      </div>
      {msg && <div style={{ marginTop: 6, color: '#9598a1' }}>{msg}</div>}
    </div>
  )
}

export default function AiChatTab({ chartContext, onViewOnChart }) {
  const [messages, setMessages] = useState(() => {
    try { return JSON.parse(localStorage.getItem('aiChatHistory') || '[]') } catch { return [] }
  })
  const [input, setInput] = useState('')
  const [image, setImage] = useState(null)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const [quota, setQuota] = useState(null) // {left, limit}; left null = unlimited (admin)
  const endRef = useRef(null)

  useEffect(() => {
    apiFetch('/api/ai/quota').then((r) => r.json()).then(setQuota).catch(() => {})
  }, [])
  const outOfQuota = quota?.left != null && quota.left <= 0

  useEffect(() => {
    try { localStorage.setItem('aiChatHistory', JSON.stringify(messages.slice(-40))) } catch { /* storage blocked/full */ }
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [messages])

  function attach(file) {
    if (!file?.type.startsWith('image/')) return
    const reader = new FileReader()
    reader.onload = () => setImage(reader.result)
    reader.readAsDataURL(file)
  }

  // Levels go into the chart's own saved drawings (same shapes Chart.jsx's
  // AI analysis adds), then open that chart — it loads them on mount.
  function plot(plan) {
    const now = Date.now()
    const t = plan.trade || {}
    const add = (plan.levels || []).map((l, i) => ({
      id: now + i, symbol: plan.symbol, type: 'sr', price: l.price,
      color: l.type === 'support' ? '#26a69a' : '#ef5350',
      label: `${l.type === 'support' ? 'Support' : 'Resistance'}${l.label ? ': ' + l.label : ''}`,
    }))
    if (t.entry != null || t.target != null || t.stoploss != null) {
      add.push({ id: now + add.length, symbol: plan.symbol, type: 'ai-trade', entry: t.entry, target: t.target, stoploss: t.stoploss, direction: t.direction })
    }
    try {
      const stored = JSON.parse(localStorage.getItem('chartDrawings') || '[]')
      localStorage.setItem('chartDrawings', JSON.stringify([...stored, ...add]))
    } catch { /* storage blocked */ }
    onViewOnChart({ symbol: plan.symbol, label: plan.symbol, market: CRYPTO_RE.test(plan.symbol) ? 'crypto' : 'india' })
  }

  async function send(text = input) {
    text = text.trim()
    if (!text || busy || outOfQuota) return
    const history = [...messages, { role: 'user', content: text, image: !!image }]
    setMessages([...history, { role: 'assistant', content: '', plans: [] }])
    setInput('')
    setBusy(true)
    setStatus('Thinking…')
    const update = (fn) => setMessages((m) => [...m.slice(0, -1), fn(m[m.length - 1])])
    try {
      const res = await apiFetch('/api/ai/claude-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: history.map(({ role, content }) => ({ role, content })), image, context: chartContext }),
      })
      setImage(null)
      if (res.status === 429) setQuota((q) => ({ ...q, left: 0 }))
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || `HTTP ${res.status}`)
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const lines = buf.split('\n')
        buf = lines.pop()
        for (const ln of lines.filter(Boolean)) {
          const { t, v } = JSON.parse(ln)
          if (t === 'text') { setStatus(''); update((a) => ({ ...a, content: a.content + v })) }
          else if (t === 'status') setStatus(v)
          else if (t === 'quota') setQuota(v)
          else if (t === 'plan') update((a) => ({ ...a, plans: [...a.plans, v] }))
          else if (t === 'error') update((a) => ({ ...a, content: `${a.content}\n\n⚠️ ${v}` }))
        }
      }
    } catch (e) {
      update((a) => ({ ...a, content: `${a.content}\n\n⚠️ ${e.message || 'Could not reach the AI server.'}` }))
    }
    setBusy(false)
    setStatus('')
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', color: '#d1d4dc', background: '#131722' }}>
      <div style={{ flex: 1, overflow: 'auto', padding: '16px max(16px, calc(50% - 400px))' }}>
        {!messages.length && (
          <div style={{ marginTop: 40, textAlign: 'center' }}>
            <div style={{ fontSize: 20, marginBottom: 6 }}>AI market chat</div>
            <div style={{ color: '#787b86', fontSize: 13, marginBottom: 16 }}>News, chart explanation, levels, patterns, strategies — India and crypto. Attach or paste a chart screenshot for image analysis.</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'center' }}>
              {SUGGESTIONS.map((s) => <button key={s} style={btn} onClick={() => send(s)}>{s}</button>)}
            </div>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} style={{ display: 'flex', justifyContent: m.role === 'user' ? 'flex-end' : 'flex-start', margin: '10px 0' }}>
            <div style={{ maxWidth: '85%', padding: '8px 12px', borderRadius: 8, whiteSpace: 'pre-wrap', lineHeight: 1.5, fontSize: 14, background: m.role === 'user' ? '#2962ff' : '#1e222d' }}>
              {m.content || (busy && i === messages.length - 1 ? status || '…' : '')}
              {m.image && <div style={{ fontSize: 11, opacity: 0.7 }}>📎 chart image</div>}
              {m.plans?.map((p, j) => <PlanCard key={j} plan={p} onPlot={plot} />)}
              {busy && i === messages.length - 1 && m.content && status && <div style={{ fontSize: 12, color: '#787b86', marginTop: 4 }}>{status}</div>}
            </div>
          </div>
        ))}
        <div ref={endRef} />
      </div>
      <div style={{ borderTop: '1px solid #2a2e39', padding: '10px max(16px, calc(50% - 400px))' }}>
        {image && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, fontSize: 12 }}>
            <img src={image} alt="attached chart" style={{ height: 40, borderRadius: 4 }} />
            <button style={btn} onClick={() => setImage(null)}>Remove</button>
          </div>
        )}
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
          <label style={{ ...btn, padding: '8px 10px' }} title="Attach chart screenshot">
            📎<input type="file" accept="image/*" hidden onChange={(e) => { attach(e.target.files[0]); e.target.value = '' }} />
          </label>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onPaste={(e) => attach([...e.clipboardData.files][0])}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }}
            placeholder="Ask about any stock, index or coin… (Enter to send, Shift+Enter new line)"
            rows={2}
            style={{ flex: 1, resize: 'none', background: '#1e222d', color: '#d1d4dc', border: '1px solid #363a45', borderRadius: 6, padding: 8, fontSize: 14, fontFamily: 'inherit' }}
          />
          <button style={{ ...btn, padding: '8px 14px', background: '#2962ff', borderColor: '#2962ff', color: '#fff', opacity: busy || outOfQuota ? 0.5 : 1 }} disabled={busy || outOfQuota} onClick={() => send()}>Send</button>
          {messages.length > 0 && <button style={{ ...btn, padding: '8px 10px' }} disabled={busy} onClick={() => setMessages([])} title="New chat">New</button>}
        </div>
        {quota?.left != null && (
          <div style={{ fontSize: 12, marginTop: 6, color: outOfQuota ? '#ef5350' : '#787b86' }}>
            {outOfQuota ? `Daily limit reached (${quota.limit} questions) — resets at midnight IST.` : `${quota.left} of ${quota.limit} AI questions left today`}
          </div>
        )}
      </div>
    </div>
  )
}
