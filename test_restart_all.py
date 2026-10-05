"""Offline check of /api/admin/bots/restart-all and /stop-all. Run: .venv/bin/python test_restart_all.py"""
import tempfile
from pathlib import Path
from unittest import mock

import server

with tempfile.TemporaryDirectory() as d:
    root = Path(d)
    for name in ("chetan", "paras", "nocfg"):
        (root / name).mkdir()
    (root / "chetan" / "auto_trade.json").write_text("{}")
    (root / "paras" / "auto_trade.json").write_text("{}")
    calls, sleeps = [], []
    proc = mock.Mock(poll=lambda: None)
    with mock.patch.object(server.auth, "list_users", return_value=[{"username": n} for n in ("chetan", "paras", "nocfg")]), \
         mock.patch.object(server, "_managed_account_dir", lambda base, u: root / u), \
         mock.patch.object(server, "_read_document_py", lambda p: {"demo_mode": p.name != "chetan"}), \
         mock.patch.object(server, "_kill_pid", lambda p, s: calls.append(("kill", p.name, s))), \
         mock.patch.object(server, "_start_bot_process", lambda s, b, p: calls.append(("start", p.name, s)) or proc), \
         mock.patch.object(server.time, "sleep", sleeps.append):
        out = server.admin_restart_all_strategy_bots(admin={"is_admin": True})

assert [c for c in calls if c[1] == "nocfg"] == [], "account without auto-strategy skipped"
assert calls[:4] == [("kill", "chetan", "storesupportzone.py"), ("start", "chetan", "storesupportzone.py"),
                     ("kill", "chetan", "store_exit.py"), ("start", "chetan", "store_exit.py")], calls
assert sleeps == [8, 8, 2, 2], f"real account 8s apart, demo 2s: {sleeps}"
assert [(r["user"], r["bot"], r["alive"]) for r in out["results"]] == [
    ("chetan", "storesupportzone", True), ("chetan", "store_exit", True),
    ("paras", "storesupportzone", True), ("paras", "store_exit", True)], out

# stop-all: kills both bots for every account with auto-strategy, reports what's still alive, starts nothing
with tempfile.TemporaryDirectory() as d:
    root = Path(d)
    for name in ("chetan", "paras", "nocfg"):
        (root / name).mkdir()
    (root / "chetan" / "auto_trade.json").write_text("{}")
    (root / "paras" / "auto_trade.json").write_text("{}")
    kills, started = [], []
    with mock.patch.object(server.auth, "list_users", return_value=[{"username": n} for n in ("chetan", "paras", "nocfg")]), \
         mock.patch.object(server, "_managed_account_dir", lambda base, u: root / u), \
         mock.patch.object(server, "_kill_pid", lambda p, s: kills.append((p.name, s))), \
         mock.patch.object(server, "_pid_alive", lambda p, s: p.name == "paras" and s == "store_exit.py"), \
         mock.patch.object(server, "_start_bot_process", lambda *a: started.append(a)):
        out = server.admin_stop_all_strategy_bots(admin={"is_admin": True})
assert kills == [("chetan", "storesupportzone.py"), ("chetan", "store_exit.py"),
                 ("paras", "storesupportzone.py"), ("paras", "store_exit.py")], kills
assert not started, "stop-all never starts anything"
assert [r for r in out["results"] if r["alive"]] == [{"user": "paras", "bot": "store_exit", "alive": True}], out
print("restart all + stop all: 7/7 checks passed")
