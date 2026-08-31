// Three different symbol conventions in play, each needs its own parse — a generic
// "trailing digits before CE/PE" regex is wrong for all of them: TradingView puts
// C/P *before* the strike, and the broker formats have no separator between the
// date digits and strike digits, so a greedy digit-run swallows part of the date too.
// ponytail: BFO's single-char month code is assumed numeric (1-9); Oct/Nov/Dec use
// letters (O/N/D) which this also handles, but only verified against Aug examples.
// TradingView also uses its own short tickers for some underlyings (confirmed: SENSEX
// options are "BSX" on TradingView) — normalize known aliases before comparing.
export const UNDERLYING_ALIASES = { BSX: 'SENSEX' }

export function parseContract(sym) {
  let m
  // DeltaEx crypto options (server.py's DELTA_OPTION_RE): <C|P>-<BTC|ETH>-<STRIKE>-<DDMMYY>
  // — right comes first here, unlike every india format below.
  if ((m = sym.match(/^([CP])-(BTC|ETH)-(\d+)-\d{6}$/))) return { underlying: m[2], right: m[1], strike: m[3] }
  // TradingView: <UNDERLYING><YYMMDD><C|P><STRIKE>
  if ((m = sym.match(/^([A-Z]+?)\d{6}([CP])(\d+)$/))) return { underlying: m[1], right: m[2], strike: m[3] }
  // SENSEX monthly (no day component): SENSEX<YY><MMM><STRIKE>(CE|PE) — checked
  // before the NFO pattern below since that one's DD slot would otherwise
  // greedily eat the strike's first two digits (confirmed: SENSEX26AUG77300CE
  // was mis-parsed as strike "300" instead of "77300"). Anchored to the
  // literal underlying so it can't also swallow NIFTY/BANKNIFTY symbols.
  if ((m = sym.match(/^(SENSEX)\d{2}[A-Z]{3}(\d+)(CE|PE)$/))) return { underlying: m[1], right: m[3][0], strike: m[2] }
  // NFO (NIFTY/BANKNIFTY): <UNDERLYING><DD><MMM><YY><STRIKE>(CE|PE)
  if ((m = sym.match(/^([A-Z]+?)\d{2}[A-Z]{3}\d{2}(\d+)(CE|PE)$/))) return { underlying: m[1], right: m[3][0], strike: m[2] }
  // BFO weekly (SENSEX etc): <UNDERLYING><YY><1-char month><DD><STRIKE>(CE|PE)
  if ((m = sym.match(/^([A-Z]+?)\d{2}[0-9OND]\d{2}(\d+)(CE|PE)$/))) return { underlying: m[1], right: m[3][0], strike: m[2] }
  return null
}

export function normalizeContract(c) {
  return c && { ...c, underlying: UNDERLYING_ALIASES[c.underlying] || c.underlying }
}
