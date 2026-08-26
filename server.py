import asyncio
import json
import os
import re
import socket
import subprocess
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import certifi
import requests
from dotenv import load_dotenv
from fastapi import Body, Depends, FastAPI, Header, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from tvDatafeed import TvDatafeed, Interval

import auth
import crypto_live_feed
import live_feed

load_dotenv()
auth.init_db()

# This Python (framework build) ships no CA trust store of its own, so raw ssl.SSLContext
# (what tvDatafeed's websocket connection uses) fails cert verification even though
# requests works fine (it bundles certifi separately). Point ssl's default lookup at
# certifi's bundle so both paths trust the same CAs.
os.environ.setdefault("SSL_CERT_FILE", certifi.where())

app = FastAPI()
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


@app.post("/api/auth/login")
def login(payload: dict = Body(...)):
    user = auth.authenticate(payload.get("username", ""), payload.get("password", ""))
    if user is None:
        raise HTTPException(401, "invalid username or password")
    token = auth.create_session(user["id"])
    return {"success": True, "token": token, "username": user["username"], "is_admin": bool(user["is_admin"])}


@app.post("/api/auth/logout")
def logout(authorization: str = Header(default=None)):
    if authorization and authorization.startswith("Bearer "):
        auth.delete_session(authorization.removeprefix("Bearer "))
    return {"success": True}


@app.get("/api/auth/me")
def me(user=Depends(auth.get_current_user)):
    return {"success": True, "username": user["username"], "is_admin": bool(user["is_admin"])}


# Lets an admin view/trade on another user's account — every trading/crypto
# route below takes an optional ?as_user=<username>, resolved here instead of
# to the caller's own row. Non-admins passing as_user get a 403; anyone
# passing their own username (or nothing) gets their own account, unchanged.
# This is real access: an admin acting as another user can place and exit
# real orders on that user's real broker account, not just view it.
def get_effective_user(as_user: str = None, user=Depends(auth.get_current_user)):
    if not as_user or as_user == user["username"]:
        return user
    if not user["is_admin"]:
        raise HTTPException(403, "only admins can act as another user")
    target = next((u for u in auth.list_users() if u["username"] == as_user), None)
    if target is None:
        raise HTTPException(404, f"no such user {as_user!r}")
    return target


# Admin screen: create a new user's app login + their SmartApi account
# directory (accounts/<username>/document.py + auto_trade.json), then start
# their two bot processes. Lives in the SmartApi repo, a sibling directory —
# see SmartApi/new_account.sh, which this mirrors as an HTTP-driven version.
SMARTAPI_DIR = Path(os.environ.get("SMARTAPI_DIR", str(Path.home() / "PycharmProjects/pythonProject/SmartApi")))
SMARTAPI_VENV_PYTHON = SMARTAPI_DIR.parent / "venv" / "bin" / "python"
CRYPTO_DIR = SMARTAPI_DIR / "crypto"


