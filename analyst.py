#!/usr/bin/env python3
"""Read-only India + crypto market and auto-strategy analyst.

Every 3 minutes it reads the markets (India NIFTY/BANKNIFTY/SENSEX Mon-Fri 09:15-15:30 IST,
crypto BTC/ETH 24/7), finds strong support/resistance across 5m/15m/1h/1d, judges whether a
move is starting or coiling, checks every account's auto-strategy config and running
processes, and writes:
  - one report per market   (analysis_log.txt / crypto_analysis_log.txt, TODAY only)
  - an alert feed           (alerts.jsonl, kept 7 days) for: trending, near a move, trend coming
All in ~/tradingview-analysis/, shown to admins only in the app.

It NEVER starts, stops or edits anything. Recommendations only.

    python3 analyst.py --market india    # run forever, India only (sleeps outside Mon-Fri 09:15-15:30 IST)
    python3 analyst.py --market crypto   # run forever, crypto only (24/7)
    python3 analyst.py --once [--market india|crypto]   # one cycle, print to stdout too
    python3 analyst.py --selftest

India and crypto are two separate processes on purpose, so each can be started/stopped on its own.
"""
import contextlib
import fcntl
import json
import os
import re
import sqlite3
import subprocess
import sys
import time
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

IST = timezone(timedelta(hours=5, minutes=30))
HERE = Path(__file__).resolve().parent
SMARTAPI = Path.home() / "PycharmProjects/pythonProject/SmartApi"
# Outside the repo on purpose: Vite's dev server serves every file under its root,
# tunnel included, so files kept in here would be readable without logging in.
OUT = Path(os.environ.get("ANALYSIS_DIR", Path.home() / "tradingview-analysis"))
ALERTS = OUT / "alerts.jsonl"
ALERT_KEEP_DAYS = 7
ALERT_COOLDOWN = 900         # same alert kind for the same symbol at most once per 15 min (stops flapping)
EVERY = 180
STALE_MIN = 8
# timeframe -> (provider interval, provider range/limit)
YAHOO = {"1m": ("1m", "1d"), "5m": ("5m", "5d"), "15m": ("15m", "1mo"), "1h": ("60m", "3mo"), "1d": ("1d", "1y")}
BINANCE = {"1m": ("1m", 200), "5m": ("5m", 1000), "15m": ("15m", 1000), "1h": ("1h", 1000), "1d": ("1d", 365)}
# timeframe -> (weight of a swing on that chart, fractal half-width)
TFS = {"5m": (1, 5), "15m": (2, 5), "1h": (3, 4), "1d": (5, 3)}
LEVEL_REFRESH = 900          # higher-timeframe levels barely change: rebuild every 15 min, not every 3
TOL_PCT = 0.0012             # swings within 0.12% of each other are one level
_levels = {}                 # (market, symbol) -> (built_at, levels, atrs)
_alert_seen = {}             # (market, symbol, kind) -> last emitted time


# ---------- data ----------

def fetch_yahoo(symbol, tf="1m"):
    iv, rng = YAHOO[tf]
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?interval={iv}&range={rng}"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    r = json.load(urllib.request.urlopen(req, timeout=10))["chart"]["result"][0]
    q = r["indicators"]["quote"][0]
    return [(t, o, h, l, c) for t, o, h, l, c in zip(r["timestamp"], q["open"], q["high"], q["low"], q["close"])
            if None not in (o, h, l, c)]


def fetch_binance(symbol, tf="1m"):
    iv, n = BINANCE[tf]
    url = f"https://api.binance.com/api/v3/klines?symbol={symbol}&interval={iv}&limit={n}"
    return [(r[0] / 1000, float(r[1]), float(r[2]), float(r[3]), float(r[4])) for r in json.load(urllib.request.urlopen(url, timeout=10))]


def ema(vals, p):
    a, e, out = 2 / (p + 1), vals[0], []
    for v in vals:
        e = a * v + (1 - a) * e
        out.append(e)
    return out


def atr(bars, n=14):
    trs = [max(bars[i][2] - bars[i][3], abs(bars[i][2] - bars[i - 1][4]), abs(bars[i][3] - bars[i - 1][4]))
           for i in range(1, len(bars))]
    return sum(trs[-n:]) / n


