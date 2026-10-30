"""Toegang: alleen gekoppelde apparaten. Koppelen gaat met een eenmalige code die je in /admin aanmaakt."""
import hashlib
import hmac
import os
import re
import secrets
import time
from datetime import datetime, timedelta, timezone

from . import db

ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "")
ENABLED = bool(ADMIN_PASSWORD)
DEVICE_COOKIE = "nr_device"
ADMIN_COOKIE = "nr_admin"
CODE_MINUTES = 15
ADMIN_HOURS = 12

db.con().executescript("""
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY, name TEXT, token_hash TEXT UNIQUE,
  created_at TEXT, last_seen TEXT, user_agent TEXT
);
CREATE TABLE IF NOT EXISTS pair_codes (code_hash TEXT PRIMARY KEY, name TEXT, expires REAL);
CREATE TABLE IF NOT EXISTS admin_sessions (token_hash TEXT PRIMARY KEY, expires REAL);
""")

_attempts: dict[str, list[float]] = {}


def _h(s: str) -> str:
    return hashlib.sha256(s.encode()).hexdigest()


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def rate_limited(ip: str, limit=10, window=900) -> bool:
    """Maximaal `limit` mislukte pogingen per IP per kwartier."""
    t = time.time()
    hits = [x for x in _attempts.get(ip, []) if t - x < window]
    _attempts[ip] = hits
    return len(hits) >= limit


def failed(ip: str):
    _attempts.setdefault(ip, []).append(time.time())


# ---------- apparaten ----------

def device_for_token(token: str | None) -> dict | None:
    if not token:
        return None
    r = db.con().execute("SELECT * FROM devices WHERE token_hash=?", (_h(token),)).fetchone()
    if not r:
        return None
    # last_seen hooguit eens per 5 minuten bijwerken
    if not r["last_seen"] or r["last_seen"] < (datetime.now(timezone.utc) - timedelta(minutes=5)).isoformat():
        with db._lock:
            db.con().execute("UPDATE devices SET last_seen=? WHERE id=?", (_now_iso(), r["id"]))
            db.con().commit()
    return dict(r)


def create_code(name: str) -> str:
    code = f"{secrets.randbelow(10**6):06d}"
    with db._lock:
        db.con().execute("DELETE FROM pair_codes WHERE expires < ?", (time.time(),))
        db.con().execute("INSERT OR REPLACE INTO pair_codes(code_hash, name, expires) VALUES(?,?,?)",
                         (_h(code), name[:60], time.time() + CODE_MINUTES * 60))
        db.con().commit()
    return code


def pair(code: str, name: str, legacy_id: str, user_agent: str) -> str | None:
    """Geldige code → nieuw apparaat + token (de code is daarna verbruikt)."""
    code = re.sub(r"\D", "", code or "")
    con = db.con()
    with db._lock:
        r = con.execute("SELECT * FROM pair_codes WHERE code_hash=? AND expires >= ?", (_h(code), time.time())).fetchone()
        if not r:
            return None
        con.execute("DELETE FROM pair_codes WHERE code_hash=?", (_h(code),))
        # bestaande leesgeschiedenis van dit toestel behouden als het al een id had
        dev_id = legacy_id if re.fullmatch(r"[A-Za-z0-9-]{8,64}", legacy_id or "") and not con.execute(
            "SELECT 1 FROM devices WHERE id=?", (legacy_id,)).fetchone() else secrets.token_hex(12)
        token = secrets.token_urlsafe(32)
        con.execute("INSERT INTO devices(id, name, token_hash, created_at, last_seen, user_agent) VALUES(?,?,?,?,?,?)",
                    (dev_id, (r["name"] or name or "Toestel")[:60], _h(token), _now_iso(), _now_iso(), (user_agent or "")[:200]))
        con.commit()
    return token


def list_devices() -> list[dict]:
    rows = db.con().execute("SELECT id, name, created_at, last_seen, user_agent FROM devices ORDER BY last_seen DESC").fetchall()
    out = []
    for r in rows:
        n = db.con().execute("SELECT COUNT(*) FROM subscriptions WHERE device=?", (r["id"],)).fetchone()[0] \
            if "device" in [c[1] for c in db.con().execute("PRAGMA table_info(subscriptions)")] else 0
        out.append({**dict(r), "push": n > 0})
    return out


def rename_device(dev_id: str, name: str):
    with db._lock:
        db.con().execute("UPDATE devices SET name=? WHERE id=?", (name[:60], dev_id))
        db.con().commit()


def revoke_device(dev_id: str):
    con = db.con()
    with db._lock:
        con.execute("DELETE FROM devices WHERE id=?", (dev_id,))
        try:
            con.execute("DELETE FROM subscriptions WHERE device=?", (dev_id,))
        except Exception:
            pass
        con.commit()


# ---------- beheerder ----------

def admin_login(password: str) -> str | None:
    if not ENABLED or not hmac.compare_digest(password.encode(), ADMIN_PASSWORD.encode()):
        return None
    token = secrets.token_urlsafe(32)
    with db._lock:
        db.con().execute("DELETE FROM admin_sessions WHERE expires < ?", (time.time(),))
        db.con().execute("INSERT INTO admin_sessions(token_hash, expires) VALUES(?,?)", (_h(token), time.time() + ADMIN_HOURS * 3600))
        db.con().commit()
    return token


def is_admin(token: str | None) -> bool:
    if not token:
        return False
    return db.con().execute("SELECT 1 FROM admin_sessions WHERE token_hash=? AND expires >= ?",
                            (_h(token), time.time())).fetchone() is not None


def admin_logout(token: str | None):
    if token:
        with db._lock:
            db.con().execute("DELETE FROM admin_sessions WHERE token_hash=?", (_h(token),))
            db.con().commit()