def _port_free(port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        return s.connect_ex(("localhost", port)) != 0


def _next_ports():
    existing = auth.list_users()
    base = max([u["webview_port"] for u in existing], default=4090) + 10
    while not (_port_free(base) and _port_free(base + 4)):
        base += 10
    return base, base + 4  # webview_port, ai_port


def _next_crypto_port(preferred):
    port = preferred
    while not _port_free(port):
        port += 10
    return port


def _telegram_document_py_lines(telegram):
    # telegram bot_token is per-account (Telegram only allows one active
    # poller per token, so accounts can't share one) — chatids stays empty
    # until the account's real owner is confirmed: telegrambot.py replies to
    # their first /start with their chat id instead of assuming the bot
    # token's holder is legitimate, and an admin pastes it in here.
    if not telegram or not telegram.get("bot_token"):
        return "chatids = []\n"
    return (
        f"bot_token = {json.dumps(telegram.get('bot_token', ''))}\n"
        f"chatids = {json.dumps(telegram.get('chatids') or [])}\n"
    )


def _document_py_content(angelone, telegram=None):
    if not angelone:
        return (
            "# Demo account — no broker login, no credentials needed.\n"
            "demo_mode = True\n"
        ) + _telegram_document_py_lines(telegram)
    return (
        f"api_key = {json.dumps(angelone.get('api_key', ''))}\n"
        f"user_id = {json.dumps(angelone.get('user_id', ''))}\n"
        f"password = {json.dumps(angelone.get('password', ''))}\n"
        f"totp = {json.dumps(angelone.get('totp', ''))}\n"
    ) + _telegram_document_py_lines(telegram)


def _crypto_document_py_content(deltaex):
    if not deltaex:
        return (
            "# Demo account — no DeltaEx credentials needed.\n"
            "demo_mode = True\n"
        )
    return (
        f"api_key = {json.dumps(deltaex.get('api_key', ''))}\n"
        f"api_secret = {json.dumps(deltaex.get('api_secret', ''))}\n"
    )


# stetergy.py reads several of these keys with bare fetch['key'] (no .get()
# fallback) and crashes the whole always-on process on the first scheduled
# tick if they're missing (confirmed — a fresh account seeded with just
# {"withmoney": False} crashed on fetch['stop_loss'] within 30s of starting).
# auto_place_order defaults off so a new account never auto-trades before
# someone reviews its settings.
CRYPTO_DEFAULT_CONFIG = {
    "withmoney": False, "auto_place_order": False, "stop_loss": "0", "lotsize": "1",
    "target_points": "0", "loss_points": "0", "trade_range_min": None, "trade_range_max": None,
    "buy_or_sell": None,
}

# Same reasoning as CRYPTO_DEFAULT_CONFIG — storesupportzone.py/store_exit.py
# (the always-on india auto-strategy watchers) read several of these with
# bare fetch['key'], and crash on the first scheduled tick if missing
# (verified directly). Every new india account gets this full shape, not
# just ones with the strategy enabled, since the manual/AI dashboard config
# form would eventually write the same keys anyway.
INDIA_DEFAULT_CONFIG = {
    "withmoney": False, "auto_place_order": False, "lotsize": 1, "stop_loss": "0",
    "target_points": "0", "loss_points": "0", "check_all_level": False, "set_otm": "0",
    "send_alert": False,
    # None here means ce_format()/pe_format()/placeoptionsellorder() never
    # match either branch — a confirmed buy/sell signal is silently dropped
    # regardless of check_all_level or auto_place_order. Confirmed as the
    # actual blocker for testuser/paras/kamal/pulkit early on, fixed by hand
    # for those 4 at the time but never fixed here — so every account
    # created since (vijay) inherited the same silent block.
    "buy_or_sell": "BUY", "buy_or_sell_side": "BOTH",
    # storesupportzone.py reads load_data()['storeorder'] with a bare access
    # (storesupportzone.py:2718) — normally created lazily the first time an
    # order is tracked, but a brand-new account has never done that, so it's
    # missing until seeded here. Confirmed as the actual crash trigger for
    # every account except chetan's (old enough to have accumulated one).
    "storeorder": [],
}


def _start_bot_process(script_name, script_dir, account_dir, port=None):
    log_dir = SMARTAPI_DIR / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    log_file = open(log_dir / f"{account_dir.name}_{script_name.removesuffix('.py')}.log", "w")
    env = {**os.environ}
    if port is not None:
        env["PORT"] = str(port)
    proc = subprocess.Popen(
        [str(SMARTAPI_VENV_PYTHON), str(script_dir / script_name)],
        cwd=str(account_dir), env=env,
        stdout=log_file, stderr=subprocess.STDOUT,
    )
    log_file.close()  # Popen already duped the fd for the child; safe to close our handle
    if port is None:
        # No listening port to probe for liveness later (stetergy.py is a
        # headless loop, not a Flask server) — remember the PID instead.
        (account_dir / f"{script_name.removesuffix('.py')}.pid").write_text(str(proc.pid))
    return proc


def _pid_alive(account_dir, script_name):
    pid_file = account_dir / f"{script_name.removesuffix('.py')}.pid"
    if not pid_file.exists():
        return False
    try:
        pid = int(pid_file.read_text().strip())
    except ValueError:
        return False
    # os.kill(pid, 0) succeeds for a zombie too (confirmed — a crashed
    # stetergy.py stayed "alive" by that check until reaped), so check the
    # actual process state instead.
    state = subprocess.run(["ps", "-o", "state=", "-p", str(pid)], capture_output=True, text=True).stdout.strip()
    return bool(state) and not state.startswith("Z")


def _kill_port(port):
    result = subprocess.run(["lsof", "-tiTCP:" + str(port), "-sTCP:LISTEN"], capture_output=True, text=True)
    for pid in result.stdout.split():
        try:
            os.kill(int(pid), 15)  # SIGTERM
        except ProcessLookupError:
            pass
    if result.stdout.strip():
        time.sleep(1)


def _kill_pid(account_dir, script_name):
    pid_file = account_dir / f"{script_name.removesuffix('.py')}.pid"
    if not pid_file.exists():
        return
    try:
        os.kill(int(pid_file.read_text().strip()), 15)  # SIGTERM
        time.sleep(1)
    except (ProcessLookupError, ValueError):
        pass


# document.py is a plain data module written by _document_py_content() below —
# exec'ing it back is the simplest way to read whatever it currently holds,
# no bespoke parser needed.
def _read_document_py(account_dir):
    path = account_dir / "document.py"
    if not path.exists():
        return None
    ns = {}
    exec(path.read_text(), ns)
    return {
        "demo_mode": bool(ns.get("demo_mode", False)),
        "api_key": ns.get("api_key", ""),
        "user_id": ns.get("user_id", ""),
        "password": ns.get("password", ""),
        "totp": ns.get("totp", ""),
        "bot_token": ns.get("bot_token", ""),
        "chatids": ns.get("chatids", []),
    }


def _read_crypto_document_py(account_dir):
    path = account_dir / "document.py"
    if not path.exists():
        return None
    ns = {}
    exec(path.read_text(), ns)
    return {
        "demo_mode": bool(ns.get("demo_mode", False)),
        "api_key": ns.get("api_key", ""),
        "api_secret": ns.get("api_secret", ""),
    }


# bot key -> (base dir, script filename stem). Covers every long-running
# process a user can have, india and crypto, for the log-viewer endpoint
# below and for the "any recent errors?" flags in the users list.
LOG_BOTS = {
    "webview": (SMARTAPI_DIR, "webviewdataapi"),
    "ai": (SMARTAPI_DIR, "ai_order_service"),
    "storesupportzone": (SMARTAPI_DIR, "storesupportzone"),
    "store_exit": (SMARTAPI_DIR, "store_exit"),
    "telegram": (SMARTAPI_DIR, "telegrambot"),
    "crypto_webview": (CRYPTO_DIR, "webviewdataapi"),
    "crypto_strategy": (CRYPTO_DIR, "stetergy"),
}
# "error" with a negative lookahead for "code" so AngelOne's routine
# {'errorcode': ''} success-response field doesn't get flagged as an error.
ERROR_RE = re.compile(r"traceback|error(?!code)|exception|critical", re.IGNORECASE)


def _managed_account_dir(base_dir, username):
    # accounts/{username} is created by admin_create_user() for every
    # admin-managed account. If it doesn't exist, this isn't a managed
    # account at all — it's a legacy root account (chetan) running from
    # base_dir itself. (Checking existence, not just falling back blindly,
    # keeps a managed user who hasn't started their bot yet from being
    # misattributed to chetan's shared root files.)
    account_dir = base_dir / "accounts" / username
    return account_dir if account_dir.exists() else base_dir


def _log_candidates(username, bot):
    base_dir, script = LOG_BOTS[bot]
    log_dir = base_dir / "logs"
    # {username}_{script}.log is written by _start_bot_process() for every
    # admin-managed account. {script}.log (no prefix) is the legacy path for
    # accounts started by hand from the account's own directory (chetan).
    candidates = [log_dir / f"{username}_{script}.log", log_dir / f"{script}.log"]
    if bot == "storesupportzone":
        # storesupportzone.py also writes its own logging.basicConfig output
        # to optionsorderlog2.log in its cwd — often more useful than the
        # stdout capture since it logs actual trade decisions, not just crashes.
        candidates.append(_managed_account_dir(base_dir, username) / "optionsorderlog2.log")
    return candidates


def _tail_lines(path, n=200):
    if not path.exists():
        return None
    with open(path, "r", errors="replace") as f:
        lines = f.readlines()
    return [line.rstrip("\n") for line in lines[-n:]]


def _log_has_error(lines):
    return any(ERROR_RE.search(line) for line in lines[-50:])


def _find_log(username, bot, n=200):
    for path in _log_candidates(username, bot):
        lines = _tail_lines(path, n)
        if lines is not None:
            return path, lines
    return None, []


@app.get("/api/admin/users")
def admin_list_users(admin=Depends(auth.require_admin)):
    users = []
    for u in auth.list_users():
        account_dir = _managed_account_dir(SMARTAPI_DIR, u["username"])
        entry = {
            "username": u["username"], "webview_port": u["webview_port"], "ai_port": u["ai_port"],
            "crypto_port": u["crypto_port"], "is_admin": bool(u["is_admin"]),
            "webview_alive": not _port_free(u["webview_port"]),
            "ai_alive": not _port_free(u["ai_port"]),
            "storesupportzone_alive": _pid_alive(account_dir, "storesupportzone.py"),
            "store_exit_alive": _pid_alive(account_dir, "store_exit.py"),
            "telegram_alive": _pid_alive(account_dir, "telegrambot.py"),
        }
        entry["errors"] = {
            bot: _log_has_error(_find_log(u["username"], bot, n=50)[1])
            for bot in ("webview", "ai", "storesupportzone", "store_exit", "telegram")
        }
        if u["crypto_port"] is not None:
            entry["crypto_dashboard_alive"] = not _port_free(u["crypto_port"])
            entry["crypto_strategy_alive"] = _pid_alive(_managed_account_dir(CRYPTO_DIR, u["username"]), "stetergy.py")
            for bot in ("crypto_webview", "crypto_strategy"):
                entry["errors"][bot] = _log_has_error(_find_log(u["username"], bot, n=50)[1])
        users.append(entry)
    return {"success": True, "users": users}


@app.get("/api/admin/users/{username}/logs/{bot}")
def admin_get_log(username: str, bot: str, admin=Depends(auth.require_admin)):
    if bot not in LOG_BOTS:
        raise HTTPException(404, "unknown bot")
    path, lines = _find_log(username, bot)
    return {"success": True, "bot": bot, "path": str(path) if path else None, "lines": lines, "has_error": _log_has_error(lines)}


@app.post("/api/admin/users")
def admin_create_user(payload: dict = Body(...), admin=Depends(auth.require_admin)):
    username = payload.get("username")
    password = payload.get("password")
    if not username or not password:
        raise HTTPException(400, "username and password required")

    account_dir = SMARTAPI_DIR / "accounts" / username
    if account_dir.exists():
        raise HTTPException(409, f"account directory already exists for {username!r}")

    angelone = payload.get("angelone")  # {api_key, user_id, password, totp} or falsy for demo mode
    telegram = payload.get("telegram")  # {bot_token, chatids} or falsy to skip
    webview_port, ai_port = _next_ports()
    account_dir.mkdir(parents=True)
    (account_dir / "document.py").write_text(_document_py_content(angelone, telegram))
    (account_dir / "auto_trade.json").write_text(json.dumps(INDIA_DEFAULT_CONFIG, indent=4))

    include_crypto = bool(payload.get("include_crypto"))
    crypto_port = None
    crypto_account_dir = None
    if include_crypto:
        deltaex = payload.get("deltaex")  # {api_key, api_secret} or falsy for demo mode
        crypto_port = _next_crypto_port(webview_port + 1)
        crypto_account_dir = CRYPTO_DIR / "accounts" / username
        crypto_account_dir.mkdir(parents=True)
        (crypto_account_dir / "document.py").write_text(_crypto_document_py_content(deltaex))
        (crypto_account_dir / "auto_trade_crypto.json").write_text(json.dumps(CRYPTO_DEFAULT_CONFIG, indent=4))

    auth.create_user(username, password, webview_port, ai_port, crypto_port=crypto_port)

    # Real broker logins get rate-limited by AngelOne if fired too close together
    # (confirmed — "Access denied because of exceeding access rate") — stagger
    # them. Demo accounts skip the broker login entirely, so no need to wait.
    # DeltaEx (crypto) has no such login step, so no staggering needed there.
    webview_proc = _start_bot_process("webviewdataapi.py", SMARTAPI_DIR, account_dir, webview_port)
    time.sleep(1.5 if not angelone else 8)
    webview_alive = webview_proc.poll() is None

    ai_proc = _start_bot_process("ai_order_service.py", SMARTAPI_DIR, account_dir, ai_port)
    time.sleep(1.5 if not angelone else 3)
    ai_alive = ai_proc.poll() is None

    result = {
        "success": True, "username": username, "webview_port": webview_port, "ai_port": ai_port,
        "webview_alive": webview_alive, "ai_alive": ai_alive,
    }

    if payload.get("include_india_strategy"):
        storesupportzone_proc = _start_bot_process("storesupportzone.py", SMARTAPI_DIR, account_dir)
        time.sleep(1.5 if not angelone else 8)
        store_exit_proc = _start_bot_process("store_exit.py", SMARTAPI_DIR, account_dir)
        time.sleep(1.5 if not angelone else 8)
        result.update({
            "storesupportzone_alive": storesupportzone_proc.poll() is None,
            "store_exit_alive": store_exit_proc.poll() is None,
        })

    if telegram and telegram.get("bot_token"):
        telegram_proc = _start_bot_process("telegrambot.py", SMARTAPI_DIR / "treadingbot", account_dir)
        time.sleep(3)
        result["telegram_alive"] = telegram_proc.poll() is None

    if include_crypto:
        crypto_dashboard_proc = _start_bot_process("webviewdataapi.py", CRYPTO_DIR, crypto_account_dir, crypto_port)
        time.sleep(1.5)
        crypto_strategy_proc = _start_bot_process("stetergy.py", CRYPTO_DIR, crypto_account_dir)
        time.sleep(1.5)
        result.update({
            "crypto_port": crypto_port,
            "crypto_dashboard_alive": crypto_dashboard_proc.poll() is None,
            "crypto_strategy_alive": crypto_strategy_proc.poll() is None,
        })

    return result


# AngelOne credentials are stored in plaintext in document.py by necessity —
# the broker login needs the real password — so unlike the app login (hashed,
# unrecoverable), an admin who already has filesystem access to that file can
# just as well view/edit it here. Used both to fill in a demo account's real
# credentials later and to rotate an existing account's password/TOTP secret.
@app.get("/api/admin/users/{username}/credentials")
def admin_get_credentials(username: str, admin=Depends(auth.require_admin)):
    creds = _read_document_py(_managed_account_dir(SMARTAPI_DIR, username))
    if creds is None:
        raise HTTPException(404, f"no account directory for {username!r}")
    return {"success": True, **creds}


@app.put("/api/admin/users/{username}/credentials")
def admin_update_credentials(username: str, payload: dict = Body(...), admin=Depends(auth.require_admin)):
    account_dir = _managed_account_dir(SMARTAPI_DIR, username)
    if not account_dir.exists():
        raise HTTPException(404, f"no account directory for {username!r}")
    user_row = next((u for u in auth.list_users() if u["username"] == username), None)
    if user_row is None:
        raise HTTPException(404, f"no such user {username!r}")

    angelone = payload.get("angelone")
    telegram = payload.get("telegram")
    (account_dir / "document.py").write_text(_document_py_content(angelone, telegram))

    # document.py is only read at process startup, so the bots need restarting
    # for new/changed credentials (or a demo <-> live switch) to take effect.
    _kill_port(user_row["webview_port"])
    _kill_port(user_row["ai_port"])
    webview_proc = _start_bot_process("webviewdataapi.py", SMARTAPI_DIR, account_dir, user_row["webview_port"])
    time.sleep(1.5 if not angelone else 8)
    webview_alive = webview_proc.poll() is None

    ai_proc = _start_bot_process("ai_order_service.py", SMARTAPI_DIR, account_dir, user_row["ai_port"])
    time.sleep(1.5 if not angelone else 3)
    ai_alive = ai_proc.poll() is None

    result = {"success": True, "webview_alive": webview_alive, "ai_alive": ai_alive}

    # Explicit opt-in only — a credentials-only update (e.g. just rotating a
    # password) shouldn't silently start a real-money auto-strategy loop.
    if payload.get("enable_strategy"):
        _kill_pid(account_dir, "storesupportzone.py")
        _kill_pid(account_dir, "store_exit.py")
        storesupportzone_proc = _start_bot_process("storesupportzone.py", SMARTAPI_DIR, account_dir)
        time.sleep(1.5 if not angelone else 8)
        store_exit_proc = _start_bot_process("store_exit.py", SMARTAPI_DIR, account_dir)
        time.sleep(1.5 if not angelone else 8)
        result.update({
            "storesupportzone_alive": storesupportzone_proc.poll() is None,
            "store_exit_alive": store_exit_proc.poll() is None,
        })

    # Same explicit opt-in as enable_strategy above — restarting picks up a
    # newly-added/changed bot_token or chatids (document.py is only read at
    # process startup), but shouldn't happen just because credentials were
    # saved for an unrelated reason.
    if payload.get("enable_telegram") and telegram and telegram.get("bot_token"):
        _kill_pid(account_dir, "telegrambot.py")
        telegram_proc = _start_bot_process("telegrambot.py", SMARTAPI_DIR / "treadingbot", account_dir)
        time.sleep(3)
        result["telegram_alive"] = telegram_proc.poll() is None

    return result


# DeltaEx (crypto) credentials work the same way as AngelOne's above — plaintext
# by necessity, viewable/editable by an admin who already has filesystem access.
# Unlike the india side, a user might not have a crypto account at all yet
# (crypto_port is NULL) — GET reports that instead of 404ing, so the frontend
# can render an empty "not set up" form rather than an error.
@app.get("/api/admin/users/{username}/crypto-credentials")
def admin_get_crypto_credentials(username: str, admin=Depends(auth.require_admin)):
    creds = _read_crypto_document_py(CRYPTO_DIR / "accounts" / username)
    if creds is None:
        return {"success": True, "provisioned": False, "demo_mode": True, "api_key": "", "api_secret": ""}
    return {"success": True, "provisioned": True, **creds}


@app.put("/api/admin/users/{username}/crypto-credentials")
def admin_update_crypto_credentials(username: str, payload: dict = Body(...), admin=Depends(auth.require_admin)):
    user_row = next((u for u in auth.list_users() if u["username"] == username), None)
    if user_row is None:
        raise HTTPException(404, f"no such user {username!r}")

    crypto_account_dir = CRYPTO_DIR / "accounts" / username
    deltaex = payload.get("deltaex")
    is_new = user_row["crypto_port"] is None

    if is_new:
        crypto_port = _next_crypto_port(user_row["webview_port"] + 1)
        crypto_account_dir.mkdir(parents=True, exist_ok=True)
        (crypto_account_dir / "auto_trade_crypto.json").write_text(json.dumps(CRYPTO_DEFAULT_CONFIG, indent=4))
        auth.set_crypto_port(username, crypto_port)
    else:
        crypto_port = user_row["crypto_port"]
        _kill_port(crypto_port)
        _kill_pid(crypto_account_dir, "stetergy.py")

    (crypto_account_dir / "document.py").write_text(_crypto_document_py_content(deltaex))

    dashboard_proc = _start_bot_process("webviewdataapi.py", CRYPTO_DIR, crypto_account_dir, crypto_port)
    time.sleep(1.5)
    strategy_proc = _start_bot_process("stetergy.py", CRYPTO_DIR, crypto_account_dir)
    time.sleep(1.5)

    return {
        "success": True, "crypto_port": crypto_port,
        "crypto_dashboard_alive": dashboard_proc.poll() is None,
        "crypto_strategy_alive": strategy_proc.poll() is None,
    }


@app.post("/api/admin/users/{username}/reset-password")
def admin_reset_password(username: str, payload: dict = Body(...), admin=Depends(auth.require_admin)):
    new_password = payload.get("password")
    if not new_password:
        raise HTTPException(400, "password required")
    auth.set_password(username, new_password)
    auth.delete_sessions_for_user(username)  # force re-login with the new password
    return {"success": True}


# get_hist() opens a websocket on whatever instance calls it. A single shared
# instance across concurrent requests races on the same connection and
# corrupts data (confirmed); a fresh instance per request with no cap fixes
# that but opens too many simultaneous anonymous websockets and TradingView
# starts dropping them ("Connection to remote host was lost", confirmed).
# Bounded concurrency avoids both: cap simultaneous connections, still allow
# multiple chart panes to load in parallel instead of one queue.
# ponytail: fixed ceiling of 4, tune (or make a queue) if panes/users grow.
tv_slots = threading.Semaphore(4)

# With multiple users' storesupportzone.py/stetergy.py strategy loops now all
# polling /api/quote independently, several accounts asking for the same
# symbol (NIFTY, a shared option strike, ...) within the same few seconds is
# common — confirmed directly: this saturated tv_slots and caused TradingView
# connection timeouts even for plain NSE:NIFTY. A short cache collapses that
# redundant demand into one real fetch per symbol per window, without
# touching tv_slots' own limit (raising that risks the exact connection-drop
# failure it exists to prevent).
_quote_cache = {}  # symbol -> (fetched_at, response_dict)
QUOTE_CACHE_TTL = 3


def _cached_quote(symbol):
    cached = _quote_cache.get(symbol)
    if cached and time.time() - cached[0] < QUOTE_CACHE_TTL:
        return cached[1]
    df = fetch(symbol, "1", 1)
    ts, r = df.index[-1], df.iloc[-1]
    result = {"success": True, "time": epoch(ts), "open": r.open, "high": r.high, "low": r.low, "close": r.close}
    _quote_cache[symbol] = (time.time(), result)
    return result

RESOLUTIONS = {
    "1": Interval.in_1_minute,
    "5": Interval.in_5_minute,
    "15": Interval.in_15_minute,
    "60": Interval.in_1_hour,
    "240": Interval.in_4_hour,
    "D": Interval.in_daily,
}


SEARCH_URL = "https://symbol-search.tradingview.com/symbol_search/?text={}&hl=1&exchange={}&lang=en&type={}&domain=production"
# tvDatafeed's own search_symbol() omits these and TradingView 403s without them.
SEARCH_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
    "Referer": "https://www.tradingview.com/",
    "Origin": "https://www.tradingview.com",
}


