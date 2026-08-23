"""
Full-project smoke test — checks what's actually working right now across
the whole multiuser setup, without needing anything running to be restarted.

Run: .venv/bin/python test_full_project.py

Three tiers, from no-setup-required to opt-in:
  1. Backend reachable, users.db readable — always runs.
  2. Per-user port liveness + config-key completeness — always runs, no
     credentials needed. This directly targets the bug class found twice
     already: storesupportzone.py/stetergy.py crash on their first
     scheduled tick if a config key is missing (bare fetch['key'], no
     .get() fallback) — this catches that before the process does.
  3. Login, dashboard access, admin gating, and "act as" impersonation —
     only runs if you set TEST_ADMIN_PASSWORD / TEST_USER_PASSWORD, since
     real passwords don't belong hardcoded in a committed test file.
"""
import json
import os
import socket
import sqlite3
import sys
from pathlib import Path

import requests

API_BASE = os.environ.get("TEST_API_BASE", "http://localhost:4001")
SMARTAPI_DIR = Path(os.environ.get("SMARTAPI_DIR", str(Path.home() / "PycharmProjects/pythonProject/SmartApi")))
CRYPTO_DIR = SMARTAPI_DIR / "crypto"
USERS_DB = Path(__file__).parent / "users.db"

# Every key storesupportzone.py/store_exit.py or stetergy.py reads with a
# bare fetch['key'] (no .get() fallback) — confirmed by grepping both files.
INDIA_REQUIRED_KEYS = [
    "withmoney", "auto_place_order", "lotsize", "stop_loss", "target_points",
    "loss_points", "check_all_level", "set_otm", "send_alert", "buy_or_sell", "buy_or_sell_side",
]
CRYPTO_REQUIRED_KEYS = ["withmoney", "auto_place_order", "stop_loss", "lotsize", "target_points", "loss_points", "buy_or_sell"]

results = []


def record(name, ok, detail=""):
    results.append((name, ok, detail))
    status = "SKIP" if ok is None else ("PASS" if ok else "FAIL")
    print(f"[{status}] {name}" + (f" — {detail}" if detail else ""))


def port_open(port, host="localhost", timeout=1.5):
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def load_users():
    if not USERS_DB.exists():
        return []
    conn = sqlite3.connect(USERS_DB)
    conn.row_factory = sqlite3.Row
    rows = conn.execute("SELECT username, webview_port, ai_port, crypto_port, is_admin FROM users").fetchall()
    conn.close()
    return [dict(r) for r in rows]


def check_backend_alive():
    try:
        r = requests.post(f"{API_BASE}/api/auth/login", json={"username": "__nonexistent__", "password": "x"}, timeout=5)
        record("backend reachable", r.status_code == 401, f"got {r.status_code}")
    except requests.RequestException as e:
        record("backend reachable", False, str(e))


def check_ports(users):
    for u in users:
        record(f"{u['username']}: india dashboard port {u['webview_port']}", port_open(u["webview_port"]))
        record(f"{u['username']}: india ai-order port {u['ai_port']}", port_open(u["ai_port"]))
        if u["crypto_port"] is not None:
            record(f"{u['username']}: crypto dashboard port {u['crypto_port']}", port_open(u["crypto_port"]))


def _check_config(label, path, required_keys):
    if not path.exists():
        record(label, None, f"no config file at {path} — nothing to check")
        return
    try:
        cfg = json.loads(path.read_text())
    except json.JSONDecodeError as e:
        record(label, False, f"invalid JSON: {e}")
        return
    missing = [k for k in required_keys if k not in cfg]
    record(label, not missing, f"missing keys: {missing}" if missing else "")


def check_config_completeness(users):
    for u in users:
        account_dir = SMARTAPI_DIR / "accounts" / u["username"]
        # The original/default account (e.g. chetan) lives at the SmartApi
        # root, not accounts/<username> — fall back there if no per-user
        # directory exists, same resolution the bots themselves use.
        india_dir = account_dir if account_dir.exists() else SMARTAPI_DIR
        _check_config(f"{u['username']}: india config complete", india_dir / "auto_trade.json", INDIA_REQUIRED_KEYS)

        if u["crypto_port"] is not None:
            crypto_account_dir = CRYPTO_DIR / "accounts" / u["username"]
            crypto_dir = crypto_account_dir if crypto_account_dir.exists() else CRYPTO_DIR
            _check_config(f"{u['username']}: crypto config complete", crypto_dir / "auto_trade_crypto.json", CRYPTO_REQUIRED_KEYS)


