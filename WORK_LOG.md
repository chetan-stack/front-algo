# Work log — handoff between sessions

Read this together with `PROJECT_NOTES.md` (architecture + gotchas) and `HOW_TO_RUN.txt`
(commands). Newest entry first. Each entry says what changed, where, and what is still
pending, so a new session can pick up without the old conversation.

---

## 2026-09-26 — crypto futures mode (crypto only; India untouched)

- Crypto Trading panel "Trade in: Options / Futures" + futures contracts / target $ / stoploss $.
  Same strategy; bullish → BUY perpetual (BTCUSD/ETHUSD), bearish → SELL. USD P&L with contract
  value. Commits: pythonProject cceb40a, tradingview-clone 0e87a22 (+ notes) on live_changes.
- Fixed along the way (crypto): short exits used 'sell' (now reduce-only BUY); dashboard manual
  exit BUY wasn't reduce-only; product_id sent as text from sqlite; invalid side crashed; the
  Buy/Sell dropdown showed BUY but saved null → chetan's crypto buy_or_sell is None → the crypto
  strategy has NEVER entered since. Saving the crypto config once fixes it.
- Crypto dashboard follows the saved Trade in: trades/open orders/totals only for that instrument;
  other instrument's open positions listed read-only (hidden_open), still managed by the exit bot.
- Tests: SmartApi/crypto/test_crypto_futures.py 17/17; India test_all_trading 40/40 (unchanged).
- NEEDS: restart crypto dashboard (4101), crypto stetergy/stetergy_exit for each crypto account
  (Admin → Restart), crypto analyst; hard-refresh. Set leverage for BTCUSD/ETHUSD in the DeltaEx
  app before live (default 200×). Set futures target/stoploss $ (blank falls back to option
  points 200/10 — a $10 BTC stop would hit almost immediately).

---

## 2026-09-25 — first live trades, AngelOne rate limits

- User went live on chetan (withmoney ON, auto_place_order ON, set_otm 1000, lotsize 1):
  10:47 BUY 65 NIFTY29SEP2622100PE @3.40 → 10:49 SELL @3.35 (closed correctly);
  10:50 BUY 65 @3.40 (open at 10:51). No broker SL was placed: loss_points 10 > premium
  3.40 (trigger < 0) — for cheap far-OTM options set stoploss points below the premium.
- Chart Exit failed: "Access denied because of exceeding access rate" — the exit route's
  ltpData (P&L text only) was rate-limited before any order was sent.
- AngelOne SmartAPI limits (per account/API key, shared by ALL processes): login 1/s,
  getOrderBook 1/s, getPosition 1/s, getRMS 2/s, ltpData 10/s (500/min), getCandleData 3/s
  (180/min), place/modify/cancel 20/s (500/min). Source: SmartAPI forum topic 4387.
- Fixes on `live_changes` (commits 2a9fcd8, b6fa885 pythonProject; a6538d5 tradingview-clone):
  live_trade.call() retries "exceeding access rate" (1/2/3s — AngelOne refuses before
  processing, no double order); exit LTP falls back to the live feed; `broker_read()` =
  one cache file per method per account dir + lock → at most 1 real orderBook/position call
  per 1.05s across bots/dashboard/tabs (decision reads fresh=True: only data fetched after
  the call began); dashboard order-book route reports errors instead of an empty book;
  Trading panel / Order Book poll every 15s and not while hidden. test_all_trading 37/37.
- Manage manual positions (commits on live_changes): Trading panel broker table → "Manage"
  on an open LONG index option placed in the AngelOne app → `webviewdataapi.adopt_position`
  records it live with broker qty/avg/product type, places the broker SL, creates storeorder
  → store_exit manages it (target/SL, 15:10 square-off only if INTRADAY), Exit button, chart
  box, alerts. Manual shorts refused. live_trade now stores `product` per position and uses
  it for SL/exit orders and net-qty checks. test_all_trading 38/38.
