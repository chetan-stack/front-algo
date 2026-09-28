// DeltaEx India perpetuals the crypto bot trades in futures mode: coin per contract
export const CRYPTO_CONTRACT_VALUE = { BTCUSD: 0.001, ETHUSD: 0.01 }

// P&L text, shared by the chart and the Trading panel. Math.round suits India's
// rupees but showed a crypto futures P&L of $0.06 (1 contract = 0.001 BTC) as
// "0". Futures: USD with cents (4 dp under $1); crypto options: 2 dp (premium
// points x contracts, not USD); India: whole rupees, as before.
export function fmtPnl(value, market, symbol) {
  const n = Number(value)
  if (!Number.isFinite(n)) return '—'
  if (market !== 'crypto') return Math.round(n)
  if (Object.hasOwn(CRYPTO_CONTRACT_VALUE, symbol)) {
    return `${n < 0 ? '-' : ''}$${Math.abs(n).toFixed(Math.abs(n) < 1 ? 4 : 2)}`
  }
  return n.toFixed(2)
}