def parse_symbol(symbol: str):
    exchange, sep, sym = symbol.partition(":")
    return (exchange, sym) if sep else ("NSE", symbol)


def epoch(ts):
    # tvDatafeed builds naive local-time datetimes, but pandas.Timestamp.timestamp()
    # treats naive timestamps as UTC (unlike stdlib datetime) — silently shifting every
    # bar by the local UTC offset. to_pydatetime() interprets it as local time correctly.
    return int(ts.to_pydatetime().timestamp())


def fetch(symbol: str, resolution: str, n_bars: int):
    interval = RESOLUTIONS.get(resolution)
    if interval is None:
        raise HTTPException(400, f"unsupported resolution '{resolution}'")
    exchange, sym = parse_symbol(symbol)
    with tv_slots:
        df = TvDatafeed().get_hist(symbol=sym, exchange=exchange, interval=interval, n_bars=n_bars)
    if df is None or df.empty:
        raise HTTPException(502, "no data returned")
    return df


@app.get("/api/ohlcv")
def ohlcv(symbol: str = "NSE:NIFTY", resolution: str = "1", count: int = 500):
    df = fetch(symbol, resolution, count)
    bars = [
        {"time": epoch(ts), "open": r.open, "high": r.high, "low": r.low, "close": r.close}
        for ts, r in df.iterrows()
    ]
    return {"success": True, "bars": bars}


