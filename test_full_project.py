"""
Full-project smoke test — checks what's actually working right now across
the whole multiuser setup, without needing anything running to be restarted.

Run: .venv/bin/python test_full_project.py

Four tiers, from no-setup-required to opt-in:
  1. Backend reachable, users.db readable — always runs.
  2. Per-user port liveness + config-key completeness/validity — always
     runs, no credentials needed. Targets the bug classes found so far:
       - storesupportzone.py/store_exit.py/stetergy.py crash on their first
         scheduled tick if a config key is missing entirely (bare
         fetch['key'], no .get() fallback).
       - ...or present but null/non-numeric (paras's stop_loss/set_otm —
         key-presence alone doesn't catch this, so values are validated too).
       - storesupportzone.py:2718 also reads load_data()['storeorder'],
         normally created lazily on the first tracked order — missing for
         every brand-new account, which is the actual reason auto-place
         looked like it "only worked for chetan" (old enough to have one).
  3. Strategy process liveness (storesupportzone.py/store_exit.py/
     stetergy.py) via each account's PID file — these have no port to
     probe, and a crashed process can leave a zombie that a naive
     os.kill(pid, 0) check reports as still running, so state is checked
     via `ps -o state=` instead (mirrors server.py's _pid_alive fix).
  4. Login, dashboard access, admin gating, and "act as" impersonation —
     only runs if you set TEST_ADMIN_PASSWORD / TEST_USER_PASSWORD, since
     real passwords don't belong hardcoded in a committed test file.
"""
import json
import os
import socket
import sqlite3
import subprocess
import sys
from pathlib import Path

import requests

API_BASE = os.environ.get("TEST_API_BASE", "http://localhost:4001")
SMARTAPI_DIR = Path(os.environ.get("SMARTAPI_DIR", str(Path.home() / "PycharmProjects/pythonProject/SmartApi")))
CRYPTO_DIR = SMARTAPI_DIR / "crypto"
USERS_DB = Path(__file__).parent / "users.db"

# Every key storesupportzone.py/store_exit.py or stetergy.py reads with a
# bare fetch['key'] (no .get() fallback) — confirmed by grepping both files.
# storeorder is a list, not a scalar, so it's checked for presence only
# (the *_NUMERIC subsets below get value-validated too, since presence
# alone let paras's stop_loss/set_otm = null through undetected).
INDIA_REQUIRED_KEYS = [
    "withmoney", "auto_place_order", "lotsize", "stop_loss", "target_points",
    "loss_points", "check_all_level", "set_otm", "send_alert", "buy_or_sell",
    "buy_or_sell_side", "storeorder",
]
INDIA_NUMERIC_KEYS = ["lotsize", "stop_loss", "target_points", "loss_points", "set_otm"]
CRYPTO_REQUIRED_KEYS = ["withmoney", "auto_place_order", "stop_loss", "lotsize", "target_points", "loss_points", "buy_or_sell"]
CRYPTO_NUMERIC_KEYS = ["lotsize", "stop_loss", "target_points", "loss_points"]

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


def _check_config(label, path, required_keys, numeric_keys):
    if not path.exists():
        record(label, None, f"no config file at {path} — nothing to check")
        return
    try:
        cfg = json.loads(path.read_text())
    except json.JSONDecodeError as e:
        record(label, False, f"invalid JSON: {e}")
        return
    problems = [k for k in required_keys if k not in cfg]
    for k in numeric_keys:
        if k in cfg and k not in problems:
            v = cfg[k]
            if v is None:
                problems.append(f"{k}=null")
                continue
            try:
                float(v)
            except (TypeError, ValueError):
                problems.append(f"{k}={v!r} (not numeric)")
    record(label, not problems, f"problems: {problems}" if problems else "")


def check_config_completeness(users):
    for u in users:
        account_dir = SMARTAPI_DIR / "accounts" / u["username"]
        # The original/default account (e.g. chetan) lives at the SmartApi
        # root, not accounts/<username> — fall back there if no per-user
        # directory exists, same resolution the bots themselves use.
        india_dir = account_dir if account_dir.exists() else SMARTAPI_DIR
        _check_config(f"{u['username']}: india config valid", india_dir / "auto_trade.json", INDIA_REQUIRED_KEYS, INDIA_NUMERIC_KEYS)

        if u["crypto_port"] is not None:
            crypto_account_dir = CRYPTO_DIR / "accounts" / u["username"]
            crypto_dir = crypto_account_dir if crypto_account_dir.exists() else CRYPTO_DIR
            _check_config(f"{u['username']}: crypto config valid", crypto_dir / "auto_trade_crypto.json", CRYPTO_REQUIRED_KEYS, CRYPTO_NUMERIC_KEYS)


def _pid_alive(account_dir, script_name):
    pid_file = account_dir / f"{script_name.removesuffix('.py')}.pid"
    if not pid_file.exists():
        return None  # no pidfile: never started through the admin flow (or is chetan's root account — see check_strategy_processes)
    try:
        pid = int(pid_file.read_text().strip())
    except ValueError:
        return False
    # os.kill(pid, 0) succeeds for a zombie too — check real process state,
    # same fix already applied to server.py's own _pid_alive().
    state = subprocess.run(["ps", "-o", "state=", "-p", str(pid)], capture_output=True, text=True).stdout.strip()
    return bool(state) and not state.startswith("Z")


def check_strategy_processes(users):
    for u in users:
        account_dir = SMARTAPI_DIR / "accounts" / u["username"]
        if account_dir.exists():
            for script in ("storesupportzone.py", "store_exit.py"):
                alive = _pid_alive(account_dir, script)
                record(f"{u['username']}: {script} running", alive, "" if alive else "not started via admin, or crashed — check logs/")
        else:
            record(f"{u['username']}: india strategy processes", None, "root/default account — no pidfile, check manually (known blind spot)")

        if u["crypto_port"] is not None:
            crypto_account_dir = CRYPTO_DIR / "accounts" / u["username"]
            if crypto_account_dir.exists():
                alive = _pid_alive(crypto_account_dir, "stetergy.py")
                record(f"{u['username']}: stetergy.py running", alive, "" if alive else "not started via admin, or crashed — check logs/")
            else:
                record(f"{u['username']}: crypto strategy process", None, "root/default account — no pidfile, check manually (known blind spot)")


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
        check_strategy_processes(users)

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
