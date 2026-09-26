# tradingview-clone — project notes

Multi-user trading dashboard: React/Vite chart UI on top of per-user Python
trading bots (india via AngelOne, crypto via DeltaEx). This file is the
"what is this and what's the current state" doc — for exact run commands see
`HOW_TO_RUN.txt` (authoritative, don't duplicate here). **Nothing in this
project auto-starts on a machine reboot** — no launchd/cron entry exists for
it. After a real restart, run `./start.sh` (app) yourself, then start each
user's bots via the Admin panel or manually (see `HOW_TO_RUN.txt`). A new
Claude Code session has no memory of a previous one either — point it at
this file to get back up to speed instead of re-explaining from scratch.
**`WORK_LOG.md`** has the per-session handoff (what changed, which branch, what's pending).

## Architecture

- **Frontend** (`src/`): Vite + React.
  - `Chart.jsx` — lightweight-charts, works for both india and crypto
    (crypto option symbols like `C-BTC-78200-310826` are parsed by
    `contracts.js` and directly chartable, no TradingView resolution step).
  - `TradingPanel.jsx` — manual/AI orders, open-orders table (Save/Exit/
    Delete/Delete-all/View-chart per row).
  - `OrderBook.jsx` — real broker-side order book (every SmartAPI status:
    open/complete/rejected/cancelled/pending), self-scoped per user.
  - `FailedOrders.jsx` — live orders that never executed (rejected or the
    API call itself failed), with the reason, self-scoped per user.
  - `Notifications.jsx` — error/order-status feed scraped from bot logs;
    `scope="self"` (own account, every user has this tab) or `scope="all"`
    (admin-only, every user, relabeled "All Notifications").
  - `Admin.jsx`/`AdminLogs.jsx` — admin panel (add/manage users, live bot
    status, log viewer with 8 bot types including crypto_exit).
  - `Login.jsx`, `AiChat.jsx`, `AiOrderControls.jsx`.
  - `api.js` — backend base URL, patched by `start.sh` on every run.
  - Tab bar (`App.jsx`) and chart toolbar are both responsive (`.tab-bar`/
    `.chart-toolbar` in `index.css`, flex-wrap + a `max-width:700px` media
    query) — added because neither wrapped before and just overflowed.
- **Backend** (`server.py`): FastAPI. Auth, `users.db` (SQLite: username,
  password hash, per-user ports, is_admin), proxies to each user's bot
  processes, starts/stops/tracks them (`_start_bot_process`/`_pid_alive`).
  Notable routes beyond the obvious CRUD: `/api/trading/orderbook`,
  `/api/trading/funds`, `/api/trading/failed-orders` (and crypto
  equivalents), `/api/notifications` (self) vs `/api/admin/notifications`
  (all users), `/api/admin/users/{u}/bots/{bot}/{stop|restart}` for the four
  strategy bots (`storesupportzone`, `store_exit`, `crypto_strategy`,
  `crypto_exit`).
- **Per-user bot processes** (outside this repo, in
  `~/PycharmProjects/pythonProject/SmartApi/`):
  - `webviewdataapi.py` — india dashboard (Flask). Also has `/api/orderbook`,
    `/api/funds`, `/api/failed-orders` routes the backend proxies to.
  - `ai_order_service.py` — india AI/manual orders (Flask).
  - `storesupportzone.py` / `store_exit.py` — india auto-strategy /
    auto-exit (opt-in, no port, two independent processes).
  - `crypto/webviewdataapi.py` — crypto dashboard (Flask), same three extra
    routes as india's.
  - `crypto/stetergy.py` / `crypto/stetergy_exit.py` — crypto auto-strategy /
    auto-exit (opt-in, no port, two independent processes — split from one
    combined process on 2026-08-31).
  - `crypto/placeOrder.py` — the actual DeltaEx order-placement call crypto's
    strategy uses.
  - **The folder you run a script from decides which account it is** — no
    flags. chetan (admin) uses the `SmartApi/` and `SmartApi/crypto/` roots;
    every other user gets `SmartApi/accounts/<user>/` and
    `SmartApi/crypto/accounts/<user>/`.
- **Liveness tracking**: port-listening bots (dashboards, AI-order) are
  checked by port; no-port bots (`storesupportzone.py`, `store_exit.py`,
  `stetergy.py`, `stetergy_exit.py`) are tracked purely via a `<script>.pid`
  file the admin start flow writes into that user's account dir. A process
  started manually from the terminal (not via the admin panel, or via a
  plain `nohup` instead of the restart API) is invisible to the Admin panel
  *and writes its logs to whatever path you gave it* — the dashboard/Logs
  tab/Notifications won't show that output at all. This bit us repeatedly
  this session; always prefer the admin restart API
  (`POST /api/admin/users/{u}/bots/{bot}/restart`) over a manual `nohup` for
  any of the four strategy bots.

## Users & ports (from `users.db`)

| user     | admin | india dash | india AI | crypto dash | crypto strategy |
|----------|-------|-----------:|---------:|-------------:|:----------------:|
| chetan   | yes   | 4100       | 4104     | 4101          | yes |
| testuser | no    | 4110       | 4114     | 4111          | yes |
| paras    | no    | 4120       | 4124     | —             | no |
| kamal    | no    | 4130       | 4134     | —             | no |
| pulkit   | no    | 4140       | 4144     | 4141          | yes |
| vijay    | no    | 4150       | 4154     | —             | no |

All 6 users have india auto-strategy. Only chetan/testuser/pulkit have
crypto accounts. **All 6 are `demo_mode` except chetan**, who has real
AngelOne (india) and real DeltaEx (crypto) credentials — but `withmoney` has
been toggled off on both of chetan's accounts as of this writing, so nothing
is currently placing real-money orders anywhere.

## Known issues / gotchas

- **This Mac runs low on free memory frequently** (has dropped as low as
  15MB free mid-session, several times) — causes silent process kills with
  no crash trace, indistinguishable from a hang unless you check `vm_stat`.
  Check `vm_stat | awk '/Pages free/{print $3*4096/1024/1024 " MB"}'` before
  starting a batch of processes; if it's under ~50MB, expect trouble and
  consider freeing memory first rather than pushing through.
- **The chronic bug pattern this whole session: orphaned duplicate
  processes.** Restarting a strategy bot via anything other than the admin
  restart API (which kills the tracked PID first) leaves the old process
  running alongside the new one — found this independently on chetan's
  india strategy, chetan's crypto strategy, and chetan's crypto exit, each
  more than once. Always check `pgrep -fl "storesupportzone.py\|store_exit.py\|stetergy.py\|stetergy_exit.py"`
  after any manual restart and kill extras — especially for chetan, whose
  root account has no PID-file tracking at all (see blind spot below), so
  the admin flow itself can't catch duplicates there either.
- **AngelOne rate limit**: logins fired too close together get "Access
  denied because of exceeding access rate". Stagger india bot startups
  (~8s worked fine manually); the admin flow already does this. Harmless
  and self-resolving — the underlying call already falls through cleanly.
- **chetan blind spot**: root account's strategy processes have no
  account-dir PID file (predates multiuser), so Admin panel/smoke test
  can't see them — check with
  `pgrep -fl "storesupportzone.py\|store_exit.py\|stetergy.py\|stetergy_exit.py"`.
  (PID files have been manually written for chetan's four strategy bots
  during this session to close this gap partially, but they're not
  automatically maintained — re-check after any restart.)
- **Unbounded recursion on error — found and fixed in 6 places** (all
  2026-09-01): `storesupportzone.py`'s `storesupportlevel()` (×3),
  `store_exit.py`'s `getstoreetoken()` (×2), `crypto/stetergy.py`'s
  `stetergy()` (×1). Each used to call itself again from inside its own
  `except` instead of just logging and letting the next scheduled tick
  retry — a *persistent* error (null config field, bad data) recursed
  forever, one more stack frame every few seconds, until eventual crash.
  Fixed everywhere; a repo-wide AST scan afterward confirmed no other
  self-recursive functions remain except one legitimate bounded case
  (`safe_text()`, recursing over nested dict/list data, not on error).
- **Missing `requests` timeouts caused a real multi-hour hang**: several
  `requests.get/post` calls in `crypto/stetergy.py` and `placeOrder.py` had
  no `timeout=`, so a stalled DeltaEx/Telegram response blocked the entire
  single-threaded scheduler forever with zero CPU usage and no crash —
  confirmed live: `stetergy_exit.py` sat frozen for 3+ hours, no exit
  protection on a real position the whole time. All live network calls
  across `storesupportzone.py`, `store_exit.py`, `ai_order_service.py`,
  `crypto/stetergy.py`, `crypto/placeOrder.py` now have `timeout=10` (15 for
  image uploads).
- **`null` config fields silently break specific behaviors** — each is a
  distinct failure mode, not one bug:
  - `set_otm: null` → crashes `int()` in `checkema_levels()`, now caught
    and logged cleanly (was the unbounded-recursion trigger above).
  - `buy_or_sell_side: null` → `None in ['BOTH','CALL']` is always `False`,
    so **every entry condition is permanently blocked, silently, no error**
    — this was the actual reason chetan's india strategy placed zero orders
    for an extended period despite running fine. Fixed by setting it to
    `'BOTH'`; check any account showing zero orders despite a healthy
    process for this exact field first.
  - crypto `stop_loss: null` → `int(None)` in `stetergy()`, now caught and
    the tick is skipped cleanly (logs "stop_loss is not configured").
  - A contract that's already **expired** (past its date-in-symbol) gets its
    ticker permanently rejected by DeltaEx (`result: None` forever) —
    `exitstetergy()` now detects this via the symbol's own expiry date and
    force-closes the stale position (profit recorded as 0, unknowable) with
    an alert, instead of retrying the dead ticker every 5s forever.
- **Live order ≠ live fill**: `obj.placeOrder()` succeeding only means
  SmartAPI accepted the *submission* — the exchange can still reject it
  afterward (funds, price band, freeze qty). All three india order-placing
  functions now do a follow-up `orderBook()` lookup to catch this, and
  distinguish an IP-whitelist rejection (`errorCode AG7002`, "not a
  registered IP") from an ordinary rejection with its own alert text, since
  only the former has an actionable fix (update the registered IP in the
  SmartAPI developer console — a config change outside this codebase
  entirely). A rejected/failed live order is now recorded in
  `failed_orders.json` (per account) with its reason — never faked as a
  demo trade, since that used to insert a phantom position into the token
  book and silently block re-entry on that symbol.
- **Crypto P&L accuracy**: while a position is open, mark-price-based
  `profit = (ltp - entry) * lotsize` is the right approach (no real fill to
  reference otherwise). Once a *live* exit order actually executes,
  `_accurate_live_profit()` in `crypto/stetergy.py` recomputes profit from
  the real fill price × `contract_value` minus the trading fee instead —
  falls back to the mark-price estimate if fill data isn't present (demo,
  or a missing field). The field names (`average_fill_price`,
  `paid_commission`) are DeltaEx's documented convention but unverified
  against an actual live fill — marked with a `ponytail:` comment.
- **`placeOrder.py` had `size = 10` hardcoded** — every live crypto order
  ignored the real position size. Fixed; this also activated a dormant bug
  in the short-position exit branch (`item['id']` used as DeltaEx's
  `product_id` — wrong instrument) that had never fired live since every
  historical position has been 'buy', never short — fixed defensively too.
- **`storesupportzone.py`'s stoploss-exit branch was missing the
  `storeorderbook()` call** the target-hit branch has — a stoploss exit
  updated the sqlite token book but not the JSON the dashboard reads, so it
  showed "Hold" forever after a real close. Fixed.
- Two processes writing to the same account dir at once (crypto/india) is a
  confirmed real bug — always check nothing's already running before
  starting anything manually.

## Smoke test

`test_full_project.py` — backend health, every real user's bot ports (read
live from `users.db`), account config completeness, and (with
`TEST_ADMIN_PASSWORD`/`TEST_USER_PASSWORD` set) login/admin-gating/impersonation.
Run after any change that touches startup, ports, or account config:

```
.venv/bin/python test_full_project.py
```

## Admin: restart/stop a user's strategy bots

Manage → per-user panel has Restart/Stop button pairs for all four strategy
bots: `storesupportzone`/`store_exit` (india, shown right after the india
config), `crypto_strategy`/`crypto_exit` (crypto, shown in the same block
when provisioned) — independent of the credentials save flow,
so bouncing a stuck bot doesn't require touching API keys. Backend:
`POST /api/admin/users/{username}/bots/{bot}/{stop|restart}` in `server.py`
(`STRATEGY_BOTS` dict), reusing `_kill_pid`/`_start_bot_process`/`_pid_alive`.
**Always use this over a manual `nohup` restart** — see the orphaned-process
gotcha above.

## Market/account analyst (added 2026-09-21)

`analyst.py` — read-only, stdlib-only. Every 3 min (Mon-Fri 09:15-15:30 IST) reads
NIFTY/BANKNIFTY/SENSEX 1-min candles (Yahoo, ~15 min delayed for SENSEX), checks
every account's `auto_trade.json` + real running processes, and appends findings and
recommendations to `~/tradingview-analysis/analysis_log.txt`. **It never starts, stops
or edits anything** (see the no-autonomous-trading rule). Shown to admins only in the
**Analysis** tab (`GET /api/admin/analysis`, `require_admin`). The log is deliberately
outside the repo: Vite's dev server serves every file under its root, tunnel included.
Run: `nohup python3 analyst.py > ~/tradingview-analysis/analyst.out 2>&1 &` (one copy
only — check `pgrep -fl analyst.py`). Check: `python3 analyst.py --selftest` / `--once`.
Sideways = 30-bar efficiency ratio < 0.25 (thresholds are by-eye, tune if it flaps).
Support/resistance: swing highs/lows on 5m/15m/1h/1d, clustered within 0.12%; "strong" =
weight >= 6 AND >= 2 timeframes agree (rebuilt every 15 min). Outlook labels per index:
BREAKOUT_UP/BREAKDOWN (close beyond a strong level) -> "START", COILED (tight range at a
level) -> "PREPARE", RANGE (sideways, no coil) -> "PAUSE", NO_SIGNAL (feed delayed).
SENSEX comes ~15 min delayed from Yahoo, so it never gets live start/breakout signals.
Note: there are now 7 users (Vaibhav added); the table above predates that.
Crypto (added 2026-09-21): same engine, BTC/ETH from Binance's public klines, 24/7, checks the
crypto configs/processes (`stetergy.py`/`stetergy_exit.py`). Files in `~/tradingview-analysis/`:
`analysis_log.txt` (India) and `crypto_analysis_log.txt` — each keeps TODAY only (older days deleted
at the first cycle of a new day); `alerts.jsonl` — trending / trend-coming / near-a-move / big-move
alerts for both markets, kept 7 days, one per kind per symbol per 15 min, fired on a state CHANGE.
App (admin-only): **Alerts** tab (unread badge, polled every 30s), **India Report**, **Crypto Report**;
routes `/api/admin/analysis?market=india|crypto` and `/api/admin/alerts`.
India and crypto are TWO separate processes (`analyst.py --market india|crypto`, different trading
hours), started by start.sh, one copy each. Start/Stop/Restart buttons per market (Alerts tab shows both,
each Report tab its own; `GET /api/admin/analyst/{market}`, `POST /api/admin/analyst/{market}/{start|stop|restart}`)
find them by process pattern, not a pid file, so restart can never leave two copies. Read-only, so stopping
one only stops that market's new reports/alerts. They share alerts.jsonl under a file lock (alerts.lock).
Run without `--market` and it just prints usage (no combined mode).
Order checks (`check_orders`): every open position (token book: india `ordertoken`, crypto `cryptoorderbook`,
open = lotsize>0 and profit 0) is checked each cycle -> alerts `ORDER_WRONG` (against the trend / range-bound
entry / index not enabled / contradicts buy_or_sell_side / duplicate / call+put both open), `ORDER_EXIT`
(expired contract, expiring <=1 day, held overnight (India), no exit bot running, at stop/target but still open,
running into a strong level) and `ORDER_TRAIL` (past half its target and not against the trend). One alert per
NEW reason per order. Live P&L: crypto from the DeltaEx ticker `mark_price` (null result = expired contract);
India only from the dashboard order's `profit` while store_exit is running (otherwise it is stale, so no P&L rules).
India order alerts fire only in market hours (that process sleeps outside them).
**2026-09-22 SSL fix**: analyst.py's fetches intermittently failed with "self-signed certificate in
certificate chain" / "unable to get local issuer certificate" -- same root cause server.py already
works around (the venv's python.org framework build has no working default CA trust store for plain
urllib/ssl). Fixed the same way, `os.environ.setdefault("SSL_CERT_FILE", certifi.where())`, now set
inside analyst.py itself so it's correct regardless of launcher. A one-off diagnostic script using
bare `python3` (Anaconda, different trust store) will NOT reproduce this -- it only shows up under
`.venv/bin/python`, which is what start.sh/server.py's analyst controls actually launch.
A single failed fetch also now retries (3x, backoff) and logs the real reason (`_reason()`), not just
the exception's class name -- that's what surfaced the SSL cause instead of a bare "URLError".

## Status as of 2026-09-12

App (frontend/backend/tunnels) currently stopped. ~24 bot processes still
running from a prior session (dashboards + AI-order services across
several users) — auto-strategy/auto-exit bots are down for most non-chetan
users at last check. Machine uptime is 12+ days — no OS-level restart has
occurred; state drift is entirely from manual starts/stops across this
session. Re-run the smoke test after bringing things back up to get a true
current picture rather than trusting this paragraph.
Index status for everyone (added 2026-09-24): each analyst cycle also overwrites
`~/tradingview-analysis/{india,crypto}_market_state.json` (per index: state SIDEWAYS/TRENDING_UP/
TRENDING_DOWN/MIXED, outlook label/text, delayed flag). `GET /api/market-state?market=` serves it to
any logged-in user (market data, not account data); the Trading panel shows it beside each index
checkbox with that index's newest market alert today. Order alerts (ORDER_*) show only on OPEN
positions, newest one only, in the Trading order table and the chart's Pending-order box
(`src/orderAlerts.jsx`).
Broker mode (added 2026-09-24): when an india account's SAVED `withmoney` is true, the Trading panel
replaces the DB-backed "Open / recent orders" (storeorder) and "Trade history" (ordertoken) tables with
the broker's own data: positions (`obj.position()` via webviewdataapi `/api/positions` ->
`/api/trading/positions`) and today's order book (`/api/trading/orderbook`), polled every 8s. Exit still
goes through the existing exit route, which sells the DB-recorded qty, not the broker's net qty.
Crypto has no broker routes yet (DeltaEx positions/order book not wired).