- 11:21 trade NIFTY29SEP2623100CE: bought 65 @129.85, broker SL @119.85 placed OK; user's
  Exit at 11:24:51-11:25:15 failed: dashboard session (fresh at 11:08) already 'Invalid Token'
  AB1007 on cancelOrder/placeOrder — SmartConnect.placeOrder returns None on that, so no
  re-login happened; failed-exit path dropped the SL id; the original broker SL (never
  cancelled) sold 65 @119.85 at 11:25:33 (−₹650). Fixed (commit on live_changes): order calls
  via placeOrderFullResponse + checked cancel/modify with re-login, loud alert on failed SL,
  keep a live SL on failed exit, record real fill price for unrecognised closes. 40/40 tests.
  STILL UNKNOWN: why AngelOne sessions die ~15 min after login (strategy's getRMS also
  Invalid Token 11:21:36). Online sources only say AB1007 = expired session (normally lasts
  till midnight). Self-healing re-login covers it; root cause open.
- Strategy strike selection fixed (commit on live_changes): OTM offset was only used on a
  sell_signal (CE+PE from one strike); buy_signal/EMA-support entries bought ATM (why 11:21
  bought 23100CE with set_otm 1000). Now CE = spot+offset, PE = spot−offset for every entry,
  buy or sell mode; sell-side hedge 1000 beyond the sold strike. Affects ALL accounts' auto
  entries (offset 0 = ATM unchanged). chetan's set_otm is 1000 → ₹1-3 far-OTM options.
- Dashboard (4100) getRMS "Invalid Token" since 10:26 while positions worked — NOT caused
  by other logins or generateToken (tested). Unexplained; restart the dashboard and recheck.
- NEEDS RESTART to take effect: chetan's dashboard + order service (4100/4104) and
  storesupportzone/store_exit (Admin → Restart). Live positions stay tracked (live_orders).
- Ideas not built: switch non-live chart /api/quote polling to the tick feed, server-side
  chart-history cache, exit bot candles once a minute, separate API key for charts.

---

## 2026-09-24 17:30 — switched both repos to `live_changes`

- Backup of every account's database.db / auto_trade*.json / failed_orders.json + users.db:
  `~/tradingview-backups/2026-09-24-pre-live_changes/` (verified identical after the switch).
- `multiusers` got checkpoint commits (pythonProject 418a860, tradingview-clone 78f5c60) =
  complete ROLLBACK point. Worktrees `~/live_changes/*` removed; both main folders are now
  on `live_changes` (checked out, NOT merged into multiusers).
- Checks on the switched code: test_all_trading.py 35/35, frontend build OK,
  test_full_project.py 33 pass / 20 fail (only strategy bots not running), live_preflight.py
  READY (chetan: login/profile/funds/positions/order book OK; public IP 103.87.51.26 —
  user must confirm it matches the SmartAPI console; available cash ₹9,917 → enough for a
  1-lot buy, NOT for a hedged sell (~₹40-50k margin, the funds guard will block it)).
- Open paper positions on demo accounts left as-is (testuser india 1 = stale expired
  NIFTY22SEP2623300CE; pulkit crypto 2; testuser crypto 1) — the new code keeps them paper.
- NEXT (user): restart everything so the new code runs — `./start.sh` (backend/frontend),
  chetan's dashboard + order service, every user's strategy/exit bots via Admin Restart (a
  few at a time, memory), both analysts. Then 1-2 market days on paper, then a supervised
  1-lot live buy (withmoney on, Max daily loss set), then merge live_changes → multiusers.