def analyze(bars):
    """bars: [(ts, o, h, l, c)], 1-minute. Needs >= 35 bars."""
    c = [b[4] for b in bars]
    a1 = atr(bars)
    move3 = c[-1] - c[-4]
    # Kaufman efficiency ratio over 30 bars: net move / total path. ~0 = chop, ~1 = straight line.
    # ponytail: fixed thresholds (0.25 / 0.45) picked by eye, tune per market if it flaps.
    path = sum(abs(c[i] - c[i - 1]) for i in range(len(c) - 30, len(c)))
    er = abs(c[-1] - c[-31]) / path if path else 0
    e9, e20 = ema(c, 9), ema(c, 20)
    up = e9[-1] > e20[-1]
    crossed = any((e9[i] > e20[i]) != (e9[i - 1] > e20[i - 1]) for i in range(len(c) - 5, len(c)))
    if er < 0.25:
        state = "SIDEWAYS"
    elif er >= 0.45 and up == (c[-1] > c[-31]):
        state = "TRENDING_UP" if up else "TRENDING_DOWN"
    else:
        state = "MIXED"
    return {
        "price": c[-1], "move3": move3, "atr": a1, "er": er, "state": state, "ema_up": up,
        "open_chg_pct": (c[-1] / bars[0][1] - 1) * 100,
        "big_move": a1 > 0 and abs(move3) > 3 * a1,
        "building": ("UP" if up else "DOWN") if crossed and state != "SIDEWAYS" else None,
        "age_min": (time.time() - bars[-1][0]) / 60,
        "closes": c[-6:],
        "range30": max(b[2] for b in bars[-30:]) - min(b[3] for b in bars[-30:]),
    }


# ---------- support / resistance across timeframes ----------

def swings(bars, k):
    """Fractal swing highs and lows: a bar that is the extreme of the k bars on each side."""
    out = []
    for i in range(k, len(bars) - k):
        win = bars[i - k:i + k + 1]
        if bars[i][2] == max(b[2] for b in win):
            out.append(bars[i][2])
        if bars[i][3] == min(b[3] for b in win):
            out.append(bars[i][3])
    return out


def cluster(points):
    """points: [(price, tf, weight)] -> strong levels. Strong = weight >= 6 AND >= 2 timeframes agree."""
    clusters = []
    for p, tf, w in sorted(points):
        if clusters and p - clusters[-1]["lo"] <= p * TOL_PCT:  # anchored on the first point, so no chaining
            cl = clusters[-1]
            cl["pts"].append((p, w))
            cl["tfs"].add(tf)
            cl["score"] += w
        else:
            clusters.append({"lo": p, "pts": [(p, w)], "tfs": {tf}, "score": w})
    return [{"price": sum(p * w for p, w in cl["pts"]) / sum(w for _, w in cl["pts"]),
             "score": cl["score"], "tfs": sorted(cl["tfs"], key=list(TFS).index)}
            for cl in clusters if cl["score"] >= 6 and len(cl["tfs"]) >= 2]


def get_levels(mk, name):
    key = (mk["key"], name)
    built = _levels.get(key)
    if built and time.time() - built[0] < LEVEL_REFRESH:
        return built[1], built[2]
    pts, atrs = [], {}
    for tf, (w, k) in TFS.items():
        bars = mk["fetch"](mk["symbols"][name], tf)
        atrs[tf] = atr(bars)
        pts += [(p, tf, w) for p in swings(bars, k)]
    _levels[key] = (time.time(), cluster(pts), atrs)
    return _levels[key][1], atrs


def outlook(a, levels, atrs):
    """Is a move starting, about to, or is this just a range? -> dict with label/text/S/R."""
    p, a15 = a["price"], atrs["15m"]
    near = [lv for lv in levels if abs(lv["price"] - p) <= 0.03 * p]
    S = max((lv for lv in near if lv["price"] < p), key=lambda lv: lv["price"], default=None)
    R = min((lv for lv in near if lv["price"] > p), key=lambda lv: lv["price"], default=None)
    out = {"S": S, "R": R, "dS": (p - S["price"]) / a15 if S else None, "dR": (R["price"] - p) / a15 if R else None}
    if a["age_min"] > STALE_MIN:  # levels still shown, but a stale price can't call a live breakout
        return {**out, "label": "NO_SIGNAL", "text": f"feed delayed {a['age_min']:.0f}min - levels only, no live signal"}
    c0, c1, buf = a["closes"][0], a["closes"][-1], 0.15 * a15
    for lv in near:
        tag = f"strong level {lv['price']:,.0f} ({'+'.join(lv['tfs'])})"
        if c0 < lv["price"] and c1 > lv["price"] + buf:
            return {**out, "label": "BREAKOUT_UP", "text": f"closed above {tag}"}
        if c0 > lv["price"] and c1 < lv["price"] - buf:
            return {**out, "label": "BREAKDOWN", "text": f"closed below {tag}"}
    # ponytail: squeeze = sideways AND 30-min range < 1.5x a typical 5-min bar. By-eye threshold.
    squeeze = a["state"] == "SIDEWAYS" and a["range30"] < 1.5 * atrs["5m"]
    d = [(x, kind, lv) for x, kind, lv in ((out["dS"], "support", S), (out["dR"], "resistance", R)) if x is not None]
    nearest = min(d, key=lambda t: t[0]) if d else None
    if squeeze and nearest and nearest[0] <= 0.6:
        x, kind, lv = nearest
        return {**out, "label": "COILED", "text": f"tight range pressing strong {kind} {lv['price']:,.0f} ({'+'.join(lv['tfs'])}, {x:.1f} ATR away) - move likely, direction unconfirmed"}
    if a["state"] == "SIDEWAYS":
        return {**out, "label": "RANGE", "text": "sideways, no coil at a strong level"}
    if a["state"] == "TRENDING_UP" and R and out["dR"] < 1:
        return {**out, "label": "TREND_LIMITED", "text": f"trending up but only {out['dR']:.1f} ATR to strong resistance {R['price']:,.0f}"}
    if a["state"] == "TRENDING_DOWN" and S and out["dS"] < 1:
        return {**out, "label": "TREND_LIMITED", "text": f"trending down but only {out['dS']:.1f} ATR to strong support {S['price']:,.0f}"}
    return {**out, "label": "TREND" if a["state"].startswith("TREND") else "MIXED", "text": ""}


