# All AI in the dashboard runs on Claude Code (the `claude` CLI on this Mac,
# logged in with the owner's claude.ai account) — no OpenAI, no API key:
# - the "AI Chat" tab: news, chart explanation, levels, patterns, strategies,
#   India + crypto (POST /api/ai/claude-chat, streamed as NDJSON);
# - the chart panel's assistant (server.py /api/ai/chat, /api/ai/analyze) via
#   ask_claude().
#
# Each question runs `claude -p` headless in an empty directory with only
# WebSearch/WebFetch — no Bash/Read/Edit, no user settings/hooks/plugins — so a
# web page can't steer it into this machine's files or broker keys. Candles come
# from our own /api/ohlcv and are put in the prompt; levels/trade ideas come back
# as a ```plan block the browser shows as a card. Nothing here places orders.
import datetime
import json
import os
import re
import shutil
import subprocess
import tempfile
import threading
import time
import traceback

import requests
from fastapi import APIRouter, Body, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse

import auth

router = APIRouter()
SELF = "http://127.0.0.1:4001"  # this same backend's public-data endpoints
CLAUDE = shutil.which("claude") or "/usr/local/bin/claude"
CWD = tempfile.mkdtemp(prefix="aichat-")  # empty: no CLAUDE.md / project files to read
TIMEOUT = 240  # seconds per question (web search + long answers)
_slots = threading.Semaphore(2)  # ponytail: ~250MB per claude process; raise if RAM allows
IST = datetime.timezone(datetime.timedelta(hours=5, minutes=30))
CHAT_MODEL = "sonnet"  # AI Chat tab; the chart panel keeps Claude Code's default
DAILY_LIMIT = 5  # AI questions per non-admin user per IST day (chat tab + chart panel); admins unlimited
USAGE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ai_usage.json")
_usage_lock = threading.Lock()


def _count(user, step):
    """Add step to the user's count for today (IST); returns the new count."""
    today = f"{datetime.datetime.now(IST):%Y-%m-%d}"
    with _usage_lock:
        try:
            with open(USAGE_FILE) as f:
                usage = json.load(f)
        except (OSError, ValueError):
            usage = {}
        counts = usage.get("counts", {}) if usage.get("date") == today else {}
        n = counts[user["username"]] = max(0, counts.get(user["username"], 0) + step)
        tmp = f"{USAGE_FILE}.{os.getpid()}.tmp"
        with open(tmp, "w") as f:
            json.dump({"date": today, "counts": counts}, f)
        os.replace(tmp, USAGE_FILE)
        return n


def take_quota(user):
    """Count one AI question; 429 when a non-admin is over today's limit. Returns questions left (None = unlimited)."""
    if user["is_admin"]:
        return None
    used = _count(user, 1)
    if used > DAILY_LIMIT:
        _count(user, -1)
        raise HTTPException(429, f"Daily AI limit reached ({DAILY_LIMIT} questions). It resets at midnight IST.")
    return DAILY_LIMIT - used


def refund_quota(user):
    """A question that failed on our side doesn't count."""
    if not user["is_admin"]:
        _count(user, -1)

SYSTEM = """You are the market assistant inside a trading dashboard used by Indian F&O and crypto traders.
Answer like a sharp professional trader: direct, specific numbers, short paragraphs and '-' bullets. Plain text only: the chat shows no markdown (no **, #, tables).

Markets and symbols (TradingView style, EXCHANGE:SYMBOL):
- India: NSE:NIFTY, NSE:BANKNIFTY, BSE:SENSEX, stocks like NSE:RELIANCE. The user's bots trade index options (CE/PE, weekly expiries).
- Crypto: BINANCE:BTCUSDT, BINANCE:ETHUSDT; the user's crypto bot trades DeltaEx BTCUSD/ETHUSD perpetuals and BTC/ETH options.

Rules:
- Live candles for the symbols in question are attached below the question. Base every price, level and pattern on them (swing highs/lows, ranges, EMAs you compute). Never invent prices. If the symbol you need has no candles attached, say so and ask the user to write it as EXCHANGE:SYMBOL (e.g. NSE:TCS).
- For news, events, results or "why is X moving", use WebSearch and name your sources.
- Explain the strategy (trend, breakout, range/theta selling, hedged sell, etc.), the invalidation, and the risk. If there is no clean setup, say stay out.
- A chart screenshot may be attached; read it, but prefer candle data for exact prices.
- You cannot place orders; the user decides and clicks.
- Whenever you give support/resistance levels or a buy/sell idea, end your answer with ONE block, exactly:
```plan
{"symbol": "NSE:NIFTY", "bias": "bullish|bearish|sideways", "levels": [{"price": 0, "type": "support|resistance", "label": "short"}], "trade": {"direction": "buy|sell|buy_ce|buy_pe|sell_ce|sell_pe|stay_out", "entry": 0, "target": 0, "stoploss": 0, "underlying": "NIFTY|BANKNIFTY|SENSEX", "strike": 0, "right": "CE|PE", "reason": "one line"}}
```
Omit trade fields that don't apply; underlying/strike/right only for an India index option idea. The block is turned into buttons, don't mention it."""

