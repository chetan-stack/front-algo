// Settings form -> body for POST /api/trading/config or /api/crypto/trading/config.
// Shared by the Trading panel and the Admin tab's per-user checkboxes. The dashboard's
// config route REPLACES every field from the body, so always send the full form.
export function configPayload(config, selectclient, market) {
  // update_dashboard_config reads these back under different keys than
  // /api/dashboard returns them under (NIFTY -> trade_nifty, etc.) —
  // without this, they silently read as undefined and get saved as false.
  const payload = {
    ...config,
    selectclient,
    trade_nifty: config.NIFTY,
    trade_banknifty: config.BANKNIFTY,
    trade_SENSEX: config.SENSEX,
    trade_btcusd: config.BTCUSD,
    trade_ethusd: config.ETHUSD,
    trade_xautusd: config.XAUTUSD,
  }
  if (market === 'crypto') {
    // The Buy/Sell and Trade-in dropdowns SHOW a default when nothing is saved,
    // but the unset value was sent as-is — buy_or_sell was saved as null and the
    // crypto strategy (which checks == 'BUY' / 'SELL') never entered at all.
    payload.instrument = config.instrument || 'options'
    payload.buy_or_sell = config.buy_or_sell || 'BUY'
    if (payload.instrument === 'options' && payload.buy_or_sell === 'BOTH') payload.buy_or_sell = 'BUY'  // BOTH is futures-only
  }
  return payload
}
