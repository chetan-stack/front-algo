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

    # 3. a different from_date is a different window -> not served from cache
    server.historical_candle("NSE", "99926000", "ONE_MINUTE", "2026-09-30 09:15", "2026-10-01 10:00")
    assert len(fake.calls) == 2

    # 4. cache expires after CANDLE_CACHE_TTL -> fresh data again
    key = ("NSE", "99926000", "ONE_MINUTE", "2026-10-01 09:15")
    server._candle_cache[key] = (time.time() - server.CANDLE_CACHE_TTL - 1, [])
    server.historical_candle(*key, "2026-10-01 10:01")
    assert len(fake.calls) == 3
    print("candle cache/throttle: 4/4 checks passed")


if __name__ == "__main__":
    main()