# words -> chart symbol, for questions that don't spell out EXCHANGE:SYMBOL
ALIASES = [
    (r"\bbank\s*nifty\b", "NSE:BANKNIFTY"), (r"\bnifty\b", "NSE:NIFTY"), (r"\bsensex\b", "BSE:SENSEX"),
    (r"\b(btc|bitcoin)\b", "BINANCE:BTCUSDT"), (r"\b(eth|ethereum|ether)\b", "BINANCE:ETHUSDT"),
]
SYMBOL_RE = re.compile(r"\b([A-Z]{2,10}:[A-Z0-9_.&-]{2,30})\b")
PLAN_RE = re.compile(r"```plan\s*(\{.*?\})\s*```", re.S)


def _symbols(text, context):
    """Chart symbols a question is about: explicit ones, known names, else the open chart(s)."""
    found = SYMBOL_RE.findall(text.upper())
    for pat, sym in ALIASES:  # in order, removing each match: "bank nifty" isn't also NIFTY
        if re.search(pat, text, re.I):
            found.append(sym)
            text = re.sub(pat, " ", text, flags=re.I)
    if not found:
        found = SYMBOL_RE.findall(context.upper())
    return list(dict.fromkeys(found))[:3]


def _candles(symbol, resolution, count):
    try:
        r = requests.get(f"{SELF}/api/ohlcv", params={"symbol": symbol, "resolution": resolution, "count": count}, timeout=30)
        bars = r.json().get("bars") if r.ok else None
    except (requests.RequestException, ValueError):
        bars = None
    if not bars:
        return f"{symbol} {resolution}: no data"
    rows = [f"{datetime.datetime.fromtimestamp(b['time'], IST):%m-%d %H:%M},{b['open']:g},{b['high']:g},{b['low']:g},{b['close']:g}" for b in bars[-count:]]
    return f"{symbol} resolution {resolution} (time_ist,open,high,low,close):\n" + "\n".join(rows)


def _image_block(image):
    """Claude content block for a data-URL screenshot, or None."""
    if isinstance(image, str) and image.startswith("data:image/") and ";base64," in image:
        media, data = image[5:].split(";base64,", 1)
        return {"type": "image", "source": {"type": "base64", "media_type": media, "data": data}}
    return None