def login(username, password):
    try:
        r = requests.post(f"{API_BASE}/api/auth/login", json={"username": username, "password": password}, timeout=10)
    except requests.RequestException as e:
        record(f"{username}: login", False, str(e))
        return None
    if r.status_code != 200:
        record(f"{username}: login", False, f"got {r.status_code}: {r.text[:150]}")
        return None
    record(f"{username}: login", True)
    return r.json()["token"]


def check_dashboard(username, token):
    headers = {"Authorization": f"Bearer {token}"}
    r = requests.get(f"{API_BASE}/api/trading/dashboard", headers=headers, timeout=15)
    record(f"{username}: india dashboard reachable", r.status_code == 200, f"got {r.status_code}: {r.text[:150]}" if r.status_code != 200 else "")


def check_admin_gating(admin_token, nonadmin_token):
    if admin_token:
        r = requests.get(f"{API_BASE}/api/admin/users", headers={"Authorization": f"Bearer {admin_token}"}, timeout=10)
        record("admin: /api/admin/users accessible", r.status_code == 200, f"got {r.status_code}")
    if nonadmin_token:
        r = requests.get(f"{API_BASE}/api/admin/users", headers={"Authorization": f"Bearer {nonadmin_token}"}, timeout=10)
        record("non-admin: /api/admin/users blocked", r.status_code == 403, f"got {r.status_code}")


def check_impersonation(admin_token, target_username):
    headers = {"Authorization": f"Bearer {admin_token}"}
    own = requests.get(f"{API_BASE}/api/trading/dashboard", headers=headers, timeout=15)
    as_target = requests.get(f"{API_BASE}/api/trading/dashboard?as_user={target_username}", headers=headers, timeout=15)
    ok = own.status_code == 200 and as_target.status_code == 200 and own.text != as_target.text
    detail = "" if ok else f"own={own.status_code} as_target={as_target.status_code} (same body: {own.text == as_target.text})"
    record(f"admin: act-as {target_username} returns different data than own account", ok, detail)


def main():
    print(f"=== Full project smoke test (API_BASE={API_BASE}) ===\n")
    check_backend_alive()

    users = load_users()
    if not users:
        record("users.db readable", False, "no users found — has anything been created?")
    else:
        record("users.db readable", True, f"{len(users)} user(s): {[u['username'] for u in users]}")
        check_ports(users)
        check_config_completeness(users)

    admin_user = next((u for u in users if u["is_admin"]), None)
    admin_password = os.environ.get("TEST_ADMIN_PASSWORD")
    admin_token = None
    if admin_user and admin_password:
        admin_token = login(admin_user["username"], admin_password)
        if admin_token:
            check_dashboard(admin_user["username"], admin_token)
    else:
        record("admin login/dashboard check", None, "set TEST_ADMIN_PASSWORD to enable")

    other_user = next((u for u in users if not u["is_admin"]), None)
    other_password = os.environ.get("TEST_USER_PASSWORD")
    other_token = None
    if other_user and other_password:
        other_token = login(other_user["username"], other_password)
        if other_token:
            check_dashboard(other_user["username"], other_token)
    else:
        record("secondary user login/dashboard check", None, "set TEST_USER_PASSWORD to enable")

    if admin_token or other_token:
        check_admin_gating(admin_token, other_token)
    if admin_token and other_user:
        check_impersonation(admin_token, other_user["username"])

    print("\n=== summary ===")
    passed = sum(1 for _, ok, _ in results if ok is True)
    failed = sum(1 for _, ok, _ in results if ok is False)
    skipped = sum(1 for _, ok, _ in results if ok is None)
    print(f"{passed} passed, {failed} failed, {skipped} skipped")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