def level_line(ol):
    def fmt(lv):
        return f"{lv['price']:,.0f} [{'+'.join(lv['tfs'])}]" if lv else "none in range"
    return f"          R {fmt(ol['R'])} | S {fmt(ol['S'])} | {ol['label']}" + (f": {ol['text']}" if ol["text"] else "")


# ---------- accounts ----------

def running_dirs(mk):
    """{account_dir: {'entry','exit'}} from real processes (chetan has no reliable pid file)."""
    entry, exit_ = mk["scripts"]
    out = subprocess.run(["pgrep", "-f", f"{entry}|{exit_}"], capture_output=True, text=True).stdout.split()
    if not out:
        return {}
    pids = ",".join(out)
    cmds = subprocess.run(["ps", "-o", "pid=,command=", "-p", pids], capture_output=True, text=True).stdout.splitlines()
    script = {int(l.split()[0]): ("exit" if exit_ in l else "entry") for l in cmds if l.strip()}
    res, pid = {}, None
    for line in subprocess.run(["lsof", "-a", "-d", "cwd", "-Fpn", "-p", pids], capture_output=True, text=True).stdout.splitlines():
        if line[0] == "p":
            pid = int(line[1:])
        elif line[0] == "n" and pid in script:
            res.setdefault(line[1:], set()).add(script[pid])
    return res


def check_accounts(mk, idx):
    """Returns [(username, status_line, [recommendation, ...])]."""
    entry_py, exit_py = mk["scripts"]
    db = sqlite3.connect(HERE / "users.db")
    users = db.execute(mk["users_sql"]).fetchall()
    running = running_dirs(mk)
    rows, findings = [], []
    for user, is_admin in users:
        d = mk["dir"] if is_admin else mk["dir"] / "accounts" / user
        try:
            cfg = json.load(open(d / mk["cfg"]))
        except Exception as e:
            rows.append((user, "config unreadable", [f"ATTENTION: cannot read {mk['cfg']} ({e})"]))
            continue
        auto, have = bool(cfg.get("auto_place_order")), running.get(str(d), set())
        enabled = [n for n in mk["symbols"] if cfg.get(mk["flag"](n))]
        held = [o for o in cfg.get("storeorder") or [] if o.get("orderterm") == "hold"]
        pnl = sum(o.get("profit") or 0 for o in held)
        money = "REAL MONEY" if cfg.get("withmoney") else "paper"
        status = (f"auto {'ON' if auto else 'off'} ({money}) symbols={','.join(enabled) or '-'} | "
                  f"entry {'running' if 'entry' in have else 'NOT running'}, exit {'running' if 'exit' in have else 'NOT running'} | "
                  f"open {len(held)} (P&L {pnl:+,.0f})")
        recs = []
        for k in mk["required"]:
            if cfg.get(k) is None:
                recs.append(f"FIX: config '{k}' is null - this silently blocks or crashes entries")
        if auto and "entry" not in have:
            recs.append(f"ATTENTION: auto entry is ON but {entry_py} is not running - nothing will trade")
        if held and "exit" not in have:
            recs.append(f"ATTENTION: {len(held)} open position(s) but {exit_py} is not running - no auto-exit")
        labels = []
        for n in enabled:
            a = idx.get(n)
            ol = a and a.get("ol")
            if not ol:
                continue
            labels.append(ol["label"])
            lab = ol["label"]
            if lab in ("BREAKOUT_UP", "BREAKDOWN"):
                side = "call" if lab == "BREAKOUT_UP" else "put"
                recs.append(f"START: {n} {ol['text']} - " + (f"auto entry is ON, expect a {side} entry if the strategy confirms"
                                                               if auto else "auto entry is OFF; consider turning it ON"))
            elif lab == "COILED":
                recs.append(f"PREPARE: {n} {ol['text']} - " + ("keep auto ON, watch for a close beyond the level"
                                                               if auto else "turn auto ON only after a close beyond the level"))
            elif lab == "RANGE" and auto:
                recs.append(f"PAUSE: {n} is range-bound between strong levels - this strategy needs a trend; consider pausing auto entry for {n}")
            elif lab == "TREND_LIMITED":
                recs.append(f"WATCH: {n} {ol['text']} - little room for a new entry")
            if a["building"] and a["state"] != "SIDEWAYS":
                recs.append(f"{'WATCH' if auto else 'NOTE'}: {n} EMA9/20 cross {a['building']} (strategy building)"
                            + ("" if auto else " - auto entry is OFF, no entry would be taken"))
        if auto and enabled and labels and all(l == "RANGE" for l in labels):
            recs.append("REVIEW: every enabled symbol is range-bound - consider stopping auto strategy until a breakout")
        for f in check_orders(mk, idx, user, d, cfg, have, set(enabled), datetime.now(IST).date()):
            findings.append({**f, "user": user})
            recs.append(f"{f['kind'].replace('_', '-')}: {f['sym']} - {f['brief']}")
        rows.append((user, status, recs))
    return rows, findings