def claude_code(content, system, model=None, tools="WebSearch,WebFetch", slots=_slots, schema=None):
    """Run one headless Claude Code turn. Yields ("text", delta), ("status", msg), ("error", msg);
    with a JSON schema also ("json", object) at the end (Claude Code's structured output)."""
    if not slots.acquire(timeout=60):
        yield "error", "AI is busy with other questions — try again in a minute."
        return
    proc = None
    errlog = tempfile.TemporaryFile(mode="w+")  # a full stderr pipe would stall claude
    try:
        proc = subprocess.Popen(
            [CLAUDE, "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
             "--include-partial-messages", "--tools", tools, *(["--allowedTools", tools] if tools else []),
             "--setting-sources", "", "--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence",
             "--system-prompt", system, *(["--model", model] if model else []),
             *(["--json-schema", json.dumps(schema)] if schema else [])],
            cwd=CWD, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=errlog, text=True,
        )
        killer = threading.Timer(TIMEOUT, proc.kill)
        killer.start()
        proc.stdin.write(json.dumps({"type": "user", "message": {"role": "user", "content": content}}) + "\n")
        proc.stdin.close()
        result = None
        for raw in proc.stdout:
            try:
                ev = json.loads(raw)
            except ValueError:
                continue
            if ev.get("type") == "stream_event":
                e = ev.get("event") or {}
                if e.get("type") == "content_block_delta" and (e.get("delta") or {}).get("type") == "text_delta":
                    yield "text", e["delta"]["text"]
                elif e.get("type") == "content_block_delta" and schema:  # structured output streams as tool input
                    yield "status", "AI is building your plan…"
                elif e.get("type") == "content_block_start" and (e.get("content_block") or {}).get("type") in ("tool_use", "server_tool_use"):
                    yield "status", "Searching the web…" if "Search" in e["content_block"].get("name", "") else "Reading a web page…"
            elif ev.get("type") == "result":
                result = ev
        killer.cancel()
        proc.wait(timeout=10)
        if result is None or result.get("is_error"):
            errlog.seek(0)
            err = (result or {}).get("result") or errlog.read()[-300:].strip() or "timed out"
            yield "error", f"Claude Code failed: {err}"
        elif schema:
            if result.get("structured_output"):
                yield "json", result["structured_output"]
            else:
                yield "error", "Claude Code returned no structured answer"
    except FileNotFoundError:
        yield "error", f"Claude Code CLI not found at {CLAUDE}."
    finally:
        if proc and proc.poll() is None:  # browser left / timeout: don't leave it running
            proc.kill()
        errlog.close()
        slots.release()


def ask_claude(user, prompt, system, image=None):
    """Whole answer as a string (for the chart panel's non-streaming endpoints); counts toward the user's quota."""
    take_quota(user)
    content = [b for b in (_image_block(image), {"type": "text", "text": prompt}) if b]
    text, errors = [], []
    for kind, value in claude_code(content, system):
        if kind == "text":
            text.append(value)
        elif kind == "error":
            errors.append(value)
    if errors:
        refund_quota(user)
        raise HTTPException(502, errors[0])
    return "".join(text)


def _chat_stream(user, history, image, context, left):
    line = lambda kind, value: json.dumps({"t": kind, "v": value}) + "\n"
    failed = False
    yield line("quota", {"left": left, "limit": DAILY_LIMIT})
    try:
        question = history[-1]["content"]
        earlier = "\n\n".join(f"{m['role'].upper()}: {m['content']}" for m in history[:-1])
        symbols = _symbols(question + ("\n" + earlier[-500:] if earlier else ""), context)
        if symbols:
            yield line("status", f"Reading candles for {', '.join(symbols)}…")
        data = "\n\n".join(_candles(s, res, n) for s in symbols for res, n in (("5", 120), ("D", 60)))
        now = datetime.datetime.now(IST)
        prompt = (
            (f"Conversation so far:\n{earlier}\n\n" if earlier else "")
            + f"Question: {question}\n\nNow: {now:%A %Y-%m-%d %H:%M} IST."
            + (f" User's open charts: {context}." if context else "")
            + (f"\n\nLive candles:\n{data}" if data else "")
        )
        content = [b for b in (_image_block(image), {"type": "text", "text": prompt}) if b]
        yield line("status", "Thinking…")
        # Stream text but hold back the ```plan block (it becomes a card); keep a
        # few chars in reserve in case the marker is split across deltas.
        full, sent = "", 0
        for kind, value in claude_code(content, SYSTEM, CHAT_MODEL):
            if kind != "text":
                failed = failed or kind == "error"
                yield line(kind, value)
                continue
            full += value
            cut = full.find("```plan")
            upto = cut if cut >= 0 else max(sent, len(full) - 8)
            if upto > sent:
                yield line("text", full[sent:upto])
                sent = upto
        if "```plan" not in full and len(full) > sent:
            yield line("text", full[sent:])
        for block in PLAN_RE.findall(full):
            try:
                plan = json.loads(block)
            except ValueError:
                continue
            if isinstance(plan, dict) and isinstance(plan.get("symbol"), str) and isinstance(plan.get("levels", []), list):
                yield line("plan", plan)
    except Exception as e:  # never drop the connection mid-stream: the browser only shows "Load failed"
        traceback.print_exc()
        failed = True
        yield line("error", f"AI chat failed: {e}")
    if failed:
        refund_quota(user)
        if left is not None:
            yield line("quota", {"left": left + 1, "limit": DAILY_LIMIT})
    yield line("done", None)


