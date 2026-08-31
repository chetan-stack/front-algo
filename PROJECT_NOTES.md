# tradingview-clone — project notes

Multi-user trading dashboard: React/Vite chart UI on top of per-user Python
trading bots (india via AngelOne, crypto via DeltaEx). This file is the
"what is this and what's the current state" doc — for exact run commands see
`HOW_TO_RUN.txt` (authoritative, don't duplicate here).

## Architecture

- **Frontend** (`src/`): Vite + React. `Chart.jsx` (lightweight-charts),
  `TradingPanel.jsx` (manual/AI orders), `Admin.jsx`/`AdminLogs.jsx` (admin
  panel — add/manage users, live bot status), `Login.jsx`, `AiChat.jsx`,
  `api.js` (backend base URL, patched by `start.sh` on every run).
- **Backend** (`server.py`): FastAPI. Auth, `users.db` (SQLite: username,
  password hash, per-user ports, is_admin), proxies to each user's bot
  processes, starts/stops/tracks them (`_start_bot_process`/`_pid_alive` in
  `server.py`).
- **Per-user bot processes** (outside this repo, in
  `~/PycharmProjects/pythonProject/SmartApi/`):
  - `webviewdataapi.py` — india dashboard (Flask)
  - `ai_order_service.py` — india AI/manual orders (Flask)
  - `storesupportzone.py` / `store_exit.py` — india auto-strategy / auto-exit (opt-in, no port, two independent processes)
  - `crypto/webviewdataapi.py` — crypto dashboard (Flask)
  - `crypto/stetergy.py` / `crypto/stetergy_exit.py` — crypto auto-strategy / auto-exit
    (opt-in, no port, two independent processes — **split 2026-08-31**, see below)
  - **The folder you run a script from decides which account it is** — no
    flags. chetan (admin) uses the `SmartApi/` and `SmartApi/crypto/` roots;
    every other user gets `SmartApi/accounts/<user>/` and
    `SmartApi/crypto/accounts/<user>/`.
- **Liveness tracking**: port-listening bots (dashboards, AI-order) are
  checked by port; no-port bots (`storesupportzone.py`, `store_exit.py`,
  `stetergy.py`) are tracked purely via a `<script>.pid` file the admin
  start flow writes into that user's account dir (`server.py:200`). A
  process started manually from the terminal (not via the admin panel) is
  invisible to the Admin panel / smoke test unless you write that PID file
  yourself — same blind spot the docs call out for chetan's root account.

## Users & ports (from `users.db`)

| user     | admin | india dash | india AI | crypto dash | crypto strategy |
|----------|-------|-----------:|---------:|-------------:|:----------------:|
| chetan   | yes   | 4100       | 4104     | 4101          | yes |
| testuser | no    | 4110       | 4114     | 4111          | yes |
| paras    | no    | 4120       | 4124     | —             | no |
| kamal    | no    | 4130       | 4134     | —             | no |
| pulkit   | no    | 4140       | 4144     | 4141          | yes |
| vijay    | no    | 4150       | 4154     | —             | no |

All 6 users have india auto-strategy (`storesupportzone.py`/`store_exit.py`).
Only chetan/testuser/pulkit have crypto accounts.

## Known issues / gotchas

- **AngelOne rate limit**: logins fired too close together get "Access
  denied because of exceeding access rate". Stagger india bot startups
  (~8s worked fine manually); the admin flow already does this.
- **chetan blind spot**: root account's strategy processes have no
  account-dir PID file (predates multiuser), so Admin panel/smoke test
  can't see them — check with `pgrep -fl "storesupportzone.py\|stetergy.py"`.
- **Two processes on the same account dir at once is a real bug** we've hit
  — always check nothing's already running before starting manually
  (`lsof -i :<port>`, `pgrep -fl <script>`).
- **`crypto/stetergy.py` `exitstetergy()` crash (fixed 2026-08-31)**: DeltaEx's
  ticker endpoint sometimes returns `{'success': True, 'result': None}`.
  Old code did `'mark_price' not in ticker_info['result']` unconditionally,
  which throws `TypeError: argument of type 'NoneType' is not iterable` when
  `result` is `None` — killed the strategy loop outright for every crypto
  user, every time it hit a null ticker. Fixed at `crypto/stetergy.py:763`
  and `:895` with `.get('result')` guards. Watch `logs/` if crypto
  auto-strategy dies again — same function is the first place to look.

## Smoke test

`test_full_project.py` — backend health, every real user's bot ports (read
live from `users.db`), account config completeness, and (with
`TEST_ADMIN_PASSWORD`/`TEST_USER_PASSWORD` set) login/admin-gating/impersonation.
Run after any change that touches startup, ports, or account config:

```
.venv/bin/python test_full_project.py
```

## Admin: restart/stop a user's auto-strategy bot (added 2026-08-31)

Manage → per-user panel now has Restart/Stop buttons for `storesupportzone`
(auto-strategy), `store_exit` (auto-exit), and `crypto_strategy` (crypto,
when provisioned) — independent of the credentials save flow, so you don't
need to touch API keys just to bounce a stuck bot. Backend:
`POST /api/admin/users/{username}/bots/{storesupportzone|store_exit|crypto_strategy}/{stop|restart}`
in `server.py`, reusing the same `_kill_pid`/`_start_bot_process`/`_pid_alive`
helpers the credentials-save restart already used.

## Crypto auto-strategy/auto-exit split into two processes (2026-08-31)

`crypto/stetergy.py` used to run both entry (`stetergy()`) and exit
(`exitstetergy()`) in one process's `schedule` loop — unlike india, where
entry and exit were always two separate files. Split it the same way:

- `crypto/stetergy.py` — entry only now. Its old bottom-of-file scheduler
  loop is guarded by `if __name__ == "__main__"`.
- `crypto/stetergy_exit.py` — new file, exit only. Does
  `from stetergy import exitstetergy, tradewithmoney` to reuse every helper
  `exitstetergy()` needs (load_data/save_data, the DeltaEx client, sendAlert,
  etc.) without duplicating ~1800 lines — the `__main__` guard means this
  import only pulls in definitions, not stetergy.py's own loop.
- Admin: `STRATEGY_BOTS`/`LOG_BOTS` in `server.py` both gained a
  `"crypto_exit"` entry (`stetergy_exit.py`), so it's restartable/stoppable
  via `/api/admin/users/{username}/bots/crypto_exit/{stop|restart}` exactly
  like `crypto_strategy`, `storesupportzone`, and `store_exit`. The
  credentials-save flow and new-user creation both now start
  `stetergy_exit.py` alongside `stetergy.py`. Admin.jsx's Manage panel has
  its own Restart/Stop button pair for crypto exit next to crypto strategy.
- Rolled out live for chetan/testuser/pulkit (the 3 crypto accounts):
  killed the old combined process, started fresh `stetergy.py` +
  `stetergy_exit.py` per account. Also found and killed an orphaned
  duplicate `stetergy.py` for chetan (PID from an early manual restart that
  predated any PID file for chetan's account, so a later restart's
  `_kill_pid` had nothing to act on and left it running) — worth checking
  for whenever chetan's crypto process is bounced manually, since chetan's
  root account has no PID-file tracking to catch this automatically (see
  blind spot above).

## Status as of 2026-08-31

Full stack verified up for all 6 users (38 passed, 0 failed, 4 skipped —
the 4 skips are the documented chetan blind spot plus the two
credential-gated deep checks). Manual-start logs from that session are in
`logs/manual_start/`.
