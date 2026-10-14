#!/usr/bin/env python3
"""Market Analysis screen data (all users): one read-only process for every market.

Every 5 min: NIFTY / BANKNIFTY / SENSEX (trend, day high/low, support/resistance, ATR), India VIX, top moving F&O stocks, forex + global cues,
crypto (BTC/ETH/XAUT + top Binance movers) and market news with an impact tag.
Every 15 min in India hours (30 min otherwise), or when an admin presses "Ask Claude now",
the local Claude Code CLI (`claude -p`, your own login, no API key, no tools) reads all of it,
checks the numbers against each other and BUILDS the strategies itself (no coded strategy rules):
a prebuilt playbook for today's conditions, then mood, when to trade, strategy per market with
entry / stoploss / target, stocks, news impact, what to avoid.

Writes ~/tradingview-analysis/market_scan.json (served by /api/market-scan). Never trades,
never calls AngelOne (no rate-limit impact on the bots).

    python3 market_scan.py            # run forever
    python3 market_scan.py --once     # one cycle (with Claude), print the JSON
    python3 market_scan.py --selftest
"""
import html
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta
from email.utils import parsedate_to_datetime

import analyst  # reuse its fetchers / trend / levels logic (also sets SSL_CERT_FILE)
from analyst import IST, OUT, analyze, explain, fetch, fetch_crypto, fetch_yahoo, get_levels, outlook, _reason

FILE = OUT / "market_scan.json"
ASK = OUT / "market_scan.ask"   # touched by the backend's "Ask Claude now"
EVERY = 300
AI_EVERY_INDIA, AI_EVERY_OTHER = 900, 1800
AI_MODEL = os.environ.get("MARKET_SCAN_MODEL", "haiku")
AI_TIMEOUT = 180
CLAUDE = shutil.which("claude") or "/usr/local/bin/claude"

INDICES = {"NIFTY": "^NSEI", "BANKNIFTY": "^NSEBANK", "SENSEX": "^BSESN"}
# ponytail: fixed list of liquid / volatile F&O names; swap for the full F&O list if movers get missed
STOCKS = ("RELIANCE HDFCBANK ICICIBANK SBIN AXISBANK KOTAKBANK INDUSINDBK BANKBARODA PNB INFY TCS HCLTECH WIPRO "
          "TECHM LT ITC BHARTIARTL HINDUNILVR BAJFINANCE BAJAJFINSV MARUTI TMPV M&M EICHERMOT HEROMOTOCO SUNPHARMA "
          "CIPLA DRREDDY TITAN ADANIENT ADANIPORTS ONGC NTPC POWERGRID COALINDIA TATASTEEL JSWSTEEL HINDALCO VEDL "
          "SAIL BEL HAL BHEL IRFC RVNL DLF TRENT ZOMATO PAYTM DIXON POLYCAB").split()
GLOBAL = {"India VIX": "^INDIAVIX", "USD/INR": "USDINR=X", "EUR/USD": "EURUSD=X", "GBP/USD": "GBPUSD=X",
          "USD/JPY": "JPY=X", "Dollar index": "DX-Y.NYB", "S&P 500 fut": "ES=F", "Nasdaq fut": "NQ=F",
          "Crude oil": "CL=F", "Gold": "GC=F"}
STABLES = {"USDC", "FDUSD", "USD1", "RLUSD", "TUSD", "USDP", "DAI", "EUR", "USDE", "PYUSD", "XUSD", "BFUSD"}
CRYPTO = {"BTC": "BTCUSDT", "ETH": "ETHUSDT", "XAUT": "XAUTUSD"}
FEEDS = {"ET Markets": "https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms",
         "Moneycontrol": "https://www.moneycontrol.com/rss/marketreports.xml",
         "CoinDesk": "https://www.coindesk.com/arc/outboundfeeds/rss/"}
HIGH_WORDS = r"\b(rbi|repo|fed|fomc|powell|cpi|inflation|gdp|war|attack|tariff|budget|crash|rate (cut|hike)|sanction|default|ban)\b"
MED_WORDS = r"\b(results?|earnings|q[1-4]|profit|loss|upgrade|downgrade|fii|dii|crude|rupee|etf|sec|merger|stake|ipo|block deal)\b"


def get_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    return json.load(urllib.request.urlopen(req, timeout=15))


def spark(symbols):
    """Yahoo batch quotes, 10 per call: {sym: price, chg_pct, high, low} (high/low from 1-min closes)."""
    out = {}
    for i in range(0, len(symbols), 10):
        q = urllib.parse.quote(",".join(symbols[i:i + 10]), safe=",")
        for sym, r in get_json(f"https://query1.finance.yahoo.com/v8/finance/spark?symbols={q}&range=1d&interval=1m").items():
            c = [x for x in r.get("close") or [] if x is not None]
            prev = r.get("chartPreviousClose") or r.get("previousClose")
            if c and prev:
                out[sym] = {"price": round(c[-1], 4), "chg_pct": round((c[-1] / prev - 1) * 100, 2),
                            "high": round(max(c), 4), "low": round(min(c), 4)}
        time.sleep(0.4)  # pace Yahoo like analyst.get_levels does
    return out


