import sys

import auth

if __name__ == "__main__":
    if len(sys.argv) != 5:
        print("usage: python manage_users.py <username> <password> <webview_port> <ai_port>")
        sys.exit(1)
    auth.init_db()
    auth.create_user(sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4]))
    print(f"created user {sys.argv[1]!r} -> webview_port={sys.argv[3]} ai_port={sys.argv[4]}")
