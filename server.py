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


# Admin screen: create a new user's app login + their SmartApi account
# directory (accounts/<username>/document.py + auto_trade.json), then start
# their two bot processes. Lives in the SmartApi repo, a sibling directory —
# see SmartApi/new_account.sh, which this mirrors as an HTTP-driven version.
SMARTAPI_DIR = Path(os.environ.get("SMARTAPI_DIR", str(Path.home() / "PycharmProjects/pythonProject/SmartApi")))
SMARTAPI_VENV_PYTHON = SMARTAPI_DIR.parent / "venv" / "bin" / "python"


def _port_free(port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        return s.connect_ex(("localhost", port)) != 0


def _next_ports():
    existing = auth.list_users()
    base = max([u["webview_port"] for u in existing], default=4090) + 10
    while not (_port_free(base) and _port_free(base + 4)):
        base += 10
    return base, base + 4


def _document_py_content(angelone):
    if not angelone:
        return (
            "# Demo account — no broker login, no credentials needed.\n"
            "demo_mode = True\n"
            "chatids = []\n"
        )
    return (
        f"api_key = {json.dumps(angelone.get('api_key', ''))}\n"
        f"user_id = {json.dumps(angelone.get('user_id', ''))}\n"
        f"password = {json.dumps(angelone.get('password', ''))}\n"
        f"totp = {json.dumps(angelone.get('totp', ''))}\n"
        "chatids = []\n"
    )


def _start_bot_process(script_name, account_dir, port):
    log_dir = SMARTAPI_DIR / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    log_file = open(log_dir / f"{account_dir.name}_{script_name.removesuffix('.py')}.log", "w")
    proc = subprocess.Popen(
        [str(SMARTAPI_VENV_PYTHON), str(SMARTAPI_DIR / script_name)],
        cwd=str(account_dir), env={**os.environ, "PORT": str(port)},
        stdout=log_file, stderr=subprocess.STDOUT,
    )
    log_file.close()  # Popen already duped the fd for the child; safe to close our handle
    return proc


@app.get("/api/admin/users")
def admin_list_users(admin=Depends(auth.require_admin)):
    return {"success": True, "users": [
        {
            "username": u["username"], "webview_port": u["webview_port"], "ai_port": u["ai_port"],
            "is_admin": bool(u["is_admin"]),
            "webview_alive": not _port_free(u["webview_port"]),
            "ai_alive": not _port_free(u["ai_port"]),
        }
        for u in auth.list_users()
    ]}


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
    webview_port, ai_port = _next_ports()
    account_dir.mkdir(parents=True)
    (account_dir / "document.py").write_text(_document_py_content(angelone))
    (account_dir / "auto_trade.json").write_text(json.dumps({"withmoney": False, "lotsize": 1}, indent=4))

    auth.create_user(username, password, webview_port, ai_port)

    # Real broker logins get rate-limited by AngelOne if fired too close together
    # (confirmed — "Access denied because of exceeding access rate") — stagger
    # them. Demo accounts skip the broker login entirely, so no need to wait.
    webview_proc = _start_bot_process("webviewdataapi.py", account_dir, webview_port)
    time.sleep(1.5 if not angelone else 8)
    webview_alive = webview_proc.poll() is None

    ai_proc = _start_bot_process("ai_order_service.py", account_dir, ai_port)
    time.sleep(1.5 if not angelone else 3)
    ai_alive = ai_proc.poll() is None

    return {
        "success": True, "username": username, "webview_port": webview_port, "ai_port": ai_port,
        "webview_alive": webview_alive, "ai_alive": ai_alive,
    }

# get_hist() opens a websocket on whatever instance calls it. A single shared
# instance across concurrent requests races on the same connection and
# corrupts data (confirmed); a fresh instance per request with no cap fixes
# that but opens too many simultaneous anonymous websockets and TradingView
# starts dropping them ("Connection to remote host was lost", confirmed).
# Bounded concurrency avoids both: cap simultaneous connections, still allow
# multiple chart panes to load in parallel instead of one queue.
# ponytail: fixed ceiling of 4, tune (or make a queue) if panes/users grow.
tv_slots = threading.Semaphore(4)

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
    df = fetch(symbol, "1", 1)
    ts, r = df.index[-1], df.iloc[-1]
    return {"success": True, "time": epoch(ts), "open": r.open, "high": r.high, "low": r.low, "close": r.close}


# Live ticks via SmartAPI's websocket, for the chart's "Live" toggle. If the
# symbol isn't resolvable on SmartAPI (resolve() returns None — e.g. crypto,
# unlisted contracts) the socket closes immediately and the frontend falls
# back to polling /api/quote as before.
@app.websocket("/ws/live")
async def ws_live(websocket: WebSocket, symbol: str = "NSE:NIFTY"):
    await websocket.accept()
    resolved = await asyncio.to_thread(live_feed.resolve, symbol)
    if resolved is None:
        await websocket.close(code=4004)
        return
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
def trading_dashboard(date: str = None, selectclient: str = None, user=Depends(auth.get_current_user)):
    params = {k: v for k, v in {"date": date, "selectclient": selectclient}.items() if v}
    resp = requests.get(f"{trading_api(user)}/api/dashboard", params=params, timeout=20)
    return resp.json()


@app.post("/api/trading/config")
def trading_config(payload: dict = Body(...), user=Depends(auth.get_current_user)):
    resp = requests.post(f"{trading_api(user)}/api/dashboard/config", json=payload, timeout=20)
    return resp.json()


@app.post("/api/trading/order")
def trading_order(payload: dict = Body(...), user=Depends(auth.get_current_user)):
    resp = requests.post(f"{trading_api(user)}/api/update_order", json=payload, timeout=20)
    return resp.json()


@app.post("/api/trading/delete-order")
def trading_delete_order(payload: dict = Body(...), user=Depends(auth.get_current_user)):
    resp = requests.post(f"{trading_api(user)}/api/delete_order", json=payload, timeout=20)
    return resp.json()


@app.post("/api/trading/exit-order")
def trading_exit_order(payload: dict = Body(...), user=Depends(auth.get_current_user)):
    resp = requests.post(f"{trading_api(user)}/api/exit_order", json=payload, timeout=20)
    return resp.json()


@app.get("/api/trading/pending-orders")
def trading_pending_orders(selectclient: str = None, user=Depends(auth.get_current_user)):
    params = {"selectclient": selectclient} if selectclient else {}
    resp = requests.get(f"{trading_api(user)}/api/pending_orders", params=params, timeout=20)
    return resp.json()


# Proxy for ai_order_service.py (a brand-new, standalone script in the SmartApi
# project — see that file's docstring). Runs as its own process with its own
# broker session per user, same per-user-port pattern as trading_api() above.
def ai_order_api(user):
    return f"http://localhost:{user['ai_port']}"


@app.post("/api/trading/ai-enter-order")
def trading_ai_enter_order(payload: dict = Body(...), user=Depends(auth.get_current_user)):
    resp = requests.post(f"{ai_order_api(user)}/api/ai/enter-order", json=payload, timeout=30)
    return resp.json()


@app.post("/api/trading/ai-exit-order")
def trading_ai_exit_order(payload: dict = Body(...), user=Depends(auth.get_current_user)):
    resp = requests.post(f"{ai_order_api(user)}/api/ai/exit-order", json=payload, timeout=30)
    return resp.json()


@app.post("/api/trading/ai-enter-option-order")
def trading_ai_enter_option_order(payload: dict = Body(...), user=Depends(auth.get_current_user)):
    resp = requests.post(f"{ai_order_api(user)}/api/ai/enter-option-order", json=payload, timeout=30)
    return resp.json()


# Same proxy pattern, for the crypto counterpart bot
# (~/PycharmProjects/pythonProject/SmartApi/crypto/webviewdataapi.py, port
# 4101) — separate JSON store and DB, no client selector, smaller config.
CRYPTO_TRADING_API = "http://localhost:4101"


@app.get("/api/crypto/trading/dashboard")
def crypto_trading_dashboard(date: str = None, user=Depends(auth.get_current_user)):
    params = {"date": date} if date else {}
    resp = requests.get(f"{CRYPTO_TRADING_API}/api/dashboard", params=params, timeout=20)
    return resp.json()


@app.post("/api/crypto/trading/config")
def crypto_trading_config(payload: dict = Body(...), user=Depends(auth.get_current_user)):
    resp = requests.post(f"{CRYPTO_TRADING_API}/api/dashboard/config", json=payload, timeout=20)
    return resp.json()


@app.post("/api/crypto/trading/order")
def crypto_trading_order(payload: dict = Body(...), user=Depends(auth.get_current_user)):
    resp = requests.post(f"{CRYPTO_TRADING_API}/api/update_order", json=payload, timeout=20)
    return resp.json()


@app.post("/api/crypto/trading/delete-order")
def crypto_trading_delete_order(payload: dict = Body(...), user=Depends(auth.get_current_user)):
    resp = requests.post(f"{CRYPTO_TRADING_API}/api/delete_order", json=payload, timeout=20)
    return resp.json()


@app.post("/api/crypto/trading/exit-order")
def crypto_trading_exit_order(payload: dict = Body(...), user=Depends(auth.get_current_user)):
    resp = requests.post(f"{CRYPTO_TRADING_API}/api/exit_order", json=payload, timeout=20)
    return resp.json()


@app.get("/api/crypto/trading/pending-orders")
def crypto_trading_pending_orders(user=Depends(auth.get_current_user)):
    resp = requests.get(f"{CRYPTO_TRADING_API}/api/pending_orders", timeout=20)
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
def telegram_alert(payload: dict = Body(...), user=Depends(auth.get_current_user)):
    text = payload.get("text")
    if not text:
        raise HTTPException(400, "text required")
    resp = requests.post(f"{trading_api(user)}/api/send_alert", json={"message": text}, timeout=20)
    return resp.json()


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=4001)