def index_rows():
    rows = {}
    mk = analyst.MARKETS["india"]
    for name, sym in INDICES.items():
        try:
            bars = fetch(fetch_yahoo, sym, "1m")
            today = datetime.fromtimestamp(bars[-1][0], IST).date()
            day = [b for b in bars if datetime.fromtimestamp(b[0], IST).date() == today]
            a = analyze(bars)
            try:
                levels, atrs = get_levels(mk, name)
                ol = outlook(a, levels, atrs)
            except Exception:
                ol = {"label": None, "text": "", "S": None, "R": None}
            rows[name] = {"price": round(a["price"], 2), "chg_pct": round(a["open_chg_pct"], 2),
                          "high": round(max(b[2] for b in day), 2), "low": round(min(b[3] for b in day), 2), "state": a["state"],
                          "label": ol["label"], "outlook": ol["text"], "why": explain(a, ol),
                          "support": round(ol["S"]["price"], 2) if ol.get("S") else None,
                          "resistance": round(ol["R"]["price"], 2) if ol.get("R") else None,
                          "delayed_min": round(a["age_min"]), "atr_1m": round(a["atr"], 2), "efficiency": round(a["er"], 2)}
        except Exception as e:
            rows[name] = {"error": _reason(e)}
    return rows


def movers(quotes):
    rows = sorted(({"symbol": sym.replace(".NS", ""), **q} for sym, q in quotes.items()), key=lambda r: r["chg_pct"])
    return {"gainers": rows[::-1][:6], "losers": rows[:6]}


def crypto_rows():
    rows = {}
    for name, sym in CRYPTO.items():
        try:
            bars = fetch(fetch_crypto, sym, "1m")
            a = analyze(bars)
            day = fetch(fetch_crypto, sym, "1h")[-24:]  # 1m history is only 200 bars: 24h stats from hourly
            rows[name] = {"price": round(a["price"], 2), "state": a["state"], "why": explain(a, {"label": None, "text": ""}),
                          "high": round(max(b[2] for b in day), 2), "low": round(min(b[3] for b in day), 2),
                          "chg_pct": round((a["price"] / day[0][1] - 1) * 100, 2)}  # 24h
        except Exception as e:
            rows[name] = {"error": _reason(e)}
    movers_ = []
    try:
        t = [x for x in get_json("https://api.binance.com/api/v3/ticker/24hr")
             if x["symbol"].endswith("USDT") and x["symbol"][:-4] not in STABLES and float(x["quoteVolume"]) > 50e6]
        t.sort(key=lambda x: float(x["priceChangePercent"]))
        pick = t[-5:][::-1] + [x for x in t[:5] if x not in t[-5:]]  # top gainers + losers, no repeats
        movers_ = [{"symbol": x["symbol"], "price": float(x["lastPrice"]), "chg_pct": round(float(x["priceChangePercent"]), 2),
                    "high": float(x["highPrice"]), "low": float(x["lowPrice"])} for x in pick]
    except Exception:
        pass
    return rows, movers_


def news():
    items, cutoff = [], datetime.now(IST) - timedelta(hours=8)
    names = [s for s in STOCKS] + list(INDICES) + ["BITCOIN", "BTC", "ETH", "ETHER", "GOLD"]
    for src, url in FEEDS.items():
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            root = ET.fromstring(urllib.request.urlopen(req, timeout=15).read())
        except Exception:
            continue
        for it in root.iter("item"):
            title = html.unescape(it.findtext("title") or "").strip()
            try:
                ts = parsedate_to_datetime(it.findtext("pubDate")).astimezone(IST)
            except Exception:
                continue
            if not title or ts < cutoff:
                continue
            low = title.lower()
            impact = "HIGH" if re.search(HIGH_WORDS, low) else "MEDIUM" if re.search(MED_WORDS, low) else "LOW"
            affects = sorted({n for n in names if re.search(rf"\b{re.escape(n.lower())}\b", low)})
            items.append({"ts": f"{ts:%Y-%m-%d %H:%M}", "source": src, "title": title, "link": it.findtext("link"),
                          "impact": impact, "affects": affects})
    items.sort(key=lambda x: x["ts"], reverse=True)                          # newest first,
    items.sort(key=lambda x: {"HIGH": 0, "MEDIUM": 1, "LOW": 2}[x["impact"]])  # then by impact (stable)
    return items[:25]


