"""Bridges Delta Exchange's public ticker websocket into per-symbol asyncio
queues so server.py's /ws/live endpoint can forward live crypto ticks to the
browser, the same way live_feed.py does for india tickers. Public market
data, no credentials needed — one shared connection for everyone, same as
the india feed (this has nothing to do with any user's own DeltaEx account).

Protocol confirmed against crypto/exitsteterrgy.py in the SmartApi project,
which already talks to this same endpoint/channel successfully.
"""
import asyncio
import json
import re
import threading
import time

import websocket

# The global endpoint (wss://socket.delta.exchange, used in the old
# crypto/exitsteterrgy.py) never sends data for India-listed symbols — this
# project's REST calls all go to cdn.india.deltaex.org, and the matching
# websocket host is this one (confirmed directly: subscribing here returns
# real v2/ticker messages for BTCUSD, the global host returns nothing).
DELTA_WS_URL = "wss://socket.india.deltaex.org"

# Chart symbols look like "BINANCE:BTCUSDT" — Delta's own symbol is just "BTCUSD".
# ponytail: only the pairs the chart actually offers; add more as needed.
SYMBOL_MAP = {
    "BTCUSDT": "BTCUSD",
    "ETHUSDT": "ETHUSD",
}

# Option contract symbols (e.g. "C-BTC-79800-290826") are already Delta's own
# symbol format — confirmed v2/ticker sends real close/symbol data for these
# same as it does for spot — so pass them straight through instead of only
# recognizing the two spot pairs.
DELTA_OPTION_RE = re.compile(r"^[CP]-(BTC|ETH)-\d+-\d{6}$")


def resolve(symbol):
    """'BINANCE:BTCUSDT' -> 'BTCUSD', a raw option symbol -> itself, or None (caller falls back to polling)."""
    if DELTA_OPTION_RE.match(symbol):
        return symbol
    _, sep, sym = symbol.partition(":")
    return SYMBOL_MAP.get(sym if sep else symbol)


# --- one shared Delta Exchange websocket connection, fanned out to browser clients ---

_ws = None
_subs = {}  # delta_symbol -> set[asyncio.Queue]
_connect_lock = threading.Lock()
_loop = None


def _on_message(wsapp, message):
    data = json.loads(message)
    symbol = data.get("symbol")
    if symbol not in _subs or "close" not in data:
        return
    tick = {"price": float(data["close"]), "time": int(time.time())}
    for q in list(_subs[symbol]):
        _loop.call_soon_threadsafe(q.put_nowait, tick)


def _on_disconnect(wsapp, *_):
    global _ws
    print("crypto live feed closed")
    _ws = None


def _ensure_connected(loop):
    global _ws, _loop
    with _connect_lock:
        _loop = loop
        if _ws is not None:
            return
        wsapp = websocket.WebSocketApp(
            DELTA_WS_URL, on_message=_on_message, on_close=_on_disconnect,
            on_error=lambda wsapp, error: print("crypto live feed error", error),
        )
        opened = threading.Event()
        wsapp.on_open = lambda wsapp: opened.set()
        threading.Thread(target=wsapp.run_forever, daemon=True).start()
        opened.wait(timeout=10)
        _ws = wsapp


async def subscribe(delta_symbol):
    """Register interest in a Delta symbol; returns an asyncio.Queue of {price, time} ticks."""
    if _ws is None:
        await asyncio.to_thread(_ensure_connected, asyncio.get_running_loop())
    queue = asyncio.Queue()
    is_new = delta_symbol not in _subs
    _subs.setdefault(delta_symbol, set()).add(queue)
    if is_new and _ws:
        _ws.send(json.dumps({"type": "subscribe", "payload": {"channels": [{"name": "v2/ticker", "symbols": [delta_symbol]}]}}))
    return queue


def unsubscribe(delta_symbol, queue):
    entry = _subs.get(delta_symbol)
    if not entry:
        return
    entry.discard(queue)
    if not entry:
        del _subs[delta_symbol]
        if _ws:
            _ws.send(json.dumps({"type": "unsubscribe", "payload": {"channels": [{"name": "v2/ticker", "symbols": [delta_symbol]}]}}))


def demo():
    assert resolve("BINANCE:BTCUSDT") == "BTCUSD"
    assert resolve("BINANCE:NOSUCHCOIN") is None
    assert resolve("C-BTC-79800-290826") == "C-BTC-79800-290826"
    assert resolve("P-ETH-3000-290826") == "P-ETH-3000-290826"
    print("crypto_live_feed self-check passed")


if __name__ == "__main__":
    demo()
