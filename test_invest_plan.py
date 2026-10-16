# Offline check of ai_chat.invest_numbers (no Claude, no network): wrong-way levels dropped,
# quantities and ₹ outcomes computed in code, total max loss capped at the risk level.
import ai_chat

stock = {"market": "INDIA_STOCK", "symbol": "RELIANCE", "side": "BUY", "capital": 50000, "entry": 1000, "stoploss": 990, "target": 1020, "win_probability": 60}
bad = {"market": "INDIA_STOCK", "symbol": "BAD", "side": "BUY", "capital": 10000, "entry": 100, "stoploss": 105, "target": 110}
btc = {"market": "CRYPTO", "symbol": "BTC", "side": "SELL", "capital": 8800, "entry": 100000, "stoploss": 101000, "target": 98000, "win_probability": 140}
opt = {"market": "INDIA_OPTION", "symbol": "NIFTY", "side": "BUY", "capital": 20000, "entry": 25000, "stoploss": 24950, "target": 25100,
       "option_sl_pct": 30, "option_target_pct": 50, "win_probability": 50}

# under the cap: exact numbers
r = ai_chat.invest_numbers({"trades": [stock, bad, btc]}, 100000, "HIGH", 88.0)
by = {t["symbol"]: t for t in r["trades"]}
assert set(by) == {"RELIANCE", "BTC"} and r["dropped"][0].startswith("BAD")
assert (by["RELIANCE"]["qty"], by["RELIANCE"]["max_loss"], by["RELIANCE"]["max_profit"], by["RELIANCE"]["expected"]) == (50, 500, 1000, 400)
assert by["BTC"]["qty"] == 0.001 and by["BTC"]["max_loss"] == 88 and by["BTC"]["win_probability"] == 95
assert r["used"] == 50000 + 8800 and r["reserve"] == 100000 - 58800

# option alone loses 6000 = 6% > HIGH cap 3% -> capital scaled to 10000
r = ai_chat.invest_numbers({"trades": [opt]}, 100000, "HIGH", 88.0)
assert r["trades"][0]["capital"] == 10000 and r["max_loss"] == 3000 and r["trades"][0]["qty"] is None

# AI over-allocates (2 x 80k of a 100k amount) -> scaled to fit the amount
r = ai_chat.invest_numbers({"trades": [{**stock, "capital": 80000, "stoploss": 999}, {**stock, "symbol": "TCS", "capital": 80000, "stoploss": 999}]}, 100000, "HIGH", 88.0)
assert r["used"] <= 100000
print("ok")

# plans are saved per user for today, newest first, capped
import os, tempfile
ai_chat.PLANS_FILE = os.path.join(tempfile.mkdtemp(), "invest_plans.json")
for k in range(12):
    ai_chat._save_plan({"username": "u1"}, {"n": k})
ai_chat._save_plan({"username": "u2"}, {"n": "x"})
got = ai_chat.invest_plans_today({"username": "u1"})["plans"]
assert [p["n"] for p in got] == list(range(11, 1, -1)) and ai_chat.invest_plans_today({"username": "u2"})["plans"] == [{"n": "x"}]
assert ai_chat.invest_plans_today({"username": "nobody"})["plans"] == []
print("saved plans ok")