@router.post("/api/ai/claude-chat")
def claude_chat(payload: dict = Body(...), user=Depends(auth.get_current_user)):
    history = [{"role": m["role"], "content": m["content"]} for m in payload.get("messages") or []
               if m.get("role") in ("user", "assistant") and isinstance(m.get("content"), str) and m["content"].strip()][-12:]
    if not history or history[-1]["role"] != "user":
        raise HTTPException(400, "messages must end with the user's question")
    context = str(payload.get("context") or "")[:200]
    left = take_quota(user)
    return StreamingResponse(_chat_stream(user, history, payload.get("image"), context, left), media_type="application/x-ndjson")


@router.get("/api/ai/quota")
def ai_quota(user=Depends(auth.get_current_user)):
    return {"left": None if user["is_admin"] else DAILY_LIMIT - _count(user, 0), "limit": DAILY_LIMIT}


# Landing page (public/landing.html) product chatbot. No login, so: no tools,
# the cheapest model, a tiny prompt, short answers, per-IP + global daily caps.
PRODUCT_SYSTEM = """You are the help assistant on the TradeSmart AI website. Answer ONLY questions about TradeSmart AI.
Reply in plain text, at most 3 short sentences (about 60 words). No markdown. Never give market predictions or trade advice.
If a question is not about TradeSmart AI, say in one line that you can only help with TradeSmart AI.

Facts:
- TradeSmart AI is a trading dashboard for Indian index options (NIFTY, BANKNIFTY, SENSEX) crypto (BTC, ETH) and gold (XAUT).
- India auto-strategy: a bot that enters options trades by its rules, through the user's own AngelOne account.
- Auto-exit: closes positions at target or stoploss, and squares off at 15:10 IST (end of day).
- Crypto: BTC/ETH futures and options, and gold (XAUT) futures only, through the user's own Delta Exchange account. Each coin can have its own target and stoploss.
- AI Chat: explains levels, news and charts using live candles. It does not place orders.
- Charts with multi-screen saved layouts, order book, failed-orders list, notifications.
- Paper mode: simulated trades on live prices. Live mode: real orders in the user's own broker account. TradeSmart AI never holds user funds.
- Getting started: click Create account on the website and pick a username and password. After an admin approves it, sign in and start in paper mode. For live trading, add your own AngelOne or Delta Exchange API keys in the dashboard's Broker Account tab.
- Pricing is pay-per-use from a prepaid wallet, no monthly plan. Top-ups: Rs 50, 200, 500 (+25 bonus), 1000 (+100 bonus).
- Prices: charts, order book, notifications and manual orders are free. Auto order Rs 1 paper / Rs 5 live. Auto exit Rs 1 paper / Rs 3 live. AI Chat Rs 2 per message.
- At Rs 0 balance, new auto orders pause but open positions keep their auto-exit.
- Credits are not withdrawable, only usable on TradeSmart AI. The fee is a platform usage fee; broker charges are separate.
- Trading F&O is risky; TradeSmart AI is a software tool, not investment advice."""
PUBLIC_IP_LIMIT = 10  # questions per visitor IP per IST day
PUBLIC_TOTAL_LIMIT = 300  # all visitors per IST day: caps Claude usage from the open internet
PUBLIC_MAX_ANSWER = 600  # chars; the prompt asks for ~60 words, this is the backstop
# Own slot, so a slow dashboard question (web search, up to 4 min) never blocks website visitors.
# ponytail: 1 process (~250MB) = ~20 answers/min; move to the Claude API before raising it.
_public_slots = threading.Semaphore(1)