@app.get("/api/quote")
def quote(symbol: str = "NSE:NIFTY"):
    return _cached_quote(symbol)


# Historical candles for demo accounts' get_pre_historical_data()/
# get_historical_data() (storesupportzone.py/store_exit.py) — they have no
# broker session of their own, and anonymous TradingView doesn't resolve
# NFO/BFO option contracts. Backed by the same shared Angel One session
# live_feed.py already authenticates for live ticks (see its
# get_historical_candles()). Cached briefly since several demo accounts can
# ask for the same/overlapping window within seconds of each other, and
# AngelOne's own historical API is rate-limited per second.
_candle_cache = {}  # (exch_seg, token, interval) -> (fetched_at, candles)
CANDLE_CACHE_TTL = 20


@app.get("/api/historical-candle")
def historical_candle(exch_seg: str, token: str, interval: str, from_date: str, to_date: str):
    key = (exch_seg, token, interval)
    cached = _candle_cache.get(key)
    if cached and time.time() - cached[0] < CANDLE_CACHE_TTL:
        return {"success": True, "data": cached[1]}
    try:
        candles = live_feed.get_historical_candles(exch_seg, token, interval, from_date, to_date)
    except Exception as e:
        raise HTTPException(502, f"historical candle fetch failed: {e}")
    _candle_cache[key] = (time.time(), candles)
    return {"success": True, "data": candles}


