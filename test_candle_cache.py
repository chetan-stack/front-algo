"""Offline check of the shared candle fetch: AngelOne calls are spaced under
the rate limit, and identical requests at the same moment cost one call.
Run: .venv/bin/python test_candle_cache.py"""
import threading
import time

import live_feed
import server


class FakeBroker:
    def __init__(self):
        self.calls = []

    def getCandleData(self, params):
        self.calls.append(time.time())
        time.sleep(0.05)
        return {"data": [["2026-10-01T10:00:00", 1, 2, 0.5, 1.5, 100]]}


def main():
    fake = FakeBroker()
    live_feed._get_rest_session = lambda: fake

    # 1. eight different tokens at once -> spaced CANDLE_MIN_GAP apart
    threads = [threading.Thread(target=server.historical_candle,
                                args=("NFO", str(t), "ONE_MINUTE", "2026-10-01 09:15", "2026-10-01 10:00"))
               for t in range(8)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    gaps = [b - a for a, b in zip(fake.calls, fake.calls[1:])]
    assert len(fake.calls) == 8, fake.calls
    assert min(gaps) >= live_feed.CANDLE_MIN_GAP - 0.01, gaps

    # 2. six bots asking for the same candles at once -> one AngelOne call
    fake.calls.clear()
    results = []
    threads = [threading.Thread(target=lambda: results.append(server.historical_candle(
        "NSE", "99926000", "ONE_MINUTE", "2026-10-01 09:15", "2026-10-01 10:00"))) for _ in range(6)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert len(fake.calls) == 1, len(fake.calls)
    assert len(results) == 6 and all(r["success"] for r in results)

    # 3. entry bot (yesterday 09:15) + exit bot (today 09:15) -> ONE AngelOne call, each gets its slice
    server._candle_cache.clear(); fake.calls.clear()
    asked = []
    def window_fake(params):
        asked.append(params["fromdate"]); fake.calls.append(time.time())
        return {"data": [["2026-09-30T15:29:00+05:30", 1, 1, 1, 1, 0], ["2026-10-01T09:15:00+05:30", 2, 2, 2, 2, 0]]}
    fake.getCandleData = window_fake
    wide = server.historical_candle("NSE", "99926000", "ONE_MINUTE", "2026-09-30 09:15", "2026-10-01 10:00")["data"]
    narrow = server.historical_candle("NSE", "99926000", "ONE_MINUTE", "2026-10-01 09:15", "2026-10-01 10:00")["data"]
    assert len(fake.calls) == 1, asked
    assert len(wide) == 2 and len(narrow) == 1 and narrow[0][0].startswith("2026-10-01"), (wide, narrow)

    # 4. after the cache expires, the refetch keeps the wider window, even when the narrow caller asks first
    key = ("NSE", "99926000", "ONE_MINUTE")
    server._candle_cache[key] = (time.time() - server.CANDLE_CACHE_TTL - 1, "2026-09-30 09:15", [])
    server.historical_candle("NSE", "99926000", "ONE_MINUTE", "2026-10-01 09:15", "2026-10-01 10:01")
    assert asked[-1] == "2026-09-30 09:15" and len(fake.calls) == 2, asked
    fake.getCandleData = FakeBroker.getCandleData.__get__(fake)

    # 5. "exceeding access rate" -> back off ~1s and retry, never re-login
    logins = []
    live_feed._get_rest_session = lambda: logins.append(1) or fake
    real_call, fails = fake.getCandleData, [2]

    def flaky(params):
        if fails[0]:
            fails[0] -= 1
            raise Exception("Couldn't parse the JSON response: b'Access denied because of exceeding access rate'")
        return real_call(params)
    fake.getCandleData = flaky
    live_feed._rest_obj = "session"
    t0 = time.time()
    assert live_feed.get_historical_candles("NFO", "1", "ONE_MINUTE", "a", "b")
    assert time.time() - t0 >= 2, "should have backed off twice"
    assert live_feed._rest_obj == "session", "rate limit must not drop the session"
    print("candle cache/throttle: 5/5 checks passed")


if __name__ == "__main__":
    main()