@router.post("/api/public/product-chat")
def product_chat(request: Request, payload: dict = Body(...)):
    history = [{"role": m["role"], "content": m["content"].strip()[:300]} for m in payload.get("messages") or []
               if isinstance(m, dict) and m.get("role") in ("user", "assistant")
               and isinstance(m.get("content"), str) and m["content"].strip()][-4:]
    if not history or history[-1]["role"] != "user":
        raise HTTPException(400, "messages must end with the user's question")
    ip = request.headers.get("cf-connecting-ip") or (request.client.host if request.client else "unknown")
    keys = [{"username": f"ip:{ip}"}, {"username": "public:total"}]
    for key, limit in zip(keys, (PUBLIC_IP_LIMIT, PUBLIC_TOTAL_LIMIT)):
        if _count(key, 1) > limit:
            for k in keys[:keys.index(key) + 1]:
                _count(k, -1)
            raise HTTPException(429, "The assistant has answered its limit for today. Please try again tomorrow.")
    prompt = "\n".join(f"{m['role'].upper()}: {m['content']}" for m in history)
    text, errors = [], []
    for kind, value in claude_code([{"type": "text", "text": prompt}], PRODUCT_SYSTEM, "haiku", tools="", slots=_public_slots):
        if kind == "text":
            text.append(value)
        elif kind == "error":
            errors.append(value)
    answer = "".join(text).strip()
    if errors or not answer:
        for k in keys:
            _count(k, -1)
        raise HTTPException(502, "The assistant is unavailable right now. Please try again.")
    return {"answer": answer[:PUBLIC_MAX_ANSWER]}


# Market Analysis "AI investment planner": the user gives an amount, market and risk level; the AI
# builds trades from the latest market_scan.json (same data as the tab). The AI picks the trades,
# levels, capital split and win probability; quantities and ₹ outcomes are computed here, never
# trusted from the AI, and total max loss is capped at the risk level. Counts as one AI question.
SCAN_FILE = os.path.join(os.environ.get("ANALYSIS_DIR", os.path.expanduser("~/tradingview-analysis")), "market_scan.json")
INVEST_MARKETS = {"ANY": "any market", "INDIA_STOCKS": "India intraday stocks only", "INDIA_OPTIONS": "India index options only", "CRYPTO": "crypto only"}
RISK_CAP = {"LOW": 1.0, "MEDIUM": 2.0, "HIGH": 3.0}  # max total loss, % of the amount
INVEST_SYSTEM = """You build an intraday trading plan for ONE user's capital from a market snapshot (JSON, given below the request).
Use only the snapshot's prices, levels, news and the analyst's playbook; never invent prices. India hours 09:15-15:30 IST,
no new entries after 15:00, square off 15:10. Crypto prices are in USD; capital is in INR.
Fill the answer schema; field meanings:
{"summary": "2-3 lines: market condition now and the approach", "trades": [{"market": "INDIA_STOCK|INDIA_OPTION|CRYPTO",
"symbol": "exactly as in the snapshot (stock symbol, NIFTY/BANKNIFTY/SENSEX, BTC/ETH/XAUT)", "side": "BUY|SELL",
"instrument": "what to trade, e.g. 'RELIANCE intraday' or 'NIFTY 25300 CE nearest weekly' or 'BTC futures'",
"strategy": "playbook name or setup", "capital": rupees_for_this_trade, "entry": price, "stoploss": price, "target": price,
"option_sl_pct": null_or_percent_of_premium, "option_target_pct": null_or_percent_of_premium,
"win_probability": 0-100, "why": "one line"}], "cash_reserve_reason": "one line", "avoid": ["..."]}
Rules: entry/stoploss/target are prices of the UNDERLYING (for options too: the index level that triggers / invalidates);
BUY needs stoploss < entry < target, SELL the reverse; reward:risk at least 1.5. For INDIA_OPTION always buy CE (bullish)
or PE (bearish) with side BUY/SELL meaning bullish/bearish, and give option_sl_pct / option_target_pct (premium moves ~0.5x
the index, so e.g. 30 / 50). 1-4 trades, total capital <= amount, keep 20%+ in reserve when risk is HIGH in the snapshot.
win_probability is your honest estimate from the setup quality and conditions (rarely above 65). If there is no edge,
return "trades": [] and say why. Never promise profit."""


_num_or_null = {"type": ["number", "null"]}
INVEST_SCHEMA = {"type": "object", "required": ["summary", "trades", "cash_reserve_reason", "avoid"], "properties": {
    "summary": {"type": "string"}, "cash_reserve_reason": {"type": "string"}, "avoid": {"type": "array", "items": {"type": "string"}},
    "trades": {"type": "array", "maxItems": 4, "items": {"type": "object", "required": [
        "market", "symbol", "side", "instrument", "strategy", "capital", "entry", "stoploss", "target",
        "option_sl_pct", "option_target_pct", "win_probability", "why"], "properties": {
        "market": {"enum": ["INDIA_STOCK", "INDIA_OPTION", "CRYPTO"]}, "symbol": {"type": "string"}, "side": {"enum": ["BUY", "SELL"]},
        "instrument": {"type": "string"}, "strategy": {"type": "string"}, "capital": {"type": "number"},
        "entry": {"type": "number"}, "stoploss": {"type": "number"}, "target": {"type": "number"},
        "option_sl_pct": _num_or_null, "option_target_pct": _num_or_null, "win_probability": {"type": "number"}, "why": {"type": "string"}}}}}}