# ---------- open orders: wrong placement / exit needed / trail ----------

def option_expiry(sym):
    """Expiry date parsed from the contract symbol, or None if the format isn't recognised."""
    try:
        m = re.match(r"^(?:BANKNIFTY|NIFTY)(\d{2}[A-Z]{3}\d{2})\d{5}(?:CE|PE)$", sym)        # NIFTY22SEP2623300CE
        if m:
            return datetime.strptime(m.group(1), "%d%b%y").date()
        m = re.match(r"^SENSEX(\d{2})(\d)(\d{2})\d{5}(?:CE|PE)$", sym)                        # SENSEX2691774400CE = yy m dd
        if m:
            return datetime(2000 + int(m.group(1)), int(m.group(2)), int(m.group(3))).date()
        m = re.match(r"^[CP]-[A-Z]+-\d+-(\d{6})$", sym)                                        # P-BTC-80000-270826 = ddmmyy
        if m:
            return datetime.strptime(m.group(1), "%d%m%y").date()
    except ValueError:
        pass
    return None


def crypto_mark(sym):
    """Live mark price of a DeltaEx option (None once the contract is expired or on any error)."""
    try:
        r = json.load(urllib.request.urlopen(f"https://cdn.india.deltaex.org/v2/tickers/{sym}", timeout=8)).get("result")
        return float(r["mark_price"]) if r and "mark_price" in r else None
    except Exception:
        return None


def check_orders(mk, idx, user, d, cfg, have, enabled, today):
    """Every open position in one account -> [{sym, kind, reason, text, brief}].
    kind: ORDER_WRONG (should not have been placed / contradicts config or market),
          ORDER_EXIT (should be closed or is overdue), ORDER_TRAIL (in profit, tighten the stop / extend target).
    'brief' has no live numbers, so the accounts block only reprints when something real changes."""
    try:
        book = sqlite3.connect(d / "database.db")
        pos = book.execute(f"SELECT symbol, ltp, lotsize, createddate FROM {mk['book']} "
                           "WHERE lotsize > 0 AND (profit IS NULL OR profit = 0)").fetchall()
    except Exception:
        return []
    held = {o["symbol"]: o for o in cfg.get("storeorder") or [] if o.get("orderterm") == "hold"}
    out, seen, sides = [], {}, {}
    now = datetime.now(IST).replace(tzinfo=None)

    def add(sym, kind, reason, text, brief=None):
        out.append({"sym": sym, "kind": kind, "reason": reason, "text": text, "brief": brief or text})

    for sym, entry, qty, created in pos:
        n, call = mk["under"](sym), mk["is_call"](sym)
        a = idx.get(n)
        ol = (a or {}).get("ol") or {}
        seen[sym] = seen.get(sym, 0) + 1
        sides.setdefault(n, set()).add(call)
        created_s = str(created)[:10]
        exp = option_expiry(sym)
        if exp and exp < today:
            add(sym, "ORDER_EXIT", "expired", f"contract expired {exp:%d %b} but the position is still open in the order book (since {created_s}) - a stale record with no live price; close/clear it")
            continue
        if exp and (exp - today).days <= 1:
            add(sym, "ORDER_EXIT", "expiring", f"expires {exp:%d %b}: near-expiry options lose value fast - consider exiting")
        if mk["key"] == "india" and created_s < f"{today}":
            add(sym, "ORDER_EXIT", "overnight", f"open since {created_s} (before today) - this strategy trades intraday; consider exiting")
        if "exit" not in have:
            add(sym, "ORDER_EXIT", "noexit", f"no auto-exit process is running - nothing will close it at target or stop")
        # live P&L in option points: crypto from the exchange ticker; India only from the dashboard order while the exit bot keeps it fresh
        o = held.get(sym)
        pts = None
        if mk["key"] == "crypto":
            mark = crypto_mark(sym)
            pts = None if mark is None else mark - float(entry)
        elif o and "exit" in have:
            pts = (o.get("profit") or 0) / qty
        try:
            target = float((o or {}).get("targetpoint", cfg.get("target_points")))
            stop = float((o or {}).get("stoplosspoint", cfg.get("loss_points")))
        except (TypeError, ValueError):
            target = stop = 0
        against = a and ((call and a["state"] == "TRENDING_DOWN") or (not call and a["state"] == "TRENDING_UP"))
        if pts is not None and stop > 0 and target > 0:
            if pts <= -stop:
                add(sym, "ORDER_EXIT", "stop", f"at/below its stop ({pts:+.1f} pts vs -{stop:g}) but still open", "at/below its stop but still open")
            elif pts >= target:
                add(sym, "ORDER_EXIT", "target", f"reached its target ({pts:+.1f} pts vs +{target:g}) but still open", "reached its target but still open")
            elif pts >= 0.5 * target and not against:
                lv = ol.get("R") if call else ol.get("S")
                dist = ol.get("dR") if call else ol.get("dS")
                room = ""
                if lv and dist is not None:
                    kind = "resistance" if call else "support"
                    room = (f"; next strong {kind} {lv['price']:,.0f} is {dist:.1f} ATR away - room to extend the target there" if dist >= 1
                            else f"; strong {kind} {lv['price']:,.0f} is only {dist:.1f} ATR away - book profit near it")
                add(sym, "ORDER_TRAIL", "trail", f"{pts:+.1f} pts, {pts / target:.0%} of the way to its +{target:g} target: move the stop to entry (break-even) to lock it in{room}",
                    "in profit past half its target: move the stop to entry to lock it in")
        if against:
            add(sym, "ORDER_WRONG", "trend", f"{'call' if call else 'put'} held against a {a['state'].lower().replace('_', ' ')} {n}")
        lv, dist = (ol.get("R"), ol.get("dR")) if call else (ol.get("S"), ol.get("dS"))
        if lv and dist is not None and dist < 0.6:
            kind = "resistance" if call else "support"
            add(sym, "ORDER_EXIT", "level", f"{n} is {dist:.1f} ATR from strong {kind} {lv['price']:,.0f} - the position is running into it; book profit or tighten the stop",
                f"running into strong {kind} {lv['price']:,.0f}")
        try:
            age_min = (now - datetime.fromisoformat(str(created))).total_seconds() / 60
        except ValueError:
            age_min = 1e9
        if age_min <= 30 and ol.get("label") == "RANGE":
            add(sym, "ORDER_WRONG", "range", f"opened {age_min:.0f} min ago in a range-bound {n} (no trend) - this strategy needs one", "opened in a range-bound market (no trend)")
        if n and n not in enabled:
            add(sym, "ORDER_WRONG", "disabled", f"{n} is not enabled in this account's settings")
        side = cfg.get("buy_or_sell_side")
        if mk["key"] == "india" and cfg.get("check_all_level") and ((side == "CALL" and not call) or (side == "PUT" and call)):
            add(sym, "ORDER_WRONG", "side", f"account is set to {side} only, but this is a {'call' if call else 'put'}")
    for sym, k in seen.items():
        if k > 1:
            add(sym, "ORDER_WRONG", "duplicate", f"{k} open positions on the same contract")
    for n, s_ in sides.items():
        if len(s_) == 2:
            for sym, *_ in pos:
                if mk["under"](sym) == n:
                    add(sym, "ORDER_WRONG", "both", f"both a call and a put on {n} are open at once")
    return out


