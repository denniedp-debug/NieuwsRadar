"""Directe bronnen voor beveiligingsmeldingen: CISA KEV en NCSC-adviezen."""
import logging
import re
from datetime import datetime, timezone

import feedparser
import httpx

from . import db, push, settings
from .text import watch_hits

log = logging.getLogger("radar.security")
_NCSC_LEVEL = re.compile(r"\[(H|M|L)/(H|M|L)\]")


def _seen(key: str) -> bool:
    return db.con().execute("SELECT 1 FROM alerts WHERE key=?", (key,)).fetchone() is not None


def _record(key, kind, title, message, url):
    db.con().execute(
        "INSERT OR IGNORE INTO alerts(key, kind, title, message, url, at) VALUES(?,?,?,?,?,?)",
        (key, kind, title, message, url, datetime.now(timezone.utc).isoformat(timespec="seconds")),
    )
    db.con().commit()


def check_kev(cfg: dict):
    rule = (cfg.get("push") or {}).get("kev") or {}
    url = (cfg.get("security_feeds") or {}).get("kev_url")
    if not url:
        return
    data = httpx.get(url, timeout=60).json()
    vulns = data.get("vulnerabilities", [])
    first_run = db.get_state("kev_initialized") is None
    for v in vulns:
        key = "kev:" + v["cveID"]
        if _seen(key):
            continue
        title = f"{v['cveID']}: {v.get('vendorProject', '')} {v.get('product', '')}".strip()
        msg = f"Actief misbruikt (CISA KEV). {v.get('vulnerabilityName', '')}. {v.get('shortDescription', '')}"
        link = f"https://nvd.nist.gov/vuln/detail/{v['cveID']}"
        hits = watch_hits(f"{v.get('vendorProject', '')} {v.get('product', '')} {v.get('vulnerabilityName', '')}", cfg.get("watchlist"))
        should_push = (not first_run) and rule.get("enabled") and (hits or not rule.get("only_watchlist", True))
        if should_push:
            push.send("Actief misbruikt: " + title, msg, click=link, priority=5, tags=["rotating_light"], topic="security")
        _record(key, "kev", title, msg, link)
    db.set_state("kev_initialized", True)  # eerste run: alleen vastleggen, niet spammen


def check_ncsc(cfg: dict):
    rule = (cfg.get("push") or {}).get("ncsc_high_high") or {}
    url = (cfg.get("security_feeds") or {}).get("ncsc_rss")
    if not url:
        return
    feed = feedparser.parse(httpx.get(url, timeout=60).content)
    first_run = db.get_state("ncsc_initialized") is None
    for item in feed.entries:
        key = "ncsc:" + (item.get("id") or item.get("link") or item.get("title"))
        if _seen(key):
            continue
        title = item.get("title", "")
        m = _NCSC_LEVEL.search(title)
        high_high = bool(m and m.group(1) == "H" and m.group(2) == "H")
        if high_high and rule.get("enabled") and not first_run:
            push.send("NCSC H/H: " + title, item.get("summary", "")[:500], click=item.get("link"), priority=5, tags=["warning"], topic="security")
        _record(key, "ncsc", title, item.get("summary", "")[:500], item.get("link"))
    db.set_state("ncsc_initialized", True)


def run_once(cfg: dict):
    for fn in (check_kev, check_ncsc):
        try:
            fn(cfg)
        except Exception as e:
            log.warning("%s mislukt: %s", fn.__name__, e)