# Live ticks via SmartAPI's websocket, for the chart's "Live" toggle. If the
# symbol isn't resolvable on SmartAPI (resolve() returns None — e.g. crypto,
# unlisted contracts) try Delta Exchange's public ticker feed instead; if
# that isn't resolvable either the socket closes and the frontend falls back
# to polling /api/quote as before. Both feeds are shared/anonymous market
# data, unrelated to any user's own account.
@app.websocket("/ws/live")
async def ws_live(websocket: WebSocket, symbol: str = "NSE:NIFTY"):
    await websocket.accept()
    resolved = await asyncio.to_thread(live_feed.resolve, symbol)
    if resolved is not None:
        exchange_type, token = resolved
        queue = await live_feed.subscribe(exchange_type, token)
        try:
            while True:
                tick = await queue.get()
                await websocket.send_json({
                    "price": tick["last_traded_price"] / 100,
                    "time": tick["exchange_timestamp"] // 1000,
                })
        except WebSocketDisconnect:
            pass
        finally:
            live_feed.unsubscribe(token, queue)
        return

    delta_symbol = crypto_live_feed.resolve(symbol)
    if delta_symbol is None:
        await websocket.close(code=4004)
        return
    queue = await crypto_live_feed.subscribe(delta_symbol)
    try:
        while True:
            tick = await queue.get()
            await websocket.send_json(tick)
    except WebSocketDisconnect:
        pass
    finally:
        crypto_live_feed.unsubscribe(delta_symbol, queue)


