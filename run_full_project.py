#!/usr/bin/env python3
"""Run this one file to bring up the whole project: the tradingview-clone app
(frontend + backend + tunnels via start.sh) plus every real user's india and
crypto bots.

    cd ~/tradingview-clone && ./venv-or-system-python3 run_full_project.py
    (or just: python3 run_full_project.py)

Reads users directly from users.db, the same way the Admin panel does, so it
always matches whoever actually exists — no hardcoded usernames/ports to keep
in sync. Reuses server.py's own _start_bot_process()/_managed_account_dir()
so bots start exactly the way the Admin panel starts them (same log files,
same .pid files), and stop.sh / the Admin panel's restart buttons keep working
normally afterward.

To stop everything again: ./stop.sh (app) plus killing the bot processes
listed in the Logs tab or via `pgrep -fl "storesupportzone.py|store_exit.py|stetergy.py|telegrambot.py"`.
"""
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import server
import auth


def start_app():
    print("=== starting tradingview-clone (frontend + backend + tunnels) ===")
    subprocess.run(["./start.sh"], cwd=Path(__file__).resolve().parent, check=True)
    print()


def start_india(user_row):
    username = user_row["username"]
    account_dir = server._managed_account_dir(server.SMARTAPI_DIR, username)
    has_real_broker = (account_dir / "document.py").exists() and \
        "demo_mode = False" in (account_dir / "document.py").read_text()
    print(f"--- {username} (india) {account_dir} ---")

    p = server._start_bot_process("webviewdataapi.py", server.SMARTAPI_DIR, account_dir, user_row["webview_port"])
    time.sleep(6 if has_real_broker else 1.5)
    print("  webviewdataapi:", "alive" if p.poll() is None else "DIED")

    p = server._start_bot_process("ai_order_service.py", server.SMARTAPI_DIR, account_dir, user_row["ai_port"])
    time.sleep(2 if has_real_broker else 1)
    print("  ai_order_service:", "alive" if p.poll() is None else "DIED")

    p = server._start_bot_process("storesupportzone.py", server.SMARTAPI_DIR, account_dir)
    time.sleep(2 if has_real_broker else 1)
    print("  storesupportzone:", "alive" if p.poll() is None else "DIED")

    p = server._start_bot_process("store_exit.py", server.SMARTAPI_DIR, account_dir)
    time.sleep(2 if has_real_broker else 1)
    print("  store_exit:", "alive" if p.poll() is None else "DIED")

    doc_text = (account_dir / "document.py").read_text() if (account_dir / "document.py").exists() else ""
    if "bot_token" in doc_text:
        p = server._start_bot_process("telegrambot.py", server.SMARTAPI_DIR / "treadingbot", account_dir)
        time.sleep(1.5)
        print("  telegrambot:", "alive" if p.poll() is None else "DIED")


def start_crypto(user_row):
    username = user_row["username"]
    if not user_row["crypto_port"]:
        return
    crypto_account_dir = server.CRYPTO_DIR / "accounts" / username
    if not crypto_account_dir.exists():
        crypto_account_dir = server.CRYPTO_DIR  # chetan legacy root
    print(f"--- {username} (crypto) {crypto_account_dir} ---")

    p = server._start_bot_process("webviewdataapi.py", server.CRYPTO_DIR, crypto_account_dir, user_row["crypto_port"])
    time.sleep(1.5)
    print("  crypto webviewdataapi:", "alive" if p.poll() is None else "DIED")

    p = server._start_bot_process("stetergy.py", server.CRYPTO_DIR, crypto_account_dir)
    time.sleep(1.5)
    print("  crypto stetergy:", "alive" if p.poll() is None else "DIED")


def main():
    start_app()

    users = auth.list_users()
    print(f"=== starting bots for {len(users)} user(s): {', '.join(u['username'] for u in users)} ===\n")
    for u in users:
        start_india(u)
        start_crypto(u)
        print()

    print("=== done — full project (india + crypto, all users) is up ===")
    print("Check status any time with: .venv/bin/python test_full_project.py")


if __name__ == "__main__":
    main()