- ROLLBACK: `git checkout multiusers` in both repos + restart (close any LIVE position in the
  AngelOne app first — multiusers code doesn't know about live positions).

---

## 2026-09-23 → 2026-09-24 (one long session)

### State at the end (checked 2026-09-24 17:17 IST)

- **Two git branches in play, in BOTH repos** (`~/tradingview-clone` and
  `~/PycharmProjects/pythonProject`):
  - `multiusers` — what is checked out and RUNNING. Has uncommitted work from this
    session (see "On multiusers" below). Not committed by Claude.
  - `live_changes` — real-money safety work, **committed, NOT merged, NOT running**.
    Lives in separate git worktrees: `~/live_changes/tradingview-clone` and
    `~/live_changes/pythonProject`. Its first commit carries over the uncommitted
    multiusers code, so `live_changes` = multiusers work + live-money work.
- Running: backend (4001) and chetan's india dashboard (4100) + order service (4104),
  all restarted 14:56 on 24 Sep → they have the multiusers changes below.
- NOT running at 17:17: both analysts (`analyst.py --market india|crypto`; no
  `india_market_state.json` yet), chetan's `storesupportzone` / `store_exit`, crypto bots.
  Other users' strategy bots have been down for days (not caused by this session).
- chetan: `withmoney` OFF (paper), `auto_place_order` OFF, `set_otm` 0.
- Mac memory: swap ~6/7 GB used — processes get killed silently. "Pages free" in vm_stat
  is misleading; use `sysctl vm.swapusage` / `memory_pressure`.

### Still to do (user actions)

1. Restart both analysts (Alerts tab → Restart India / Start Crypto) so
   `~/tradingview-analysis/{india,crypto}_market_state.json` exist — needed for the index
   status badges.
2. Decide on `live_changes`: merge into `multiusers` in both repos, then restart with NO
   open positions, run `SmartApi/live_preflight.py`, then supervised 1-lot live tests
   (one buy, one hedged sell). Until merged, real money has none of the protections below.
3. Change chetan's AngelOne password (old store_exit printed it into
   `logs/SmartApi_store_exit.log`; the print is removed).
4. Stale row: `NIFTY29SEP2623500PE` (exited 23 Sep 14:35, +₹5,785) may still show `hold`
   in auto_trade.json storeorder — Delete it in the Trading panel.

### On `multiusers` (running, uncommitted)

Bots (`~/PycharmProjects/pythonProject/SmartApi/`):
- `angel_login.py` (new): AngelOne login retried 6×10s on "exceeding access rate". Used by
  webviewdataapi, ai_order_service, storesupportzone, store_exit. Root cause of chetan's
  dashboard (port 4100, "Failed to fetch") and store_exit crashing at startup.
- `webviewdataapi.py` + `crypto/webviewdataapi.py`: removed Flask `debug=True` (reloader
  doubled every dashboard process ~200-300MB each, and exposed the Werkzeug debugger).
- `store_exit.py`:
  - storeorderbook keeps an order's own target/SL points while it's on hold (chart edits
    used to be overwritten with the global 10/10 every tick);
  - re-reads storeorder AFTER updating it (stale "0/0" points made every re-entry of a
    symbol exit on its first tick — "my manual order exited immediately");
  - `still_open(id)` re-check before writing, so a manual exit mid-tick isn't overwritten
    back to hold.
- `ai_order_service.py` / `webviewdataapi.py`: chart/AI "Buy CE/PE" uses the dashboard
  OTM offset (CE = spot + offset, PE = spot − offset; 0 = ATM). Strikes still round to 100
  (NIFTY x50 strikes unreachable — known, not changed).
- `webviewdataapi.py`: `/api/positions` (broker positions), `createdAt` on pending orders;
  crypto dashboard also has `createdAt`.

App (`~/tradingview-clone`):
- `live_feed.py`: AngelOne live websocket now detects a dead connection (library's on_close
  crashes on this websocket-client version), reconnects and re-subscribes; a failed
  subscribe no longer leaves a stuck entry. Cause of "Live feed for NSE:NIFTY hasn't
  returned data in 15s" after a network blip at 12:07 on 24 Sep.
- `server.py`: `/api/trading/positions` proxy; `/api/market-state?market=` (any logged-in
  user) = analyst's per-index state + newest market alert today per index.
- `analyst.py`: writes `{market}_market_state.json` each cycle incl. `explain()` reasons
  (trend, efficiency ratio, EMA, 3-min move, day %, strong S/R, outlook, delay).