# ---------- alerts + logs ----------

def notify(msg):
    if os.environ.get("ANALYST_QUIET"):  # tests: no desktop popups
        return
    subprocess.run(["osascript", "-e", f'display notification "{msg[:180]}" with title "Market analyst"'], capture_output=True)


@contextlib.contextmanager
def alerts_lock():
    """The India and crypto processes share alerts.jsonl: serialise appends against the daily prune-rewrite."""
    OUT.mkdir(parents=True, exist_ok=True)
    with open(OUT / "alerts.lock", "w") as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        yield


def emit(mk, name, kind, text, lines, force=False):
    """One alert: appended to alerts.jsonl (the app's Alerts tab), the market report, and a desktop notification."""
    key = (mk["key"], name, kind)
    if not force and time.time() - _alert_seen.get(key, 0) < ALERT_COOLDOWN:
        return
    _alert_seen[key] = time.time()
    rec = {"ts": f"{datetime.now(IST):%Y-%m-%d %H:%M:%S}", "market": mk["key"], "symbol": name, "kind": kind, "text": text}
    with alerts_lock():
        with open(ALERTS, "a") as f:
            f.write(json.dumps(rec) + "\n")
    lines.append(f"ALERT [{kind}] {name}: {text}")
    notify(f"{mk['label']} {name}: {kind.replace('_', ' ').lower()} - {text}")


def prune_alerts(now):
    """Alerts are kept ALERT_KEEP_DAYS days so you can look back at them; older ones are deleted."""
    with alerts_lock():
        if not ALERTS.exists():
            return
        cutoff = f"{now - timedelta(days=ALERT_KEEP_DAYS):%Y-%m-%d %H:%M:%S}"
        rows = [l for l in ALERTS.read_text().splitlines() if l.strip()]
        kept = [l for l in rows if json.loads(l).get("ts", "") >= cutoff]
        if len(kept) != len(rows):
            tmp = ALERTS.with_suffix(".tmp")
            tmp.write_text("".join(l + "\n" for l in kept))
            os.replace(tmp, ALERTS)