# For callers that already have Angel One's own (exch_seg, token) — the bot
# scripts always do, from their own scrip-master lookups — rather than a
# TradingView symbol string. Skips live_feed.resolve() entirely, so there's
# no TradingView symbol-format/exchange-prefix guessing (that mismatch is
# what made the /api/quote-based fallback unreliable for option contracts).
@app.websocket("/ws/live-token")
async def ws_live_token(websocket: WebSocket, exch_seg: str, token: str):
    await websocket.accept()
    exchange_type = live_feed.EXCHANGE_TYPE_FO.get(exch_seg) or live_feed.EXCHANGE_TYPE.get(exch_seg)
    if exchange_type is None:
        await websocket.close(code=4004)
        return
    queue = await live_feed.subscribe(exchange_type, token)
    try:
        while True:
            tick = await queue.get()
            await websocket.send_json({
                "price": tick["last_traded_price"] / 100,
                "time": tick["exchange_timestamp"] // 1000,
            })
    except WebSocketDisconnect:
        pass
    finally:
        live_feed.unsubscribe(token, queue)


@app.get("/api/search")
def search(query: str, exchange: str = "", type: str = ""):
    if not query:
        return {"success": True, "results": []}
    url = SEARCH_URL.format(query, exchange, type)
    resp = requests.get(url, headers=SEARCH_HEADERS, timeout=10)
    if resp.status_code != 200:
        raise HTTPException(502, "symbol search failed")
    results = [
        {
            "symbol": item["symbol"].replace("<em>", "").replace("</em>", ""),
            "description": item.get("description", "").replace("<em>", "").replace("</em>", ""),
            "exchange": item.get("exchange", ""),
            "type": item.get("type", ""),
        }
        for item in resp.json()
    ]
    return {"success": True, "results": results}


# TradingView's search only returns individual strikes, not a chain listing —
# there's no "give me the whole chain" endpoint. So: find the nearest expiry
# by searching one ATM strike, then generate the rest of the ladder ourselves
# and fetch each leg's price directly, same as /api/quote does per-symbol.
# ponytail: hardcoded step per index; unlisted underlyings default to 50.
STRIKE_STEP = {"NIFTY": 50, "BANKNIFTY": 100, "FINNIFTY": 50, "SENSEX": 100, "MIDCPNIFTY": 25}


@app.get("/api/option-chain")
def option_chain(underlying: str = "NIFTY", exchange: str = "NSE", strikes: int = 5):
    spot_df = fetch(f"{exchange}:{underlying}", "1", 1)
    spot = float(spot_df.iloc[-1].close)

    step = STRIKE_STEP.get(underlying, 50)
    atm = round(spot / step) * step

    probe_url = SEARCH_URL.format(f"{underlying} {atm} CE", exchange, "options")
    resp = requests.get(probe_url, headers=SEARCH_HEADERS, timeout=10)
    items = resp.json() if resp.status_code == 200 else []
    if not items:
        raise HTTPException(404, f"no listed options found for {underlying} on {exchange}")
    probe_symbol = items[0]["symbol"].replace("<em>", "").replace("</em>", "")
    match = re.search(r"[CP]\d+$", probe_symbol)
    prefix = probe_symbol[: match.start()]

    strike_list = [atm + i * step for i in range(-strikes, strikes + 1)]

    def leg(strike, side):
        symbol = f"{prefix}{side}{strike}"
        try:
            df = fetch(f"{exchange}:{symbol}", "1", 1)
            r = df.iloc[-1]
            return {"symbol": symbol, "ltp": r.close, "volume": r.volume}
        except HTTPException:
            return {"symbol": symbol, "ltp": None, "volume": None}

    with ThreadPoolExecutor(max_workers=8) as pool:
        futures = {
            (strike, side): pool.submit(leg, strike, side)
            for strike in strike_list
            for side in ("C", "P")
        }
        legs = {k: f.result() for k, f in futures.items()}

    chain = [
        {"strike": strike, "ce": legs[(strike, "C")], "pe": legs[(strike, "P")]}
        for strike in strike_list
    ]
    return {"success": True, "underlying": underlying, "spot": spot, "atm": atm, "chain": chain}


# Proxy for the live trading bot's dashboard API (localhost:4100, a separate
# Flask app in ~/PycharmProjects/pythonProject/SmartApi). It has no CORS
# headers, so the browser can't call it directly from this app's origin —
# route through here instead of touching that project's file. Each logged-in
# user has their own webviewdataapi.py process (own broker session, own
# auto_trade.json/database.db) on their own port — see auth.py's users table
# and SmartApi/new_account.sh — so the base URL is derived per-request from
# whoever's actually logged in, not a single fixed host.
def trading_api(user):
    return f"http://localhost:{user['webview_port']}"