- Frontend (`src/`):
  - `Chart.jsx`: order box matches the OPEN order (not an old exited one of the same strike
    with another expiry); live/poll candles fold into the right 1m/5m/15m bucket
    (`foldIntoCandle`); countdown uses exchange time from live ticks; draggable/collapsible
    overlay boxes (`FloatPanel`); saved chart state for presets.
  - `App.jsx`: 1/2/4 screens for EVERY tab, per-screen tab dropdown, saved layout presets
    (localStorage `screenPresets`: screens, tabs, chart symbol/interval/live per screen).
  - `orderAlerts.jsx` (new): newest analyst ORDER_* alert on OPEN positions (Trading table
    row highlight + chart order box); index status badge + tooltip reasons next to the
    NIFTY/BANKNIFTY/SENSEX/BTC/ETH checkboxes (ticked or not).
  - `TradingPanel.jsx`: when saved `withmoney` is on (india), tables show broker positions
    and broker order book instead of the bot's DB.

Findings worth remembering:
- Chart history for indices is often 15 min late: AngelOne `getCandleData` returns "Too
  many requests" and `fetch()` falls back to anonymous tvDatafeed (NSE indices delayed
  15 min for non-logged-in TradingView). Bots' signals/exits use AngelOne directly and are
  NOT delayed; only chart history, `/api/quote` and the chart's spot for strike selection
  can be. Proposed (not built): server-side candle cache / build candles from live ticks.
- Scaling to many clients (discussion only): share market data once (one feed, one signal
  engine), per-client only settings + orders. Current per-user processes won't scale
  (~1-1.5 GB per user, shared AngelOne rate limit).

### On `live_changes` (committed, not merged) — real-money safety

Everything is behind `withmoney` or a position recorded as live; paper is unchanged.
**Run every check (paper + live, offline, fake broker):**
`cd ~/live_changes/pythonProject/SmartApi && ~/PycharmProjects/pythonProject/venv/bin/python test_all_trading.py`
(35/35 passed on 2026-09-24; exit code 1 on any failure). Re-run it after ANY change to an order path.
Core: `SmartApi/live_trade.py`. Tests: `SmartApi/test_live_trade.py` (26 checks, fake
AngelOne broker), `SmartApi/test_paper_unchanged.py` (3 checks). Run from `SmartApi/` with
`../venv/bin/python` (the worktree has no venv: use `~/PycharmProjects/pythonProject/venv/bin/python`).

Buy side:
- Position mode fixed at entry (`live_orders` table in database.db): paper positions always
  exit on paper, live ones at the broker — flipping withmoney with a paper position open
  used to send a REAL sell (naked short).
- Fill confirmation (wait for complete/rejected/cancelled, cancel after 15s), record broker
  filled qty + avg price (not LTP). Dashboard's place_order had no check at all.
- STOPLOSS_LIMIT SELL at the broker after each entry, synced to stoploss points.
- Exits sell the broker's net qty, cancel SL first; SL fill / close in app reconciled.
- Guards: kill switch `live_halt` and `live_max_daily_loss` (Trading panel, shown when With
  money is ticked), funds check, one live copy per bot (`.<bot>.live.lock`).
- 15:10 square-off; re-login once on expired session.
Sell side (hedged option selling):
- Entry: broker margin for both legs → BUY hedge, confirm → only then SELL main (qty =
  hedge filled); short not filled → hedge sold back. Pair recorded via `hedge_pos_id`
  (paper still uses "short id − 1"). STOPLOSS_LIMIT BUY at broker for the short.
- Exit: cancel SL → cover net short, confirm → only then sell hedge. Failed cover keeps the
  hedge + new SL; failed hedge sale retried each tick (`status='hedge_open'`).
- Unhedged live selling refused. Sell side still 1 lot, hedge ±1000 index points.
Also: `SmartApi/live_preflight.py` — read-only readiness check (login, funds, public IP vs
registered static IP, loss_points > 0, no open paper positions).

Not covered yet: crypto (DeltaEx) live protection, LIMIT instead of MARKET orders, strike
rounding to 100, shared AngelOne rate limit, running on a VPS.
