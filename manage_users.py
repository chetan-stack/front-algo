import sys

import auth

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("usage: python manage_users.py <username> <password> [selectclient]")
        sys.exit(1)
    auth.init_db()
    auth.create_user(sys.argv[1], sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else None)
    print(f"created user {sys.argv[1]!r}")