def prune_log(path, today):
    """Keep only today's entries ("=== YYYY-MM-DD HH:MM IST ===" blocks); everything older is deleted."""
    if not path.exists():
        return
    blocks = [b for b in path.read_text().split("\n\n") if b.strip()]
    kept = [b for b in blocks if b.lstrip().startswith(f"=== {today} ")]
    if len(kept) != len(blocks):
        tmp = path.with_suffix(".tmp")
        tmp.write_text("".join(b + "\n\n" for b in kept))
        os.replace(tmp, path)


ACCOUNT_ALERT_WORDS = ("ATTENTION", "REVIEW", "FIX", "START", "PAUSE", "PREPARE")


def cycle(mk):
    now = datetime.now(IST)
    today, st = f"{now:%Y-%m-%d}", mk["st"]
    if st["day"] != today:  # new day: drop old entries, and re-print the full accounts block
        prune_log(mk["log"], today)  # (its "no change, see earlier entry" would point at a deleted entry)
        prune_alerts(now)
        st["acct"], st["day"] = None, today
    lines, idx = [f"=== {now:%Y-%m-%d %H:%M} IST ==="], {}
    for name, sym in mk["symbols"].items():
        try:
            bars = mk["fetch"](sym, "1m")
            if len(bars) < 35:
                lines.append(f"{name}: not enough candles yet ({len(bars)})")
                continue
            a = idx[name] = analyze(bars)
        except Exception as e:
            lines.append(f"{name}: data unavailable ({type(e).__name__})")
            continue
        tags = [a["state"]]
        if a["age_min"] > STALE_MIN:
            tags.append(f"DELAYED {a['age_min']:.0f}min")
        if a["big_move"]:
            tags.append(f"BIG MOVE {a['move3']:+.1f} in 3min")
        if a["building"]:
            tags.append(f"EMA9/20 cross {a['building']}")
        lines.append(f"{name:9} {a['price']:>10,.2f} | 3m {a['move3']:+7.1f} | day {a['open_chg_pct']:+.2f}% | "
                     f"ATR {a['atr']:.1f} | ER {a['er']:.2f} | {' | '.join(tags)}")
        ol = {"label": None, "text": "", "S": None, "R": None, "dS": None, "dR": None}
        try:
            levels, atrs = get_levels(mk, name)
            ol = a["ol"] = outlook(a, levels, atrs)
            lines.append(level_line(ol))
        except Exception as e:
            lines.append(f"          levels unavailable ({type(e).__name__})")
        # alerts fire on a CHANGE (e.g. sideways -> trending), never on every cycle; 15-min cooldown per kind
        last, cur = st["last"].get(name, {}), {"state": a["state"], "label": ol["label"], "building": a["building"]}
        if a["age_min"] <= STALE_MIN:
            if cur["state"] in ("TRENDING_UP", "TRENDING_DOWN") and cur["state"] != last.get("state"):
                up = cur["state"] == "TRENDING_UP"
                lv = ol["R"] if up else ol["S"]
                room = f"; next strong {'resistance' if up else 'support'} {lv['price']:,.0f} ({ol['dR' if up else 'dS']:.1f} ATR away)" if lv else ""
                emit(mk, name, "TRENDING", f"trending {'up' if up else 'down'} at {a['price']:,.2f} (ER {a['er']:.2f}){room}", lines)
            if cur["label"] == "COILED" and last.get("label") != "COILED":
                emit(mk, name, "NEAR_MOVE", ol["text"], lines)
            if cur["label"] in ("BREAKOUT_UP", "BREAKDOWN") and cur["label"] != last.get("label"):
                emit(mk, name, "TREND_COMING", ol["text"], lines)
            if cur["building"] and cur["building"] != last.get("building"):
                emit(mk, name, "TREND_COMING", f"EMA9/20 cross {cur['building'].lower()} - a {cur['building'].lower()} trend may be starting", lines)
            if a["big_move"]:
                emit(mk, name, "BIG_MOVE", f"{a['move3']:+.1f} points in 3 minutes at {a['price']:,.2f}", lines)
        st["last"][name] = cur
    flagged = set()
    try:
        rows, findings = check_accounts(mk, idx)
        cur = {}
        for f in findings:
            cur.setdefault((f["user"], f["sym"], f["kind"]), []).append(f)
        for key_, fs in cur.items():  # alert once per new reason for an order; a cleared reason can alert again later
            new_ = [f for f in fs if f["reason"] not in st["orders"].get(key_, set())]
            if new_:
                emit(mk, f"{key_[0]}: {key_[1]}", key_[2], "; ".join(f["text"] for f in new_), lines, force=True)
        st["orders"] = {k_: {f["reason"] for f in fs} for k_, fs in cur.items()}
        key = [(u, s.split(" | open")[0], r) for u, s, r in rows]
        flagged = {f"{u}: {x[:60]}" for u, _, r in rows for x in r if x.split(":")[0] in ACCOUNT_ALERT_WORDS}
        if key != st["acct"]:
            lines.append("ACCOUNTS (changed):")
            for u, s, r in rows:
                lines.append(f"  {u:9} {s}")
                lines += [f"      -> {x}" for x in r]
            st["acct"] = key
        else:
            lines.append(f"ACCOUNTS: no change ({sum(1 for _, _, r in rows if r)} with recommendations, see earlier entry)")
    except Exception as e:
        lines.append(f"ACCOUNTS: check failed ({type(e).__name__}: {e})")
    new = flagged - st["alerts"]
    if new:
        notify(f"{mk['label']}: " + "; ".join(sorted(new)))
    st["alerts"] = flagged
    text = "\n".join(lines) + "\n\n"
    mk["log"].parent.mkdir(parents=True, exist_ok=True)
    with open(mk["log"], "a") as f:  # ~230KB per market day; older days are pruned at the first cycle of each new day
        f.write(text)
    return text


