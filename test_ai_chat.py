# Offline check of ai_chat.py (Claude Code stubbed, no network): symbols found in
# questions, the ```plan block becomes a "plan" line and never reaches the chat
# text even when split across deltas, errors end the stream cleanly.
import json
import os
import tempfile

import ai_chat
from fastapi import HTTPException

ai_chat.USAGE_FILE = os.path.join(tempfile.mkdtemp(), "ai_usage.json")  # never the real counts
USER = {"username": "tester", "is_admin": 0}
ADMIN = {"username": "chetan", "is_admin": 1}

ai_chat._candles = lambda s, r, n: f"{s} {r}: stub"
assert ai_chat._symbols("bank nifty levels?", "") == ["NSE:BANKNIFTY"]
assert ai_chat._symbols("nifty and btc", "") == ["NSE:NIFTY", "BINANCE:BTCUSDT"]
assert ai_chat._symbols("explain NSE:TCS daily", "") == ["NSE:TCS"]
assert ai_chat._symbols("what now?", "NSE:NIFTY 5, BINANCE:ETHUSDT 1") == ["NSE:NIFTY", "BINANCE:ETHUSDT"]

plan = {"symbol": "NSE:NIFTY", "levels": [{"price": 25000, "type": "support"}], "trade": {"direction": "buy_ce"}}
answer = "Support at 25000.\n```plan\n" + json.dumps(plan) + "\n```"


def run(chunks, extra=()):
    seen = []
    def fake(content, system, model=None):
        seen.append(content)
        yield from extra
        for c in chunks:
            yield "text", c
    ai_chat.claude_code = fake
    hist = [{"role": "user", "content": "levels for nifty?"}]
    return [json.loads(l) for l in ai_chat._chat_stream(USER, hist, "data:image/png;base64,AAAA", "", 3)], seen


for size in (1, 3, 7, 1000):  # marker split at every position
    out, seen = run([answer[i:i + size] for i in range(0, len(answer), size)])
    text = "".join(o["v"] for o in out if o["t"] == "text")
    assert text == "Support at 25000.\n", (size, text)
    assert {"t": "plan", "v": plan} in out and out[-1]["t"] == "done", out
assert seen[0][0]["type"] == "image" and "NSE:NIFTY 5: stub" in seen[0][1]["text"]

out, _ = run(["no plan here"])
assert "".join(o["v"] for o in out if o["t"] == "text") == "no plan here"

out, _ = run([], extra=[("error", "Claude Code failed: x")])
assert {"t": "error", "v": "Claude Code failed: x"} in out and out[-1]["t"] == "done"

# quota: 5 per non-admin per day, a failed answer is refunded, admins unlimited
ai_chat.USAGE_FILE = os.path.join(tempfile.mkdtemp(), "ai_usage.json")
assert [ai_chat.take_quota(USER) for _ in range(5)] == [4, 3, 2, 1, 0]
try:
    ai_chat.take_quota(USER)
    raise AssertionError("6th question allowed")
except HTTPException as e:
    assert e.status_code == 429
ai_chat.refund_quota(USER)  # e.g. Claude Code failed on the 5th
assert ai_chat.take_quota(USER) == 0
assert all(ai_chat.take_quota(ADMIN) is None for _ in range(10))
out, _ = run([], extra=[("error", "boom")])  # stream error refunds
assert ai_chat.take_quota(USER) == 0 and {"t": "quota", "v": {"left": 4, "limit": 5}} in out
print("ai_chat OK")
