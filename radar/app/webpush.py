"""Web Push naar de PWA (VAPID). Sleutels worden bij de eerste start aangemaakt en in de database bewaard."""
import base64
import json
import logging
from datetime import datetime, timezone

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from py_vapid import Vapid
from pywebpush import WebPushException, webpush

from . import db, settings

log = logging.getLogger("radar.webpush")

db.con().executescript("""
CREATE TABLE IF NOT EXISTS subscriptions (
  endpoint TEXT PRIMARY KEY, data TEXT, label TEXT, created_at TEXT
);
""")
if "prefs" not in [r[1] for r in db.con().execute("PRAGMA table_info(subscriptions)")]:
    db.con().execute("ALTER TABLE subscriptions ADD COLUMN prefs TEXT")
    db.con().commit()

# Standaard: alles aan. "watchers": "all" of een lijst met namen van paginawachters.
DEFAULT_PREFS = {"news": True, "security": True, "watchers": "all"}


def wants(prefs: dict | None, topic: str | None) -> bool:
    p = {**DEFAULT_PREFS, **(prefs or {})}
    if not topic:
        return True
    if topic.startswith("watch:"):
        w = p.get("watchers")
        return w == "all" or (isinstance(w, list) and topic[6:] in w)
    return bool(p.get(topic, True))


def get_prefs(endpoint: str) -> dict | None:
    r = db.con().execute("SELECT prefs FROM subscriptions WHERE endpoint=?", (endpoint,)).fetchone()
    if not r:
        return None
    return {**DEFAULT_PREFS, **json.loads(r["prefs"] or "{}")}


def set_prefs(endpoint: str, prefs: dict):
    clean = {"news": bool(prefs.get("news", True)), "security": bool(prefs.get("security", True))}
    w = prefs.get("watchers", "all")
    clean["watchers"] = "all" if w == "all" else [str(x) for x in (w or [])][:50]
    db.con().execute("UPDATE subscriptions SET prefs=? WHERE endpoint=?", (json.dumps(clean), endpoint))
    db.con().commit()


def _b64url(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def _keys():
    k = db.get_state("vapid")
    if not k:
        priv = ec.generate_private_key(ec.SECP256R1())
        pem = priv.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                 serialization.NoEncryption()).decode()
        pub = priv.public_key().public_bytes(serialization.Encoding.X962,
                                             serialization.PublicFormat.UncompressedPoint)
        k = {"private_pem": pem, "public": _b64url(pub)}
        db.set_state("vapid", k)
        log.info("nieuwe VAPID-sleutels aangemaakt")
    return k


def public_key() -> str:
    return _keys()["public"]


def subscribe(sub: dict, label: str = ""):
    if not sub.get("endpoint", "").startswith("https://"):
        raise ValueError("ongeldig endpoint")
    db.con().execute(
        "INSERT INTO subscriptions(endpoint, data, label, created_at) VALUES(?,?,?,?) "
        "ON CONFLICT(endpoint) DO UPDATE SET data=excluded.data, label=excluded.label",
        (sub["endpoint"], json.dumps(sub), label[:80], datetime.now(timezone.utc).isoformat(timespec="seconds")),
    )
    db.con().commit()


def unsubscribe(endpoint: str):
    db.con().execute("DELETE FROM subscriptions WHERE endpoint=?", (endpoint,))
    db.con().commit()


def count() -> int:
    return db.con().execute("SELECT COUNT(*) FROM subscriptions").fetchone()[0]


def send(title: str, body: str, url: str | None = None, priority: int = 3, tag: str | None = None,
         endpoint: str | None = None, topic: str | None = None) -> int:
    """Stuur naar alle apparaten die dit onderwerp willen (of naar één endpoint)."""
    rows = db.con().execute(
        "SELECT endpoint, data, prefs FROM subscriptions" + (" WHERE endpoint=?" if endpoint else ""),
        ((endpoint,) if endpoint else ()),
    ).fetchall()
    if not endpoint:
        rows = [r for r in rows if wants(json.loads(r["prefs"] or "{}"), topic)]
    if not rows:
        return 0
    vapid = Vapid.from_pem(_keys()["private_pem"].encode())
    subject = settings.VAPID_SUBJECT
    payload = json.dumps({"title": title[:200], "body": body[:1500], "url": url or "/", "priority": priority, "tag": tag})
    ok = 0
    for r in rows:
        try:
            webpush(
                subscription_info=json.loads(r["data"]),
                data=payload,
                vapid_private_key=vapid,
                vapid_claims={"sub": subject},
                ttl=86400,
                headers={"Urgency": "high" if priority >= 4 else "normal"},
                timeout=15,
            )
            ok += 1
        except WebPushException as e:
            status = getattr(e.response, "status_code", None)
            if status in (404, 410):  # abonnement verlopen of ingetrokken
                unsubscribe(r["endpoint"])
            else:
                log.warning("web push mislukt (%s): %s", status, e)
        except Exception as e:
            log.warning("web push mislukt: %s", e)
    return ok
