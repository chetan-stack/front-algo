"""Offline check of /api/ltp (exit bots' fallback when a websocket tick is stale).
Run: .venv/bin/python test_rest_ltp.py"""
import time

from fastapi import HTTPException

import live_feed
import server

calls = []


class Fake:
    def ltpData(self, exch, sym, tok):
        calls.append(tok)
        return {"data": {"ltp": 438.0}}


live_feed._get_rest_session = lambda: Fake()
assert server.rest_ltp("BFO", "SENSEX26O0872400PE", "889261")["ltp"] == 438.0
for _ in range(5):  # every demo bot falling back at once
    server.rest_ltp("BFO", "SENSEX26O0872400PE", "889261")
assert calls == ["889261"], calls
server._ltp_cache["889261"] = (time.time() - server.LTP_CACHE_TTL - 1, 1.0)
server.rest_ltp("BFO", "SENSEX26O0872400PE", "889261")
assert len(calls) == 2, "refetched after the cache expires"


class Broken:
    def ltpData(self, *a):
        raise Exception("exceeding access rate")


live_feed._get_rest_session = lambda: Broken()
try:
    server.rest_ltp("NFO", "X", "1")
    raise AssertionError("must fail")
except HTTPException as e:
    assert e.status_code == 502 and "exceeding" in e.detail
print("rest ltp: 4/4 checks passed")