## Live money (branch `live_changes`, 2026-09-24)

`SmartApi/live_trade.py` is the only real-money path; every change is behind withmoney or a position
recorded as live, and paper is unchanged (`SmartApi/test_paper_unchanged.py`). A position's mode is fixed
at entry in the `live_orders` table (database.db): paper positions always exit on paper, live ones always at
the broker. Live entries: guards first (dashboard "Stop new live trades" = `live_halt`, "Max daily loss" =
`live_max_daily_loss`, funds, one live copy per bot per account via `.<bot>.live.lock`), then fill
confirmation (broker qty/avg price recorded), then a STOPLOSS_LIMIT sell at the broker (trigger = fill -
stoploss points, kept in sync by store_exit). Exits cancel the SL and sell the broker's net qty; an SL filled
at the broker or a close in the AngelOne app closes the record. Live positions square off at 15:10. Live
option selling is hedged only: the hedge BUY is confirmed before the short SELL (hedge sold back if the short
doesn't fill), the pair is recorded together (`hedge_pos_id`, not "short id - 1"), a STOPLOSS_LIMIT BUY sits
at the broker for the short, and exits cover the short first and only then sell the hedge (a failed hedge sale
is retried every exit tick, status `hedge_open`). Unhedged live selling is refused. Before going live: `cd SmartApi && ../venv/bin/python live_preflight.py`
(read-only), then a supervised 1-lot test. Tests: `test_live_trade.py` (fake broker), `test_paper_unchanged.py`.

## Crypto futures mode (2026-09-26, branch live_changes)

Crypto Trading panel → "Trade in: Options / Futures" (`instrument` in auto_trade_crypto.json;
unset = options, unchanged). Futures: same signals/filters in crypto/stetergy.py; bullish entries
(buycall/sellput) BUY the coin's DeltaEx India perpetual (BTCUSD id 27, 0.001 BTC/contract; ETHUSD
id 3136, 0.01 ETH/contract), bearish (buyput/sellcall) SELL it; one futures position per coin;
`futures_qty` contracts; `futures_target_points` / `futures_loss_points` in USD of the coin's price
(blank = option points). P&L = move × contracts × contract value (USD). Shorts close with a
reduce-only BUY. Futures orders send no leverage field → the leverage set per product in the
DeltaEx account applies (DeltaEx default is 200× — set it before trading live). Tests:
`cd SmartApi/crypto && ../../venv/bin/python test_crypto_futures.py` (16 checks, offline).