def in_india_hours(now):
    return now.weekday() < 5 and (9, 15) <= (now.hour, now.minute) <= (15, 30)


def market(key, label, symbols, fetch, log, hours, dir_, cfg, flag, required, scripts, users_sql, under, is_call, is_put, book):
    return dict(key=key, label=label, symbols=symbols, fetch=fetch, log=log, hours=hours, dir=dir_, cfg=cfg, flag=flag,
                required=required, scripts=scripts, users_sql=users_sql, under=under, is_call=is_call, is_put=is_put, book=book,
                st={"acct": None, "alerts": set(), "day": None, "last": {}, "open": False, "orders": {}})


MARKETS = {
    "india": market(
        "india", "India", {"NIFTY": "^NSEI", "BANKNIFTY": "^NSEBANK", "SENSEX": "^BSESN"}, fetch_yahoo,
        OUT / "analysis_log.txt", in_india_hours, SMARTAPI, "auto_trade.json", lambda n: n,
        ("set_otm", "buy_or_sell_side", "buy_or_sell", "lotsize", "target_points", "loss_points", "stop_loss"),
        ("storesupportzone.py", "store_exit.py"), "SELECT username, is_admin FROM users ORDER BY is_admin DESC, username",
        lambda s: next((n for n in ("BANKNIFTY", "NIFTY", "SENSEX") if s.startswith(n)), None),
        lambda s: s.endswith("CE"), lambda s: s.endswith("PE"), "ordertoken"),
    "crypto": market(
        "crypto", "Crypto", {"BTC": "BTCUSDT", "ETH": "ETHUSDT"}, fetch_binance,
        OUT / "crypto_analysis_log.txt", lambda now: True, SMARTAPI / "crypto", "auto_trade_crypto.json", lambda n: n + "USD",
        ("buy_or_sell", "lotsize", "target_points", "loss_points", "stop_loss"),
        ("stetergy.py", "stetergy_exit.py"),
        "SELECT username, is_admin FROM users WHERE crypto_port IS NOT NULL ORDER BY is_admin DESC, username",
        lambda s: s.split("-")[1] if s.count("-") >= 2 else None,
        lambda s: s.startswith("C-"), lambda s: s.startswith("P-"), "cryptoorderbook"),
}


