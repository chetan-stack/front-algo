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
import traceback

import requests
from fastapi import APIRouter, Body, Depends, HTTPException
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


def claude_code(content, system, model=None):
    """Run one headless Claude Code turn. Yields ("text", delta), ("status", msg), ("error", msg)."""
    if not _slots.acquire(timeout=60):
        yield "error", "AI is busy with other questions — try again in a minute."
        return
    proc = None
    errlog = tempfile.TemporaryFile(mode="w+")  # a full stderr pipe would stall claude
    try:
        proc = subprocess.Popen(
            [CLAUDE, "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
             "--include-partial-messages", "--tools", "WebSearch,WebFetch", "--allowedTools", "WebSearch,WebFetch",
             "--setting-sources", "", "--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence",
             "--system-prompt", system, *(["--model", model] if model else [])],
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
    except FileNotFoundError:
        yield "error", f"Claude Code CLI not found at {CLAUDE}."
    finally:
        if proc and proc.poll() is None:  # browser left / timeout: don't leave it running
            proc.kill()
        errlog.close()
        _slots.release()


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
