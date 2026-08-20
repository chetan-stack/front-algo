"""Sample SmartAPI websocket feed — adapted from the smartapi project's
websocket_feed.py. Run directly for a live sample check:
  .venv/bin/python websocket_feed.py
"""
import os
import threading

import pyotp
from dotenv import load_dotenv
from SmartApi import SmartConnect
from SmartApi.smartWebSocketV2 import SmartWebSocketV2

load_dotenv()

_sws = None
_latest_ticks = {}  # token -> last tick message


def _login():
    api_key = os.environ["SMARTAPI_KEY"]
    totp = pyotp.TOTP(os.environ["SMARTAPI_TOTP_SECRET"]).now()
    obj = SmartConnect(api_key=api_key)
    session = obj.generateSession(os.environ["SMARTAPI_USER_ID"], os.environ["SMARTAPI_PASSWORD"], totp)
    jwt_token = obj.generateToken(session["data"]["refreshToken"])["data"]["jwtToken"]
    return jwt_token, obj.getfeedToken(), api_key


def start_feed(token_list, correlation_id="abc123", mode=1, on_tick=None):
    """Connect and subscribe in a background thread; safe to call once per process.

    token_list: [{"exchangeType": 2, "tokens": ["58447"]}]
    on_tick: optional callback(message) run on every tick, in addition to the
             internal cache used by get_ltp().
    Returns the connected SmartWebSocketV2 instance.
    """
    global _sws
    jwt_token, feed_token, api_key = _login()
    _sws = SmartWebSocketV2(jwt_token, api_key, os.environ["SMARTAPI_USER_ID"], feed_token)

    def _on_open(wsapp):
        _sws.subscribe(correlation_id, mode, token_list)

    def _on_data(wsapp, message):
        _latest_ticks[message.get("token")] = message
        if on_tick:
            on_tick(message)

    _sws.on_open = _on_open
    _sws.on_data = _on_data
    _sws.on_error = lambda wsapp, error: print("ws error", error)
    _sws.on_close = lambda wsapp: print("ws closed")

    threading.Thread(target=_sws.connect, daemon=True).start()
    return _sws


def get_ltp(token):
    """Last traded price for token, or None if no tick received yet."""
    tick = _latest_ticks.get(token)
    return tick["last_traded_price"] / 100 if tick else None


def subscribe(token_list, correlation_id="abc123", mode=1):
    _sws.subscribe(correlation_id, mode, token_list)


def close():
    if _sws:
        _sws.close_connection()


def demo():
    # ponytail: smallest runnable check — asserts the module wires up without
    # actually opening a socket (no live credentials required for this part).
    assert get_ltp("no-such-token") is None
    print("websocket_feed self-check passed")

    if os.environ.get("SMARTAPI_KEY"):
        # Live sample check: subscribe to Reliance (NSE token 2885) and print ticks.
        start_feed([{"exchangeType": 1, "tokens": ["2885"]}], on_tick=print)
        print("live feed started, watching for ticks (Ctrl+C to stop)...")
        threading.Event().wait(15)
    else:
        print("SMARTAPI_KEY not set in .env — skipping live sample check")


if __name__ == "__main__":
    demo()