AI_SCHEMA = {
    "type": "object",
    "properties": {
        "mood": {"type": "string"},
        "risk": {"enum": ["LOW", "MEDIUM", "HIGH"]},
        "when_to_trade": {"type": "string"},
        "playbook": {"type": "array", "items": {"type": "object", "properties": {
            "name": {"type": "string"}, "markets": {"type": "string"}, "condition": {"type": "string"},
            "entry_rule": {"type": "string"}, "stoploss_rule": {"type": "string"}, "target_rule": {"type": "string"},
            "avoid_when": {"type": "string"}},
            "required": ["name", "markets", "condition", "entry_rule", "stoploss_rule", "target_rule", "avoid_when"]}},
        "markets": {"type": "array", "items": {"type": "object", "properties": {
            "name": {"type": "string"}, "bias": {"enum": ["BULLISH", "BEARISH", "SIDEWAYS", "AVOID"]},
            "strategy": {"type": "string"}, "entry": {"type": "string"}, "stoploss": {"type": "string"},
            "target": {"type": "string"}, "why": {"type": "string"}},
            "required": ["name", "bias", "strategy", "entry", "stoploss", "target", "why"]}},
        "stocks": {"type": "array", "items": {"type": "object", "properties": {
            "symbol": {"type": "string"}, "side": {"enum": ["BUY", "SELL", "AVOID"]}, "strategy": {"type": "string"},
            "entry": {"type": ["number", "null"]}, "stoploss": {"type": ["number", "null"]},
            "target": {"type": ["number", "null"]}, "why": {"type": "string"}},
            "required": ["symbol", "side", "strategy", "entry", "stoploss", "target", "why"]}},
        "news_impact": {"type": "array", "items": {"type": "object", "properties": {
            "headline": {"type": "string"}, "impact": {"enum": ["HIGH", "MEDIUM", "LOW"]}, "affects": {"type": "string"}},
            "required": ["headline", "impact", "affects"]}},
        "avoid": {"type": "array", "items": {"type": "string"}},
        "data_checks": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["mood", "risk", "when_to_trade", "playbook", "markets", "stocks", "news_impact", "avoid", "data_checks"],
}

AI_PROMPT = """You are the market analyst for an Indian intraday options + crypto trading dashboard.
Stdin is a JSON snapshot taken at {now} IST: NIFTY/BANKNIFTY/SENSEX (trend state, efficiency ratio, 1-min ATR,
day high/low, support, resistance), India VIX, forex and global cues, top moving F&O stocks, crypto
(BTC/ETH/XAUT + top movers) and recent news headlines. There are NO coded strategy rules: you build the
strategies yourself from this data.
India market hours are 09:15-15:30 IST, new entries stop at 15:00, positions square off at 15:10.

Do this:
1. data_checks: verify the numbers agree (e.g. index up but VIX spiking, stale/delayed data, news older
   than today, missing data). Say plainly what can't be trusted.
2. playbook: build 3-6 named strategies that fit TODAY's conditions (trend/range, VIX, news, time of
   day, expiry), each with the condition it is for, exact entry / stoploss / target rules and when to
   avoid it. These are the prebuilt strategies users follow, so make the rules mechanical and testable.
3. For EACH of NIFTY, BANKNIFTY, SENSEX, BTC, ETH, XAUT and one line for forex (USD/INR): bias, which
   playbook strategy to use now (by name, or AVOID), and concrete entry, stoploss and target prices from
   the given levels and ATR (index options: ATM premium moves ~0.5x the index).
4. when_to_trade: the time windows / triggers to trade today and when to sit out.
5. stocks: one row for EVERY top gainer and top loser (symbol exactly as given): side BUY / SELL / AVOID,
   the strategy (playbook name or a stock-specific setup), and entry, stoploss and target as plain PRICES
   in the stock's own price (numbers, drawn on its chart). Risk:reward at least 1:1.5, stoploss beyond the
   day high/low or a clear level. AVOID rows: entry/stoploss/target null.
6. news_impact: only headlines that can move these markets today.
7. avoid: things not to do right now.
Be specific and short. Never promise profit; if there is no edge, say AVOID."""


def check_levels(stocks):
    """AI prices go on users' charts: a BUY needs stoploss < entry < target, a SELL the reverse,
    else the row becomes AVOID (never draw a wrong-way plan)."""
    for r in stocks:
        e, sl, t = r.get("entry"), r.get("stoploss"), r.get("target")
        ok = None not in (e, sl, t) and ((r["side"] == "BUY" and sl < e < t) or (r["side"] == "SELL" and t < e < sl))
        if r["side"] != "AVOID" and not ok:
            r.update(side="AVOID", why=f"levels didn't check out (entry {e}, SL {sl}, target {t}) - {r.get('why', '')}")
        if r["side"] == "AVOID":
            r.update(entry=None, stoploss=None, target=None)
    return stocks


def ask_claude(snapshot):
    t0 = time.time()
    try:
        p = subprocess.run(
            [CLAUDE, "-p", AI_PROMPT.format(now=snapshot["ts"]), "--model", AI_MODEL, "--tools", "",
             "--no-session-persistence", "--output-format", "json", "--json-schema", json.dumps(AI_SCHEMA)],
            input=json.dumps(snapshot), capture_output=True, text=True, timeout=AI_TIMEOUT, cwd=str(OUT))
        out = json.loads(p.stdout or "{}")
        if out.get("is_error") or not out.get("structured_output"):
            raise RuntimeError(out.get("result") or p.stderr.strip()[:300] or f"exit {p.returncode}")
        res = out["structured_output"]
        check_levels(res.get("stocks") or [])
        return {**res, "ts": snapshot["ts"], "model": AI_MODEL, "secs": round(time.time() - t0)}
    except Exception as e:
        return {"error": f"{type(e).__name__}: {str(e)[:300]}", "ts": snapshot["ts"]}


def in_india_hours(now):
    return now.weekday() < 5 and (9, 0) <= (now.hour, now.minute) <= (15, 35)


def cycle(prev, with_ai):
    now = datetime.now(IST)
    OUT.mkdir(parents=True, exist_ok=True)  # also Claude's working folder
    snap = {"ts": f"{now:%Y-%m-%d %H:%M:%S}", "india_open": in_india_hours(now)}
    try:
        g = spark(list(GLOBAL.values()))
        snap["global"] = {n: g.get(s) for n, s in GLOBAL.items()}
    except Exception as e:
        snap["global"] = {"error": _reason(e)}
    snap["indices"] = index_rows()
    try:
        snap["stocks"] = movers(spark([s + ".NS" for s in STOCKS]))
    except Exception as e:
        snap["stocks"] = {"error": _reason(e), "gainers": [], "losers": []}
    snap["crypto"], snap["crypto_movers"] = crypto_rows()
    snap["news"] = news()
    snap["ai"] = ask_claude(snap) if with_ai else (prev or {}).get("ai")
    if with_ai and snap["ai"].get("error") and (prev or {}).get("ai", {}).get("mood"):
        snap["ai"] = {**prev["ai"], "error": snap["ai"]["error"]}  # keep the last good plan, show why it's old
    tmp = FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(snap))
    os.replace(tmp, FILE)
    return snap