@app.get("/api/trading/dashboard")
def trading_dashboard(date: str = None, selectclient: str = None, user=Depends(get_effective_user)):
    params = {k: v for k, v in {"date": date, "selectclient": selectclient}.items() if v}
    resp = requests.get(f"{trading_api(user)}/api/dashboard", params=params, timeout=20)
    return resp.json()


@app.post("/api/trading/config")
def trading_config(payload: dict = Body(...), user=Depends(get_effective_user)):
    resp = requests.post(f"{trading_api(user)}/api/dashboard/config", json=payload, timeout=20)
    return resp.json()


@app.post("/api/trading/order")
def trading_order(payload: dict = Body(...), user=Depends(get_effective_user)):
    resp = requests.post(f"{trading_api(user)}/api/update_order", json=payload, timeout=20)
    return resp.json()


@app.post("/api/trading/delete-order")
def trading_delete_order(payload: dict = Body(...), user=Depends(get_effective_user)):
    resp = requests.post(f"{trading_api(user)}/api/delete_order", json=payload, timeout=20)
    return resp.json()


@app.post("/api/trading/exit-order")
def trading_exit_order(payload: dict = Body(...), user=Depends(get_effective_user)):
    resp = requests.post(f"{trading_api(user)}/api/exit_order", json=payload, timeout=20)
    return resp.json()


@app.get("/api/trading/pending-orders")
def trading_pending_orders(selectclient: str = None, user=Depends(get_effective_user)):
    params = {"selectclient": selectclient} if selectclient else {}
    resp = requests.get(f"{trading_api(user)}/api/pending_orders", params=params, timeout=20)
    return resp.json()


# Proxy for ai_order_service.py (a brand-new, standalone script in the SmartApi
# project — see that file's docstring). Runs as its own process with its own
# broker session per user, same per-user-port pattern as trading_api() above.
def ai_order_api(user):
    return f"http://localhost:{user['ai_port']}"


@app.post("/api/trading/ai-enter-order")
def trading_ai_enter_order(payload: dict = Body(...), user=Depends(get_effective_user)):
    resp = requests.post(f"{ai_order_api(user)}/api/ai/enter-order", json=payload, timeout=30)
    return resp.json()


@app.post("/api/trading/ai-exit-order")
def trading_ai_exit_order(payload: dict = Body(...), user=Depends(get_effective_user)):
    resp = requests.post(f"{ai_order_api(user)}/api/ai/exit-order", json=payload, timeout=30)
    return resp.json()


@app.post("/api/trading/ai-enter-option-order")
def trading_ai_enter_option_order(payload: dict = Body(...), user=Depends(get_effective_user)):
    resp = requests.post(f"{ai_order_api(user)}/api/ai/enter-option-order", json=payload, timeout=30)
    return resp.json()


# Same proxy pattern, for the crypto counterpart bot
# (~/PycharmProjects/pythonProject/SmartApi/crypto/webviewdataapi.py) — each
# user has their own instance on their own crypto_port, same as trading_api()
# above. crypto_port is NULL for a user with no crypto account provisioned yet
# (e.g. created before crypto support existed, or india-only by choice).
def crypto_api(user):
    if user["crypto_port"] is None:
        raise HTTPException(404, "no crypto account provisioned for this user")
    return f"http://localhost:{user['crypto_port']}"


@app.get("/api/crypto/trading/dashboard")
def crypto_trading_dashboard(date: str = None, user=Depends(get_effective_user)):
    params = {"date": date} if date else {}
    resp = requests.get(f"{crypto_api(user)}/api/dashboard", params=params, timeout=20)
    return resp.json()


@app.post("/api/crypto/trading/config")
def crypto_trading_config(payload: dict = Body(...), user=Depends(get_effective_user)):
    resp = requests.post(f"{crypto_api(user)}/api/dashboard/config", json=payload, timeout=20)
    return resp.json()


@app.post("/api/crypto/trading/order")
def crypto_trading_order(payload: dict = Body(...), user=Depends(get_effective_user)):
    resp = requests.post(f"{crypto_api(user)}/api/update_order", json=payload, timeout=20)
    return resp.json()


@app.post("/api/crypto/trading/delete-order")
def crypto_trading_delete_order(payload: dict = Body(...), user=Depends(get_effective_user)):
    resp = requests.post(f"{crypto_api(user)}/api/delete_order", json=payload, timeout=20)
    return resp.json()


@app.post("/api/crypto/trading/exit-order")
def crypto_trading_exit_order(payload: dict = Body(...), user=Depends(get_effective_user)):
    resp = requests.post(f"{crypto_api(user)}/api/exit_order", json=payload, timeout=20)
    return resp.json()


@app.get("/api/crypto/trading/pending-orders")
def crypto_trading_pending_orders(user=Depends(get_effective_user)):
    resp = requests.get(f"{crypto_api(user)}/api/pending_orders", timeout=20)
    return resp.json()


# Chat with an AI about the chart on screen: browser sends a screenshot
# (lightweight-charts' own takeScreenshot(), no client-side rendering lib needed)
# plus recent candles as text context, this just relays it to OpenAI's vision-capable
# chat model and returns the reply. Proxied server-side so the API key never reaches
# the browser.
OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY")
AI_SYSTEM_PROMPT = (
    "You are a trading assistant looking at a live chart (screenshot and/or OHLCV data "
    "may be attached), for an Indian index options trader. Reply in under 100 words, "
    "plain text, no headers or markdown. Cover: market regime (trending up/down, or "
    "sideways/range-bound), entry, target, stoploss (numbers if derivable), and the "
    "options play that fits — buy CE, buy PE, sell/write a strike (e.g. iron condor or "
    "credit spread on range-bound premium decay), or stay out — with one line why. "
    "In a sideways market favor selling/theta strategies over directional buying, and say "
    "so. Skip disclaimers and pleasantries. If asked a plain question instead, answer it "
    "directly in 1-3 sentences. If the user explicitly asks to place/buy an order on a "
    "specific contract right now (e.g. 'place order on 24400 call in nifty', 'buy "
    "BANKNIFTY 54000 PE'), call place_option_order with the extracted underlying, strike "
    "and right instead of just describing it — only do this when they clearly want the "
    "order placed immediately, not when they're just asking for an opinion."
)
PLACE_ORDER_TOOL = {
    "type": "function",
    "function": {
        "name": "place_option_order",
        "description": "Place a real BUY order on an index option contract immediately at the current market price.",
        "parameters": {
            "type": "object",
            "properties": {
                "underlying": {"type": "string", "enum": ["NIFTY", "BANKNIFTY", "SENSEX"]},
                "strike": {"type": "number"},
                "right": {"type": "string", "enum": ["CE", "PE"], "description": "CE for call, PE for put"},
            },
            "required": ["underlying", "strike", "right"],
        },
    },
}


