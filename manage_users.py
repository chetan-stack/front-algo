import sys

import auth

if __name__ == "__main__":
    args = sys.argv[1:]
    is_admin = "--admin" in args
    args = [a for a in args if a != "--admin"]
    if len(args) not in (4, 5):
        print("usage: python manage_users.py <username> <password> <webview_port> <ai_port> [crypto_port] [--admin]")
        sys.exit(1)
    crypto_port = int(args[4]) if len(args) == 5 else None
    auth.init_db()
    auth.create_user(args[0], args[1], int(args[2]), int(args[3]), is_admin, crypto_port)
    print(f"created user {args[0]!r} -> webview_port={args[2]} ai_port={args[3]} crypto_port={crypto_port} admin={is_admin}")