def selftest():
    import tempfile
    flat = [(i * 60, 100, 100.2, 99.8, 100 + (0.1 if i % 2 else -0.1)) for i in range(60)]
    ramp = [(i * 60, 100 + i, 101 + i, 99 + i, 100 + i) for i in range(60)]
    assert analyze(flat)["state"] == "SIDEWAYS", analyze(flat)
    assert analyze(ramp)["state"] == "TRENDING_UP", analyze(ramp)
    # 15m + 1h + 1d swings near 100 form one strong level; a lone 5m swing at 90 does not.
    lv = cluster([(100, "15m", 2), (100.05, "1h", 3), (100.02, "1d", 5), (90, "5m", 1)])
    assert len(lv) == 1 and abs(lv[0]["price"] - 100) < 0.1 and lv[0]["tfs"] == ["15m", "1h", "1d"], lv
    atrs = {"5m": 1.0, "15m": 2.0}
    a = dict(analyze(flat), price=101.0, closes=[99.5, 99.8, 100.1, 100.4, 100.8, 101.0], age_min=0)
    assert outlook(a, lv, atrs)["label"] == "BREAKOUT_UP", outlook(a, lv, atrs)
    a = dict(analyze(flat), price=99.6, closes=[99.6] * 6, age_min=0)
    assert outlook(a, lv, atrs)["label"] == "COILED", outlook(a, lv, atrs)
    assert outlook(dict(a, age_min=15), lv, atrs)["label"] == "NO_SIGNAL"
    assert MARKETS["crypto"]["under"]("C-BTC-78200-310826") == "BTC" and MARKETS["crypto"]["is_call"]("C-BTC-78200-310826")
    assert MARKETS["india"]["under"]("BANKNIFTY29SEP2656100CE") == "BANKNIFTY" and MARKETS["india"]["is_put"]("NIFTY22SEP2623400PE")
    with tempfile.TemporaryDirectory() as d:
        p = Path(d) / "log.txt"
        p.write_text("=== 2026-09-20 10:00 IST ===\nold\n\n=== 2026-09-21 09:15 IST ===\nnew a\n  -> x\n\n=== 2026-09-21 09:18 IST ===\nnew b\n\n")
        prune_log(p, "2026-09-21")
        t = p.read_text()
        assert "old" not in t and "new a" in t and "new b" in t and t.count("=== ") == 2, t
        prune_log(p, "2026-09-22")
        assert p.read_text() == "", p.read_text()
        # alerts: cooldown blocks a repeat, and only alerts older than 7 days are pruned
        globals()["ALERTS"], globals()["notify"] = Path(d) / "alerts.jsonl", lambda m: None
        _alert_seen.clear()
        lines = []
        emit(MARKETS["crypto"], "BTC", "NEAR_MOVE", "tight range", lines)
        emit(MARKETS["crypto"], "BTC", "NEAR_MOVE", "tight range", lines)
        assert len(ALERTS.read_text().splitlines()) == 1 and len(lines) == 1
        with open(ALERTS, "a") as f:
            f.write(json.dumps({"ts": "2020-01-01 00:00:00", "market": "india", "symbol": "X", "kind": "K", "text": "t"}) + "\n")
        prune_alerts(datetime.now(IST))
        assert len(ALERTS.read_text().splitlines()) == 1
    from datetime import date
    assert option_expiry("NIFTY22SEP2623300CE") == date(2026, 9, 22)
    assert option_expiry("SENSEX2691774400CE") == date(2026, 9, 17)
    assert option_expiry("P-BTC-80000-270826") == date(2026, 8, 27)
    assert option_expiry("SENSEX26SEP74800CE") is None
    with tempfile.TemporaryDirectory() as d:
        book = sqlite3.connect(Path(d) / "database.db")
        book.execute("CREATE TABLE ordertoken (symbol, ltp, lotsize, profit, createddate)")
        book.executemany("INSERT INTO ordertoken VALUES (?,?,?,?,?)", [
            ("NIFTY15SEP2623300CE", 100, 650, 0, "2026-09-18 14:22:33"),   # contract already expired
            ("NIFTY30DEC2623400CE", 100, 650, 0, "2026-09-21 10:00:00")])  # live call, +6.2 pts of a +10 target
        book.commit()
        today = date(2026, 9, 21)
        cfg = {"target_points": "10", "loss_points": "10", "storeorder": [
            {"symbol": "NIFTY30DEC2623400CE", "orderterm": "hold", "profit": 4000, "targetpoint": "10", "stoplosspoint": "10"}]}
        idx = {"NIFTY": {"state": "TRENDING_UP", "ol": {"label": "TREND", "R": None, "S": None, "dR": None, "dS": None}}}
        got = {(f["sym"], f["reason"]) for f in check_orders(MARKETS["india"], idx, "u", Path(d), cfg, {"exit"}, {"NIFTY"}, today)}
        assert ("NIFTY15SEP2623300CE", "expired") in got and ("NIFTY30DEC2623400CE", "trail") in got, got
        assert not any(r in ("trend", "noexit") for s_, r in got if s_ == "NIFTY30DEC2623400CE"), got
        idx["NIFTY"]["state"] = "TRENDING_DOWN"   # same call, now against the trend, and the exit bot is down
        got = {(f["sym"], f["reason"]) for f in check_orders(MARKETS["india"], idx, "u", Path(d), cfg, set(), {"NIFTY"}, today)}
        assert ("NIFTY30DEC2623400CE", "trend") in got and ("NIFTY30DEC2623400CE", "noexit") in got, got
        assert ("NIFTY30DEC2623400CE", "disabled") not in got and check_orders(MARKETS["india"], idx, "u", Path(d), cfg, set(), set(), today)
    print("selftest ok")


def arg(flag):
    return sys.argv[sys.argv.index(flag) + 1] if flag in sys.argv and sys.argv.index(flag) + 1 < len(sys.argv) else None


if __name__ == "__main__":
    key = arg("--market")
    if "--selftest" in sys.argv:
        selftest()
    elif "--once" in sys.argv:
        for m in ([MARKETS[key]] if key in MARKETS else MARKETS.values()):
            print(cycle(m))
    elif key not in MARKETS:
        sys.exit("usage: analyst.py --market india|crypto   (or --once [--market ...] / --selftest)")
    else:
        m = MARKETS[key]
        while True:  # one market per process: start/stop each independently, each has its own trading hours
            now, t0 = datetime.now(IST), time.time()
            if m["hours"](now):
                try:
                    cycle(m)
                except Exception as e:  # never die: one bad cycle must not end the day's monitoring
                    m["log"].parent.mkdir(parents=True, exist_ok=True)
                    with open(m["log"], "a") as f:
                        f.write(f"=== {now:%Y-%m-%d %H:%M} IST ===\nCYCLE FAILED: {type(e).__name__}: {e}\n\n")
                m["st"]["open"] = True
            elif m["st"]["open"]:
                with open(m["log"], "a") as f:
                    f.write(f"=== {now:%Y-%m-%d %H:%M} IST ===\nMarket closed - monitoring paused until next open.\n\n")
                m["st"]["open"] = False
            time.sleep(max(5, EVERY - (time.time() - t0)))
