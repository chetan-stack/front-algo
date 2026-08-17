import { useState } from 'react'
import Chart from './Chart'
import TradingPanel from './TradingPanel'

const LAYOUTS = {
  1: { cols: 1, rows: 1 },
  2: { cols: 2, rows: 1 },
  4: { cols: 2, rows: 2 },
}

const TABS = [
  { id: 'charts', label: 'Charts' },
  { id: 'trading', label: 'Trading' },
  { id: 'crypto-charts', label: 'Crypto Charts' },
  { id: 'crypto-trading', label: 'Crypto Trading' },
]

export default function App() {
  const [count, setCount] = useState(1)
  const [view, setView] = useState('charts')
  const [jump, setJump] = useState(null)
  const { cols, rows } = LAYOUTS[count]
  const market = view.startsWith('crypto') ? 'crypto' : 'india'
  const isTrading = view === 'trading' || view === 'crypto-trading'

  function viewOnChart(req) {
    setJump(req)
    setView('charts')
  }

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: '#131722' }}>
      <div style={{ display: 'flex', gap: 8, padding: '6px 12px', borderBottom: '1px solid #2a2e39' }}>
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setView(t.id)}
            style={{
              background: view === t.id ? '#2a2e39' : 'transparent',
              color: '#d1d4dc', border: '1px solid #2a2e39', borderRadius: 4,
              padding: '4px 10px', cursor: 'pointer',
            }}
          >
            {t.label}
          </button>
        ))}
        {!isTrading && Object.keys(LAYOUTS).map((n) => (
          <button
            key={n}
            onClick={() => setCount(Number(n))}
            style={{
              background: count === Number(n) ? '#2a2e39' : 'transparent',
              color: '#d1d4dc', border: '1px solid #2a2e39', borderRadius: 4,
              padding: '4px 10px', cursor: 'pointer',
            }}
          >
            {n} screen{n === '1' ? '' : 's'}
          </button>
        ))}
      </div>
      {isTrading ? (
        <div style={{ flex: 1, minHeight: 0 }}><TradingPanel market={market} onViewOnChart={viewOnChart} /></div>
      ) : (
        <div style={{
          flex: 1, display: 'grid',
          gridTemplateColumns: `repeat(${cols}, 1fr)`,
          gridTemplateRows: `repeat(${rows}, 1fr)`,
          gap: 2,
        }}>
          {Array.from({ length: count }, (_, i) => (
            <Chart
              key={`${market}-${i}`}
              market={market}
              defaultSymbol={market === 'crypto' ? 'BINANCE:BTCUSDT' : 'NSE:NIFTY'}
              defaultLabel={market === 'crypto' ? 'BINANCE:BTCUSDT' : 'NSE:NIFTY'}
              jump={i === 0 ? jump : null}
              onJumpConsumed={i === 0 ? () => setJump(null) : undefined}
            />
          ))}
        </div>
      )}
    </div>
  )
}