def selftest():
    m = movers({"A.NS": {"price": 102, "chg_pct": 2.0, "high": 102.1, "low": 99},
                "B.NS": {"price": 95, "chg_pct": -3.0, "high": 99, "low": 94.9},
                "C.NS": {"price": 101, "chg_pct": 0.5, "high": 101.5, "low": 100}})
    assert [r["symbol"] for r in m["gainers"]] == ["A", "C", "B"] and m["losers"][0]["symbol"] == "B"
    assert re.search(HIGH_WORDS, "rbi keeps repo rate unchanged") and not re.search(HIGH_WORDS, "infosys q2 results")
    rows = check_levels([{"symbol": "A", "side": "BUY", "entry": 100, "stoploss": 98, "target": 104, "why": ""},
                         {"symbol": "B", "side": "BUY", "entry": 100, "stoploss": 102, "target": 104, "why": ""},
                         {"symbol": "C", "side": "SELL", "entry": 100, "stoploss": 103, "target": 95, "why": ""},
                         {"symbol": "D", "side": "SELL", "entry": None, "stoploss": 103, "target": 95, "why": ""}])
    assert [r["side"] for r in rows] == ["BUY", "AVOID", "SELL", "AVOID"] and rows[1]["entry"] is None
    print("selftest ok")


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        selftest()
    elif "--once" in sys.argv:
        print(json.dumps(cycle(None, True), indent=1))
    else:
        try:
            prev = json.loads(FILE.read_text())
        except (OSError, ValueError):
            prev = None
        last_ai = 0
        while True:
            t0, now = time.time(), datetime.now(IST)
            gap = AI_EVERY_INDIA if in_india_hours(now) else AI_EVERY_OTHER
            asked = ASK.exists()
            with_ai = asked or t0 - last_ai >= gap
            ASK.unlink(missing_ok=True)
            try:
                prev = cycle(prev, with_ai)
                if with_ai:
                    last_ai = t0
            except Exception as e:  # never die: one bad cycle must not stop the screen updating
                print(f"{now:%H:%M} cycle failed: {type(e).__name__}: {e}", flush=True)
            while time.time() - t0 < EVERY and not ASK.exists():  # wake early for "Ask Claude now"
                time.sleep(5)
