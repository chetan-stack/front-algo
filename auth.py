import hashlib
import hmac
import secrets
import sqlite3
from pathlib import Path

from fastapi import Depends, Header, HTTPException

DB_FILE = Path(__file__).parent / "users.db"


def _connect():
    conn = sqlite3.connect(DB_FILE)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    with _connect() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY,
                username TEXT UNIQUE NOT NULL,
                salt TEXT NOT NULL,
                password_hash TEXT NOT NULL,
                webview_port INTEGER NOT NULL,
                ai_port INTEGER NOT NULL,
                is_admin INTEGER NOT NULL DEFAULT 0,
                crypto_port INTEGER
            )
        """)
        # Self-signups from the website wait here until an admin approves them,
        # so nothing that reads `users` (bots, restart-all, smoke test) sees them.
        conn.execute("""
            CREATE TABLE IF NOT EXISTS signups (
                id INTEGER PRIMARY KEY,
                username TEXT UNIQUE NOT NULL,
                salt TEXT NOT NULL,
                password_hash TEXT NOT NULL,
                created TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS sessions (
                token TEXT PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES users(id)
            )
        """)
        # crypto_port didn't exist on users created before crypto support was
        # added — NULL for those rows means "no crypto account provisioned".
        cols = {row["name"] for row in conn.execute("PRAGMA table_info(users)")}
        if "crypto_port" not in cols:
            conn.execute("ALTER TABLE users ADD COLUMN crypto_port INTEGER")


def _hash(password: str, salt: str) -> str:
    return hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), 200_000).hex()


def create_user(username: str, password: str, webview_port: int, ai_port: int, is_admin: bool = False, crypto_port: int = None):
    salt = secrets.token_hex(16)
    with _connect() as conn:
        conn.execute(
            "INSERT INTO users (username, salt, password_hash, webview_port, ai_port, is_admin, crypto_port) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (username, salt, _hash(password, salt), webview_port, ai_port, int(is_admin), crypto_port),
        )


def set_crypto_port(username: str, crypto_port: int):
    with _connect() as conn:
        conn.execute("UPDATE users SET crypto_port = ? WHERE username = ?", (crypto_port, username))


def list_users():
    with _connect() as conn:
        return conn.execute("SELECT id, username, webview_port, ai_port, crypto_port, is_admin FROM users ORDER BY id").fetchall()


def set_password(username: str, new_password: str):
    salt = secrets.token_hex(16)
    with _connect() as conn:
        conn.execute(
            "UPDATE users SET salt = ?, password_hash = ? WHERE username = ?",
            (salt, _hash(new_password, salt), username),
        )


def delete_sessions_for_user(username: str):
    with _connect() as conn:
        conn.execute(
            "DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE username = ?)",
            (username,),
        )


def username_taken(username: str) -> bool:
    with _connect() as conn:
        return any(conn.execute(f"SELECT 1 FROM {t} WHERE username = ? COLLATE NOCASE", (username,)).fetchone()
                   for t in ("users", "signups"))


def create_signup(username: str, password: str):
    salt = secrets.token_hex(16)
    with _connect() as conn:
        conn.execute("INSERT INTO signups (username, salt, password_hash) VALUES (?, ?, ?)",
                     (username, salt, _hash(password, salt)))


def list_signups():
    with _connect() as conn:
        return conn.execute("SELECT username, created FROM signups ORDER BY id").fetchall()


def signup_password_ok(username: str, password: str) -> bool:
    with _connect() as conn:
        row = conn.execute("SELECT * FROM signups WHERE username = ? COLLATE NOCASE", (username,)).fetchone()
    return row is not None and hmac.compare_digest(_hash(password, row["salt"]), row["password_hash"])


def approve_signup(username: str, webview_port: int, ai_port: int) -> bool:
    """Move a pending signup into users (same password hash). False if there's no such signup."""
    with _connect() as conn:
        row = conn.execute("SELECT * FROM signups WHERE username = ?", (username,)).fetchone()
        if row is None:
            return False
        conn.execute(
            "INSERT INTO users (username, salt, password_hash, webview_port, ai_port, is_admin) VALUES (?, ?, ?, ?, ?, 0)",
            (row["username"], row["salt"], row["password_hash"], webview_port, ai_port),
        )
        conn.execute("DELETE FROM signups WHERE id = ?", (row["id"],))
        return True


def delete_signup(username: str) -> bool:
    with _connect() as conn:
        return conn.execute("DELETE FROM signups WHERE username = ?", (username,)).rowcount > 0


def authenticate(username: str, password: str):
    # COLLATE NOCASE: a mobile keyboard auto-capitalizing the first letter, or
    # a username stored with different casing than a user naturally types
    # their own name, used to fail with the same "invalid username or
    # password" 401 as a real wrong password — confirmed live for two
    # different users (chetan's phone, Vaibhav's stored "Vaibhav" vs typed
    # "vaibhav"). Login should never be case-sensitive on the username.
    with _connect() as conn:
        user = conn.execute("SELECT * FROM users WHERE username = ? COLLATE NOCASE", (username,)).fetchone()
    if user is None or not hmac.compare_digest(_hash(password, user["salt"]), user["password_hash"]):
        return None
    return user


def create_session(user_id: int) -> str:
    token = secrets.token_urlsafe(32)
    with _connect() as conn:
        conn.execute("INSERT INTO sessions (token, user_id) VALUES (?, ?)", (token, user_id))
    return token


def delete_session(token: str):
    with _connect() as conn:
        conn.execute("DELETE FROM sessions WHERE token = ?", (token,))


def user_from_token(token: str):
    with _connect() as conn:
        return conn.execute("""
            SELECT users.* FROM sessions JOIN users ON users.id = sessions.user_id
            WHERE sessions.token = ?
        """, (token,)).fetchone()


def get_current_user(authorization: str = Header(default=None)):
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(401, "not authenticated")
    user = user_from_token(authorization.removeprefix("Bearer "))
    if user is None:
        raise HTTPException(401, "invalid or expired session")
    return user


def require_admin(user=Depends(get_current_user)):
    if not user["is_admin"]:
        raise HTTPException(403, "admin only")
    return user
