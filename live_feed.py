"""Bridges Angel One SmartAPI's tick websocket into per-symbol asyncio
queues so server.py's /ws/live endpoint can forward live ticks to the
browser. resolve() returns None for any symbol not found in the scrip
master (e.g. crypto, unlisted contracts) — the caller then falls back to
the existing polling approach.
"""
import asyncio
import json
import os
import re
import threading
import time

import pyotp
import requests
from dotenv import load_dotenv
from SmartApi import SmartConnect
from SmartApi.smartWebSocketV2 import SmartWebSocketV2

load_dotenv()

SCRIP_MASTER_URL = "https://margincalculator.angelone.in/OpenAPI_File/files/OpenAPIScripMaster.json"
SCRIP_MASTER_CACHE = os.path.join(os.path.dirname(__file__), ".scrip_master_cache.json")
SCRIP_MASTER_TTL = 24 * 3600

EXCHANGE_TYPE = {"NSE": SmartWebSocketV2.NSE_CM, "BSE": SmartWebSocketV2.BSE_CM}

# Indices are listed in the scrip master under a display name ("Nifty 50"),
# not their ticker, so fuzzy-matching isn't worth it — map the handful the
# chart actually offers directly.
INDEX_TOKENS = {
    ("NSE", "NIFTY"): "99926000",
    ("NSE", "BANKNIFTY"): "99926009",
    ("NSE", "FINNIFTY"): "99926037",
    ("NSE", "MIDCPNIFTY"): "99926074",
}

EXCHANGE_TYPE_FO = {"NFO": SmartWebSocketV2.NSE_FO, "BFO": SmartWebSocketV2.BSE_FO}

# TradingView's option symbol (e.g. "NIFTY260818C25000", "BSX260820C81000")
# spells the underlying, expiry (YYMMDD), right and strike unambiguously —
# far more reliable to parse than trying to reverse-engineer Angel's own
# symbol strings, which drop the day for monthly contracts. Map straight to
# Angel's (exch_seg, name) and rebuild the expiry/strike into their format
# instead.
OPTION_UNDERLYING = {
    ("NSE", "NIFTY"): ("NFO", "NIFTY"),
    ("NSE", "BANKNIFTY"): ("NFO", "BANKNIFTY"),
    ("NSE", "FINNIFTY"): ("NFO", "FINNIFTY"),
    ("NSE", "MIDCPNIFTY"): ("NFO", "MIDCPNIFTY"),
    ("BSE", "BSX"): ("BFO", "SENSEX"),
}
OPTION_SYMBOL_RE = re.compile(r"^([A-Z]+)(\d{2})(\d{2})(\d{2})([CP])(\d+)$")
MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"]

_raw_scrip_data = None
_scrip_by_key = None  # (exch_seg, symbol-without-"-EQ") -> token
_options_by_key = None  # (exch_seg, name, expiry "DDMMMYYYY", strike-in-paise, "C"/"P") -> token


def _fetch_scrip_master():
    global _raw_scrip_data
    if _raw_scrip_data is not None:
        return _raw_scrip_data
    if os.path.exists(SCRIP_MASTER_CACHE) and time.time() - os.path.getmtime(SCRIP_MASTER_CACHE) < SCRIP_MASTER_TTL:
        with open(SCRIP_MASTER_CACHE) as f:
            data = json.load(f)
    else:
        data = requests.get(SCRIP_MASTER_URL, timeout=30).json()
        with open(SCRIP_MASTER_CACHE, "w") as f:
            json.dump(data, f)
    _raw_scrip_data = data
    return data


def _load_scrip_master():
    global _scrip_by_key
    if _scrip_by_key is not None:
        return _scrip_by_key
    by_key = {}
    for row in _fetch_scrip_master():
        sym = row.get("symbol", "")
        if sym.endswith("-EQ"):
            by_key[(row["exch_seg"], sym[:-3])] = row["token"]
    _scrip_by_key = by_key
    return by_key


def _load_options_index():
    global _options_by_key
    if _options_by_key is not None:
        return _options_by_key
    by_key = {}
    for row in _fetch_scrip_master():
        if row.get("instrumenttype") not in ("OPTIDX", "OPTSTK"):
            continue
        right = row.get("symbol", "")[-2:]
        if right not in ("CE", "PE"):
            continue
        try:
            strike_paise = round(float(row["strike"]))
        except (KeyError, TypeError, ValueError):
            continue
        by_key[(row["exch_seg"], row["name"], row["expiry"], strike_paise, right[0])] = row["token"]
    _options_by_key = by_key
    return by_key


def _resolve_option(exchange, sym):
    m = OPTION_SYMBOL_RE.match(sym)
    if not m:
        return None
    underlying, yy, mm, dd, right, strike = m.groups()
    mapped = OPTION_UNDERLYING.get((exchange, underlying))
    if not mapped:
        return None
    exch_seg, name = mapped
    expiry = f"{dd}{MONTHS[int(mm) - 1]}20{yy}"
    token = _load_options_index().get((exch_seg, name, expiry, int(strike) * 100, right))
    return (EXCHANGE_TYPE_FO[exch_seg], token) if token else None