def _num(v):
    return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) and v > 0 else None


def invest_numbers(plan, amount, risk, usdinr):
    """Check the AI's trades and compute quantity, max loss, max profit and expected value in ₹.
    Drops trades with wrong-way levels; scales capital down so total max loss <= RISK_CAP[risk] % of amount."""
    trades, dropped = [], []
    for t in plan.get("trades") or []:
        if not isinstance(t, dict):
            continue
        e, sl, tg, cap = (_num(t.get(k)) for k in ("entry", "stoploss", "target", "capital"))
        side, mkt = t.get("side"), t.get("market")
        ok = None not in (e, sl, tg, cap) and ((side == "BUY" and sl < e < tg) or (side == "SELL" and tg < e < sl))
        if mkt == "INDIA_OPTION":
            ok = ok and _num(t.get("option_sl_pct")) and _num(t.get("option_target_pct")) and t["option_sl_pct"] < 100
        if mkt not in ("INDIA_STOCK", "INDIA_OPTION", "CRYPTO") or not ok:
            dropped.append(f"{t.get('symbol')}: levels didn't check out (entry {t.get('entry')}, SL {t.get('stoploss')}, target {t.get('target')})")
            continue
        trades.append({**t, "capital": cap, "win_probability": max(0, min(95, _num(t.get("win_probability")) or 0))})
    scale = 1.0
    if sum(t["capital"] for t in trades) > amount:  # AI over-allocated
        scale = amount / sum(t["capital"] for t in trades)

    def compute(t, cap):
        e, sl, tg = t["entry"], t["stoploss"], t["target"]
        if t["market"] == "INDIA_OPTION":  # premium budget: lots are bought at the live premium
            return {"capital": round(cap), "qty": None, "max_loss": cap * t["option_sl_pct"] / 100, "max_profit": cap * t["option_target_pct"] / 100}
        if t["market"] == "CRYPTO":
            qty = round(cap / (e * usdinr), 6)
            fx = usdinr
        else:
            qty = int(cap // e)  # no leverage assumed
            fx = 1
        return {"capital": round(qty * e * fx), "qty": qty, "max_loss": qty * abs(e - sl) * fx, "max_profit": qty * abs(tg - e) * fx}

    for _ in range(2):  # second pass only if the risk cap needs it
        rows = [{**t, **compute(t, t["capital"] * scale)} for t in trades]
        loss = sum(r["max_loss"] for r in rows)
        cap_loss = amount * RISK_CAP[risk] / 100
        if loss <= cap_loss or not loss:
            break
        scale *= cap_loss / loss
    out = []
    for r in rows:
        if r["qty"] == 0:
            dropped.append(f"{r['symbol']}: one share costs more than its share of the capital")
            continue
        p = r["win_probability"] / 100
        out.append({**r, "max_loss": round(r["max_loss"]), "max_profit": round(r["max_profit"]),
                    "expected": round(p * r["max_profit"] - (1 - p) * r["max_loss"])})
    used = sum(r["capital"] for r in out)
    return {"trades": out, "dropped": dropped, "amount": amount, "risk": risk, "risk_cap_pct": RISK_CAP[risk],
            "used": used, "reserve": round(amount - used), "max_loss": sum(r["max_loss"] for r in out),
            "max_profit": sum(r["max_profit"] for r in out), "expected": sum(r["expected"] for r in out), "usdinr": usdinr}


PLANS_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "invest_plans.json")
PLANS_PER_DAY = 10  # kept per user for today; older days are dropped
_plans_lock = threading.Lock()