@app.post("/api/ai/chat")
def ai_chat(payload: dict = Body(...), user=Depends(auth.get_current_user)):
    if not OPENAI_API_KEY:
        raise HTTPException(500, "OPENAI_API_KEY not configured on server")
    messages = payload.get("messages") or []
    if not messages:
        raise HTTPException(400, "messages required")
    image = payload.get("image")
    if image:
        last = messages[-1]
        messages = [
            *messages[:-1],
            {"role": "user", "content": [
                {"type": "text", "text": last["content"]},
                {"type": "image_url", "image_url": {"url": image}},
            ]},
        ]
    resp = requests.post(
        "https://api.openai.com/v1/chat/completions",
        headers={"Authorization": f"Bearer {OPENAI_API_KEY}"},
        json={
            "model": "gpt-4o-mini",
            "messages": [{"role": "system", "content": AI_SYSTEM_PROMPT}, *messages],
            "max_tokens": 200,
            "tools": [PLACE_ORDER_TOOL],
        },
        timeout=60,
    )
    if resp.status_code != 200:
        raise HTTPException(502, f"OpenAI request failed: {resp.text}")
    message = resp.json()["choices"][0]["message"]
    tool_calls = message.get("tool_calls")
    if tool_calls:
        args = json.loads(tool_calls[0]["function"]["arguments"])
        # ai_order_service.py expects strike as a string (same as every other caller
        # of this proxy, e.g. AiOrderControls.jsx) — the tool schema emits a number.
        order = trading_ai_enter_option_order({**args, "strike": str(int(args["strike"]))})
        reply = (
            f"Order placed: {order['symbol']} x{order['lotsize']} @ {order['ltp']} (id {order['orderId']})"
            if order.get("status") == "success"
            else f"Order failed: {order.get('message', 'unknown error')}"
        )
    else:
        reply = message["content"]
    return {"success": True, "reply": reply}


# One-shot "professional read": same screenshot+candles input as /api/ai/chat,
# but forces JSON mode so the reply is structured levels + a trade plan the
# frontend can draw as price lines, instead of prose meant for a chat bubble.
AI_ANALYZE_SYSTEM_PROMPT = (
    "You are a professional technical analyst reviewing a live trading chart (screenshot and OHLCV candles "
    "attached) for an Indian index options trader. Identify 3-6 key support/resistance levels, using actual "
    "price values derived from the candle data provided (recent swing highs/lows, round numbers, areas of "
    "consolidation) — not from the screenshot alone. Judge the market regime (trending up, trending down, or "
    "sideways/range-bound) and give ONE professional trading idea: if trending, a directional options play "
    "(buy_ce or buy_pe) with entry, target and stoploss derived from the levels; if range-bound, favor a "
    "theta/selling strategy (sell_ce, sell_pe, credit_spread, iron_condor) and say so explicitly; or "
    "'stay_out' if no clean setup exists. Respond with ONLY a JSON object, no markdown, in this exact shape: "
    '{"bias": "bullish|bearish|sideways", "summary": "one or two professional sentences on the regime and '
    'reasoning", "levels": [{"price": number, "type": "support|resistance", "label": "short label e.g. Prior '
    'swing high"}], "trade": {"direction": "buy_ce|buy_pe|sell_ce|sell_pe|credit_spread|iron_condor|stay_out", '
    '"entry": number|null, "target": number|null, "stoploss": number|null, "reason": "one sentence why"}}'
)


@app.post("/api/ai/analyze")
def ai_analyze(payload: dict = Body(...), user=Depends(auth.get_current_user)):
    if not OPENAI_API_KEY:
        raise HTTPException(500, "OPENAI_API_KEY not configured on server")
    image = payload.get("image")
    context = payload.get("context") or ""
    if not image and not context:
        raise HTTPException(400, "image or context required")
    content = [{"type": "text", "text": f"Analyze this chart.{context}"}]
    if image:
        content.append({"type": "image_url", "image_url": {"url": image}})
    resp = requests.post(
        "https://api.openai.com/v1/chat/completions",
        headers={"Authorization": f"Bearer {OPENAI_API_KEY}"},
        json={
            "model": "gpt-4o-mini",
            "messages": [{"role": "system", "content": AI_ANALYZE_SYSTEM_PROMPT}, {"role": "user", "content": content}],
            "response_format": {"type": "json_object"},
            "max_tokens": 500,
        },
        timeout=60,
    )
    if resp.status_code != 200:
        raise HTTPException(502, f"OpenAI request failed: {resp.text}")
    try:
        analysis = json.loads(resp.json()["choices"][0]["message"]["content"])
    except (KeyError, ValueError):
        raise HTTPException(502, "OpenAI returned an unparseable analysis")
    return {"success": True, **analysis}


# Proxies to sendAlert() in webviewdataapi.py (the same trading-bot Flask app
# trading_api() already points at) — reuses its bot token/chatids instead of
# duplicating them here.
@app.post("/api/telegram/alert")
def telegram_alert(payload: dict = Body(...), user=Depends(get_effective_user)):
    text = payload.get("text")
    if not text:
        raise HTTPException(400, "text required")
    resp = requests.post(f"{trading_api(user)}/api/send_alert", json={"message": text}, timeout=20)
    return resp.json()


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=4001)
