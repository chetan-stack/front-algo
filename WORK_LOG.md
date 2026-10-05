# Work log — handoff between sessions

Read this together with `PROJECT_NOTES.md` (architecture + gotchas) and `HOW_TO_RUN.txt`
(commands). Newest entry first. Each entry says what changed, where, and what is still
pending, so a new session can pick up without the old conversation.

---

## 2026-10-05 — Admin: one button restarts every user's strategy + exit bot (uncommitted)

- `POST /api/admin/bots/restart-all` (server.py, require_admin): for every user with auto_trade.json,
  restarts storesupportzone then store_exit with the existing kill-tracked-PID-then-start steps (no
  duplicates). Real accounts are spaced 8s apart (AngelOne login limit), demo 2s. ~1 min for 7 users.
  India only (crypto bots aren't included).
- Admin.jsx: "Restart all strategy + exit bots" button next to the Users heading, with a confirm and a
  per-user 🟢/🔴 result.
- Also `POST /api/admin/bots/stop-all` + red "Stop all strategy + exit bots" button (confirm warns that
  open positions aren't watched while stopped). Reports any bot still alive after the stop.
- Test: test_restart_all.py 7/7. vite build ok. NEEDS: backend restart (the frontend reloads by itself).

---

## 2026-10-05 — exit bot: live price only, no candle call (uncommitted, pythonProject)

- store_exit.getstoreetoken no longer fetches candles (removed get_historical_data and the
  live_candle_client import). It calls exitstetergy([], [], item) / exitstetergysell([], [], item, hedge),
  the same path that already ran whenever a candle call failed. Exits decide on get_ltp_data only
  (demo: websocket tick < 20s, else /api/ltp REST; live: own ltpData).
- Lost: only log lines (the candle dump and "sell signal" print). No exit logic used the candles.
- Expected: the shared account's candle refusals (3.3% at 15:00–15:30) drop sharply, since the exit
  bot was the biggest candle caller.
- Tests: test_exit_no_candles.py 5/5 (new), all other suites pass.
- NEEDS: store_exit restart for every account (after the backend restart for /api/ltp).

---

## 2026-10-05 — exit bot never decides on a stale price (uncommitted, both repos)

- The exit decision uses only LTP. Demo accounts get it from the backend's shared websocket feed
  (one AngelOne subscription per contract, ticks pushed to every user's bot), but
  `live_ltp_client.get_ltp()` returned the LAST tick forever if the feed stalled.
- `get_ltp(..., max_age=None)`: optional age limit (default unchanged for the entry bot / AI service).
  `get_rest_ltp()` calls the new backend `/api/ltp` (ltpData on the shared session, 2s cache per token).
- `store_exit.get_ltp_data` (demo): websocket tick if younger than `LTP_MAX_AGE` = 20s, else REST
  price, else raise (that position is skipped until the next 5s tick, and logged). Live accounts unchanged
  (own ltpData every check).
- Tests: test_exit_ltp.py 8/8, test_rest_ltp.py 4/4 (new), all other suites pass.
- NEEDS: backend restart (for /api/ltp), then store_exit restart for every account.

---

## 2026-10-05 — candle load: exit-bot cache, one fetch per contract, own login for live users (uncommitted)

- store_exit keeps fetching candles every 5s tick (user decision: no exit-bot candle cache).
- server.py /api/historical-candle: cache key (exch, token, interval), holding the WIDEST window asked for
  (within 2 days), and each caller gets its slice. Entry (yesterday 09:15) + exit (today 09:15) = one AngelOne call.
- live_candle_client: accounts/<user>/ with its own login (obj) fetches with its own AngelOne account first
  (separate limit), throttled across that account's processes via `.candle_rate.lock` (0.4s gap), with the
  shared backend as fallback. chetan (root = the shared account) and demo accounts are unchanged: backend first.
- Not done (on purpose): serving old candles + live price on a refusal. The backend has no live price for
  most option tokens without another call, and a stale last bar could trigger an entry on old data.
  Revisit if refusals stay high after this.
- Tests: test_candle_sources.py 11/11 (new), test_candle_cache.py 5/5 (checks 3–4 rewritten for the new
  cache), all other suites pass.
- NEEDS: backend restart, plus storesupportzone + store_exit restart for every account. Then measure 1 h.

---

## 2026-10-05 11:52–13:54 — 2 h paper test of per-index points (report: ~/Desktop/trading_test_report_2026-10-05.md)

- Config set directly in all 7 auto_trade.json at ~11:40: index_points NIFTY 17/17, BANKNIFTY 86/57, SENSEX
  44/44; stop_loss (daily stoploss limit) 50. Backup: ~/tradingview-backups/2026-10-05-pre-index-points/.
- 56 orders: all 47 exits at the index's points with the right reason, P&L arithmetic correct, closed P&L
  +₹43,002 (morning: −₹12,137). Median hold 475s (morning ~60s). No duplicates or crashes. Candle 502s 6.2–6.7%.
- Bug found and fixed: store_exit wrote the GLOBAL points onto an order when it exited (display only, the
  exit decision was right). Now uses points_for. test_index_points_flow.py 14/14. NEEDS store_exit restart.
- Still to do: restart the India analyst (suggestions), rate-limit throttle/stagger, commit.

---

## 2026-10-05 — per-index target/stoploss + suggested points (uncommitted, both repos)

- `SmartApi/index_points.py`: `points_for(cfg, symbol)` gives (loss, target) from
  auto_trade.json `index_points[NIFTY|BANKNIFTY|SENSEX]`, with blank falling back to global
  target_points/loss_points. `clean()` filters what the dashboard may save. Self-check: run the file.
- Used at entry (storesupportzone placeemabuyorder + live hedged short, webviewdataapi live_entry +
  adopt) and on store_exit's first 'hold' write (covers AI/manual entries). The exit already uses each
  order's own storeorder points, so open positions keep the points they entered with.
- webviewdataapi `/api/dashboard/config` saves `index_points` when sent.
- `analyst.py suggest_points()`: stoploss = max(5, round(0.5 × 1-min ATR × 3)); target = 2× (trending),
  1× (sideways), 1.5× (mixed). Goes in `{market}_market_state.json` → `/api/market-state` → Trading
  panel: "Suggested now: target X / stoploss Y [Use]" beside each index's inputs (hover shows why).
- Tests: test_all_trading 40/40, test_live_trade 31/31 (loader gets index_points), paper 3/3,
  sl_cooldown 12/12, analyst --selftest ok, vite build ok.
- NEEDS: restart every india dashboard (webviewdataapi, otherwise index_points is silently not saved),
  the strategy + exit bots (Admin → Restart), and the India analyst (Alerts tab → Restart).

---

## 2026-10-05 — exit reasons, stoploss cooldown, chart folder (pythonProject, data_cache, uncommitted)

- `store_exit.py`: new `exit_note()` used by every exit message. It says the real reason:
  "Exit by Target hit (+10 pts)", "Stoploss hit (-10 pts)", "EOD square-off", "exit requested",
  "broker (...)", "live short cover (...)". It used to always say "Exit by EMA". "Profit/Loss" now
  appears once, rounded to 2 decimals, still in the format the dashboard parsers read.
- `storesupportzone.py`: `sl_cooldown_reason()` runs in ce_format/pe_format before the AI check.
  After a losing exit on the same index + side (CE/PE), no new buy for `sl_cooldown_minutes`
  (auto_trade.json, default 5). Exception (strong confirmation): the same option trades back above
  the stopped trade's buy price. A skip is printed in the bot log, with no Telegram alert. Covers the
  buy paths only, not option selling.
- `storesupportzone.py`: `os.makedirs("static")` at startup, so demo accounts can save the chart and
  their entry alert is sent.
- Tests: test_sl_cooldown.py 12/12 (replays the Oct 5 whipsaw), test_all_trading 40/40, test_live_trade
  31/31, test_paper_unchanged 3/3.
- NEEDS: Admin → Restart storesupportzone + store_exit for each account to load it.

---

## 2026-10-04 — candle rate limit: stop the re-login cascade (branch data_cache, uncommitted)

- Oct 1 backend.log (after the shared-fetch commit dbed7b5): 894 of 4746 /api/historical-candle
  requests got a 502, and 2276 new SmartConnect sessions were created in one day. Cause: on ANY
  exception, `live_feed.get_historical_candles` logged in again and retried right away, so each
  rate-limit error cost an extra login plus a retry, which kept the account over the limit. On a 502,
  chetan's bots then called getCandleData directly on the same AngelOne account (bot logs: 55
  "exceeding access rate" errors, 12:10–13:24).
- Fix: on a rate-limit error or timeout, every caller backs off 1s and it retries (3 tries total).
  It logs in again only on other errors. `live_candle_client`: a 502 from the backend means no
  own-session fallback (same account); the fallback is used only when the backend is unreachable.
  The 502 body (the AngelOne reason) is now printed in the bot log.
- Tests: test_candle_cache.py 5/5; client fallback checked with mocks.
- NEEDS: backend restart + chetan's storesupportzone/store_exit (Admin → Restart). Then grep
  backend.log for "in pool" (should be only a handful a day) and the bot logs for "exceeding".
- RESULT 2026-10-05 09:39–10:40 (paper): candle 502s 6.9% (was 18.8%), backend logins 2 (was 2,276/day).
  Still rate-limited, so something else on chetan's key uses the limit. Full report:
  `~/tradingview-analysis/live_test_report_2026-10-05.md` (also: demo accounts never send the entry alert
  because `static/chart.png` is missing; vijay and all crypto strategy bots are not running).
- PLAN (done): live test Mon 2026-10-05 in market hours, 30–60 min of normal traffic. A stress test on
  chetan's real account was declined (load script left in that session's scratchpad, not needed).

---

## 2026-09-29 — AI Chat tab + all AI on Claude Code (no OpenAI, no API key)

- New tab **AI Chat** (`src/AiChatTab.jsx`, wired in `src/App.jsx` TABS/renderView) —
  Claude/ChatGPT-style chat: news (web search), chart explanation, levels, patterns,
  strategies, India + crypto. Attach/paste a chart screenshot. History in localStorage.
- Backend `ai_chat.py` (imported in server.py as `claude_ai`): every AI call runs the local
  **Claude Code CLI** headless (`claude -p`, stream-json, owner's claude.ai Pro login) in an empty
  temp dir with ONLY WebSearch/WebFetch, no user settings/hooks/MCP — no Bash/Read, so web content
  can't reach files/broker keys. Max 2 at once (Semaphore), 240s timeout, process killed if the
  browser leaves.
  - `POST /api/ai/claude-chat` streams NDJSON (`text`/`status`/`plan`/`error`/`done`). Candles
    (5m×120 + D×60 from our /api/ohlcv) for symbols named in the question (EXCHANGE:SYM, nifty,
    bank nifty, sensex, btc, eth) or else the open charts go into the prompt. Claude ends with a
    ```plan JSON block → held back from the text, sent as a plan card.
  - Chart panel assistant switched from OpenAI to Claude Code: `/api/ai/chat` (explicit "place
    order on X" → Claude answers `ORDER {...}` → same ai-enter-option-order as before, now also
    passes the user correctly) and `/api/ai/analyze` (JSON levels). OPENAI_API_KEY no longer used.
- Plan card: "Add levels to chart" writes `chartDrawings` (sr + ai-trade) and opens the chart;
  "Place order…" only for India index option buy_ce/buy_pe → /api/trading/ai-enter-option-order
  after a confirm(). Claude never places orders from the AI Chat tab.
- Verified live (before backend restart, run in-process): NIFTY levels question 43s with real
  candles + plan card; /api/ai/analyze 200 JSON; /api/ai/chat 200.
- Test: `.venv/bin/python test_ai_chat.py` (offline, Claude Code stubbed).
- Caveat: runs on the owner's Pro subscription (shared usage limits with his own Claude Code use;
  a subscription is for personal use — for other users on the dashboard, an API key is the proper route).
- Later same day: AI Chat tab uses `--model sonnet` (11s vs 43s answers); chart panel keeps the
  default model. All users can chat; non-admins get 5 AI questions per IST day (chat tab + chart
  panel share the count), admins unlimited. Counts in `ai_usage.json` (gitignored, resets daily);
  failed answers are refunded. 429 when over; tab shows "N of 5 left today" (`GET /api/ai/quota`).
  Limit = `DAILY_LIMIT` in ai_chat.py.
- Voice in AI Chat (frontend only, `src/AiChatTab.jsx`): 🎤 = browser Web Speech API speech-to-text
  (Chrome/Edge/Safari; hidden on Firefox; needs https or localhost), auto-sends when you stop talking;
  "Read answers aloud" = speechSynthesis, sentence by sentence; English (India) / Hindi. Free, no library.
  Voice picker: most natural browser voice auto-picked (Natural/Neural > Premium/Enhanced > Google >
  rest; ★ in list), sample plays on change, choice remembered. This Mac only has basic Rishi/Lekha.
- Human voice (same in every browser): `tts.py` router — Kokoro-82M (Apache-2.0) via kokoro-onnx 0.6.1
  in .venv, local CPU, free. Model files in `models/` (gitignored): kokoro-v1.0.onnx + voices-v1.0.bin
  from github.com/thewh1teagle/kokoro-onnx releases model-files-v1.0 (int8 file was 2.5x slower on this
  i7-8850H, deleted). `GET /api/ai/voices`, `POST /api/ai/tts {text, voice}` → WAV (≤600 chars).
  10 voices (US/UK English, Hindi); Devanagari text read with Hindi phonemes. Loaded on first use
  (~600MB in the backend), one synthesis at a time; ~2x real time. Frontend asks sentence groups and
  plays one while fetching the next; falls back to browser speechSynthesis if the backend can't.
  Self-check: `.venv/bin/python tts.py`.
- NEEDS: backend restart to load it.

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
- 2026-09-28: crypto Buy/Sell gets BOTH. Futures: BUY = longs only, SELL = shorts only, BOTH = long+short
  (futures+BUY used to trade both directions). Options unchanged. 19/19 crypto checks.
- 2026-09-28 09:30 BTCUSD futures SHORT id 730 @83241 (paper) not on the dashboard: crypto exit bot
  crashed every tick on float(None) — option target/loss_points were None (wiped by a dashboard save
  2026-09-26 12:30) and were read before the futures points. Position unmanaged until the exit bot is
  restarted with the fix. Fixed: futures use own points, safe reads, one alert + skip if no points;
  dashboard keeps option points and refuses configs without target+stop for the active mode. 22/22.
- Crypto View chart (like India): futures open DELTA:BTCUSD/ETHUSD (DeltaEx candles/ticker/live);
  entry/target/stoploss drawn by signed qty (short: target below); status lower-cased. 23/23.
- Crypto settings wiped to {'profit'} (Sat 12:29, today 09:18, 10:22): dashboard saved the whole file on
  every page load, non-atomically; a racing read returned {} and was saved back. Fixed (commit a1f269b):
  atomic saves, no save on page load, unreadable file never overwritten. Settings restored 10:3x from
  the dashboard log's last full save (09:54:44) + option points 200/10. NEEDS crypto dashboard restart
  — the old one (running since Sat) can still wipe until then. 25/25 crypto checks.
- Frontend: futures View chart opens BINANCE:BTCUSDT/ETHUSDT (user's choice); P&L shown with cents
  (src/pnl.js fmtPnl; was rounded to 0); Trading panel refreshes itself on tab/window return and on any
  chart change (India + crypto), plus every 10s for open crypto positions once the new crypto dashboard runs.
- Crypto manual Exit (chart/panel) failed 'SQLite objects created in a thread...': crete_update_table used an
  import-time connection from Flask request threads. Fixed: connection per call. 26/26 crypto checks.
- Tests: SmartApi/crypto/test_crypto_futures.py 26/26; India test_all_trading 40/40 (unchanged).
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
