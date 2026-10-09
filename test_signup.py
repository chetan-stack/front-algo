"""Offline check of website signup -> admin approve -> login, and the user's own broker-key routes.
Temp users.db and account dirs, bots stubbed. Run: .venv/bin/python test_signup.py"""
import tempfile
from pathlib import Path
from unittest import mock

from fastapi import HTTPException

import server
from server import auth


def status(fn, *a, **k):
    try:
        fn(*a, **k)
        return 200
    except HTTPException as e:
        return e.status_code


with tempfile.TemporaryDirectory() as d:
    root = Path(d)
    started = []
    proc = mock.Mock(poll=lambda: None)
    with mock.patch.object(auth, "DB_FILE", root / "users.db"), \
         mock.patch.object(server, "SMARTAPI_DIR", root), \
         mock.patch.object(server, "_start_bot_process", lambda s, b, p, port=None: started.append((s, p.name, port)) or proc), \
         mock.patch.object(server, "_next_ports", lambda: (5000, 5004)), \
         mock.patch.object(server.time, "sleep", lambda s: None):
        auth.init_db()
        signup = lambda u, p="secret123": status(server.signup, {"username": u, "password": p})
        login = lambda u, p="secret123": status(server.login, {"username": u, "password": p})

        assert signup("../etc") == 400 and signup("ab") == 400 and signup("good_name", "short") == 400
        assert signup("Asha_1") == 200  # stored lowercased
        assert signup("asha_1") == 409, "username taken, any case"
        assert login("asha_1") == 403 and login("asha_1", "wrongpass") == 401, "pending: told to wait only with the right password"
        assert auth.list_users() == [] and started == [] and not (root / "accounts").exists(), "pending signup: no user row, files or bots"

        assert status(server.admin_approve_signup, "nobody", admin=None) == 404
        out = server.admin_approve_signup("asha_1", admin=None)
        assert out["webview_alive"] and out["ai_alive"]
        assert [s[0] for s in started] == ["webviewdataapi.py", "ai_order_service.py"] and started[0][2] == 5000
        acct = root / "accounts" / "asha_1"
        assert "demo_mode = True" in (acct / "document.py").read_text() and (acct / "auto_trade.json").exists()
        assert login("asha_1") == 200 and auth.list_signups() == []

        assert signup("spam") == 200 and status(server.admin_reject_signup, "spam", admin=None) == 200
        assert status(server.admin_reject_signup, "spam", admin=None) == 404
        for i in range(server.MAX_PENDING_SIGNUPS):
            assert signup(f"u{i:03d}") == 200
        assert signup("onetoomany") == 429

        # Broker keys: secrets never come back; Telegram settings survive a key change
        user = next(u for u in auth.list_users() if u["username"] == "asha_1")
        (acct / "document.py").write_text('api_key = "KEY12345"\nuser_id = "A1"\npassword = "1111"\ntotp = "SECRETTOTP"\nbot_token = "tg"\nchatids = [7]\n')
        info = server.my_broker(user=user)
        assert "1111" not in str(info) and "SECRETTOTP" not in str(info) and info["india"]["api_key"] == "••••2345"
        with mock.patch.object(server, "admin_update_credentials", return_value={"success": True}) as upd, \
             mock.patch.object(server, "_pid_alive", return_value=False):
            assert status(server.my_broker_india, {"live": True, "api_key": "k", "user_id": "u"}, user=user) == 400
            server.my_broker_india({"live": True, "api_key": "k", "user_id": "u", "password": "p", "totp": "t"}, user=user)
            sent = upd.call_args[0][1]
            assert sent["angelone"] == {"api_key": "k", "user_id": "u", "password": "p", "totp": "t"}
            assert sent["telegram"] == {"bot_token": "tg", "chatids": [7]} and sent["enable_strategy"] is False
            server.my_broker_india({"live": False}, user=user)
            assert upd.call_args[0][1]["angelone"] is None, "switch to paper"
print("test_signup: all passed")