def _save_plan(user, plan):
    """Keep the user's plans for today (IST), newest first, so they survive refresh / tab switch."""
    today = f"{datetime.datetime.now(IST):%Y-%m-%d}"
    with _plans_lock:
        try:
            with open(PLANS_FILE) as f:
                data = json.load(f)
        except (OSError, ValueError):
            data = {}
        data = {u: v for u, v in data.items() if v.get("date") == today}
        mine = data.setdefault(user["username"], {"date": today, "plans": []})
        mine["plans"] = [plan, *mine["plans"]][:PLANS_PER_DAY]
        tmp = f"{PLANS_FILE}.{os.getpid()}.tmp"
        with open(tmp, "w") as f:
            json.dump(data, f)
        os.replace(tmp, PLANS_FILE)


def _invest_stream(user, amount, market, risk, left):
    line = lambda kind, value: json.dumps({"t": kind, "v": value}) + "\n"
    failed = False
    try:
        with open(SCAN_FILE) as f:
            scan = json.load(f)
        ai = scan.get("ai") or {}
        snap = {"ts": scan.get("ts"), "india_open": scan.get("india_open"), "indices": scan.get("indices"),
                "global": scan.get("global"), "stocks": scan.get("stocks"), "crypto": scan.get("crypto"),
                "news": [{k: n.get(k) for k in ("title", "impact", "affects", "ts")} for n in (scan.get("news") or [])[:10]],
                "analyst": {k: ai.get(k) for k in ("mood", "risk", "when_to_trade", "playbook", "markets", "stocks", "avoid")}}
        usdinr = _num(((scan.get("global") or {}).get("USD/INR") or {}).get("price")) or 88.0
        prompt = (f"Request: amount ₹{amount:,.0f}, market: {INVEST_MARKETS[market]}, user's risk level: {risk} "
                  f"(total max loss must stay under {RISK_CAP[risk]}% = ₹{amount * RISK_CAP[risk] / 100:,.0f}). "
                  f"Now: {datetime.datetime.now(IST):%A %Y-%m-%d %H:%M} IST. USD/INR {usdinr}.\n\nSnapshot:\n{json.dumps(snap)}")
        yield line("status", f"AI is reading the market snapshot from {scan.get('ts')}…")
        plan, last = None, 0.0
        for kind, value in claude_code([{"type": "text", "text": prompt}], INVEST_SYSTEM, "haiku", tools="", schema=INVEST_SCHEMA):
            if kind == "json":
                plan = value
            elif kind == "error":
                failed = True
                yield line("error", value)
            elif time.time() - last > 3:  # throttled status: keeps the connection alive through the tunnel
                last = time.time()
                yield line("status", "AI is building your plan…")
        if not failed and plan is not None:
            res = invest_numbers(plan, amount, risk, usdinr)
            res = {**res, "market": market, "summary": str(plan.get("summary") or ""),
                   "cash_reserve_reason": str(plan.get("cash_reserve_reason") or ""),
                   "avoid": [str(a) for a in plan.get("avoid") or []][:6], "data_ts": scan.get("ts"),
                   "built_at": f"{datetime.datetime.now(IST):%H:%M}"}
            _save_plan(user, res)
            yield line("plan", res)
    except Exception as e:
        traceback.print_exc()
        failed = True
        yield line("error", f"Plan failed: {e}")
    if failed:
        refund_quota(user)
        if left is not None:
            yield line("quota", {"left": left + 1, "limit": DAILY_LIMIT})
    yield line("done", None)


@router.get("/api/ai/invest-plan")
def invest_plans_today(user=Depends(auth.get_current_user)):
    try:
        with open(PLANS_FILE) as f:
            mine = json.load(f).get(user["username"]) or {}
    except (OSError, ValueError):
        mine = {}
    today = f"{datetime.datetime.now(IST):%Y-%m-%d}"
    return {"plans": mine.get("plans", []) if mine.get("date") == today else []}


@router.post("/api/ai/invest-plan")
def invest_plan(payload: dict = Body(...), user=Depends(auth.get_current_user)):
    amount, market, risk = _num(payload.get("amount")), payload.get("market", "ANY"), payload.get("risk", "MEDIUM")
    if not amount or not 1000 <= amount <= 1e8 or market not in INVEST_MARKETS or risk not in RISK_CAP:
        raise HTTPException(400, "amount must be ₹1,000 – ₹10 crore; market and risk from the list")
    if not os.path.exists(SCAN_FILE):
        raise HTTPException(503, "No market analysis yet — wait for the first scan.")
    left = take_quota(user)
    return StreamingResponse(_invest_stream(user, amount, market, risk, left), media_type="application/x-ndjson")