def resolve(symbol):
    """'NSE:RELIANCE' / 'NSE:NIFTY260818C25000' -> (exchange_type, token),
    or None if not on SmartAPI (caller falls back to polling)."""
    exchange, sep, sym = symbol.partition(":")
    if not sep:
        exchange, sym = "NSE", exchange
    option = _resolve_option(exchange, sym)
    if option:
        return option
    if exchange not in EXCHANGE_TYPE:
        return None
    if (exchange, sym) in INDEX_TOKENS:
        return EXCHANGE_TYPE[exchange], INDEX_TOKENS[(exchange, sym)]
    token = _load_scrip_master().get((exchange, sym))
    return (EXCHANGE_TYPE[exchange], token) if token else None


# --- one shared SmartAPI websocket connection, fanned out to browser clients ---

_sws = None
_subs = {}  # token -> {"exchange_type": int, "queues": set[asyncio.Queue]}
_connect_lock = threading.Lock()


def _login():
    api_key = os.environ["SMARTAPI_KEY"]
    totp = pyotp.TOTP(os.environ["SMARTAPI_TOTP_SECRET"]).now()
    obj = SmartConnect(api_key=api_key)
    session = obj.generateSession(os.environ["SMARTAPI_USER_ID"], os.environ["SMARTAPI_PASSWORD"], totp)
    jwt_token = obj.generateToken(session["data"]["refreshToken"])["data"]["jwtToken"]
    return jwt_token, obj.getfeedToken(), api_key


# --- shared authenticated session for REST historical-candle lookups ---
# Demo accounts (no broker session of their own) have no other way to get
# an option contract's historical candles — AngelOne's REST API needs a
# real login, and anonymous TradingView doesn't resolve NFO/BFO symbols.
# Same shared account as the websocket above (same env vars), just kept as
# a live SmartConnect object here since REST calls need the object itself,
# not just its derived jwt/feed tokens.
_rest_obj = None
_rest_lock = threading.Lock()


def _get_rest_session():
    global _rest_obj
    with _rest_lock:
        if _rest_obj is None:
            api_key = os.environ["SMARTAPI_KEY"]
            totp = pyotp.TOTP(os.environ["SMARTAPI_TOTP_SECRET"]).now()
            obj = SmartConnect(api_key=api_key)
            obj.generateSession(os.environ["SMARTAPI_USER_ID"], os.environ["SMARTAPI_PASSWORD"], totp)
            _rest_obj = obj
        return _rest_obj


def get_historical_candles(exch_seg, token, interval, from_date, to_date):
    """[[datetime, open, high, low, close, volume], ...] for the given Angel
    One (exch_seg, token), via the shared account's own REST session. Retries
    once with a fresh login if the cached session has gone stale."""
    params = {
        "exchange": exch_seg,
        "symboltoken": token,
        "interval": interval,
        "fromdate": from_date,
        "todate": to_date,
    }
    obj = _get_rest_session()
    try:
        return obj.getCandleData(params)["data"]
    except Exception:
        global _rest_obj
        with _rest_lock:
            _rest_obj = None
        obj = _get_rest_session()
        return obj.getCandleData(params)["data"]


def _on_data(wsapp, message, loop):
    entry = _subs.get(message.get("token"))
    if not entry:
        return
    for q in list(entry["queues"]):
        loop.call_soon_threadsafe(q.put_nowait, message)


def _on_disconnect():
    global _sws
    print("live feed closed")
    _sws = None


def _ensure_connected(loop):
    global _sws
    with _connect_lock:
        if _sws is not None:
            return
        jwt_token, feed_token, api_key = _login()
        sws = SmartWebSocketV2(jwt_token, api_key, os.environ["SMARTAPI_USER_ID"], feed_token)
        sws.on_data = lambda wsapp, message: _on_data(wsapp, message, loop)
        sws.on_error = lambda wsapp, error: print("live feed error", error)
        sws.on_close = lambda wsapp: _on_disconnect()
        opened = threading.Event()
        sws.on_open = lambda wsapp: opened.set()
        threading.Thread(target=sws.connect, daemon=True).start()
        opened.wait(timeout=10)
        _sws = sws


async def subscribe(exchange_type, token):
    """Register interest in a token; returns an asyncio.Queue of raw tick dicts."""
    if _sws is None:
        await asyncio.to_thread(_ensure_connected, asyncio.get_running_loop())
    queue = asyncio.Queue()
    entry = _subs.setdefault(token, {"exchange_type": exchange_type, "queues": set()})
    is_new = not entry["queues"]
    entry["queues"].add(queue)
    if is_new:
        _sws.subscribe("live1", SmartWebSocketV2.LTP_MODE, [{"exchangeType": exchange_type, "tokens": [token]}])
    return queue


def unsubscribe(token, queue):
    entry = _subs.get(token)
    if not entry:
        return
    entry["queues"].discard(queue)
    if not entry["queues"]:
        del _subs[token]
        if _sws:
            _sws.unsubscribe("live1", SmartWebSocketV2.LTP_MODE, [{"exchangeType": entry["exchange_type"], "tokens": [token]}])


def demo():
    assert resolve("NSE:RELIANCE") == (1, "2885")
    assert resolve("NSE:NIFTY") == (1, "99926000")
    assert resolve("NSE:NOSUCHSYMBOL") is None
    # options: exercise the parser/index even if these particular contracts
    # have since expired (in which case they legitimately resolve to None).
    for sym in ("NSE:NIFTY260818C25000", "NSE:BANKNIFTY260825P54000", "BSE:BSX260820C81000"):
        resolve(sym)
    print("live_feed self-check passed")


if __name__ == "__main__":
    demo()
