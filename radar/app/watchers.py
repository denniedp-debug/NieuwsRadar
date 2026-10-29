"""Paginawachters: stuur een melding zodra een deel van een webpagina verandert."""
import hashlib
import logging
import re
import time
from datetime import datetime, timezone

import httpx
from bs4 import BeautifulSoup

from . import db, push

log = logging.getLogger("radar.watchers")
UA = "Mozilla/5.0 (Nieuwsradar paginawachter)"


def extract_text(html: str, selector: str | None) -> str:
    """Leesbare tekst van het gekozen blok: tabelrijen op één regel, alinea's en <br> als nieuwe regel."""
    soup = BeautifulSoup(html, "html.parser")
    node = soup.select_one(selector) if selector else soup.body
    if node is None:
        return ""
    for s in node.select("script, style, noscript"):
        s.decompose()
    for br in node.find_all("br"):
        br.replace_with("\n")
    for tr in node.find_all("tr"):
        cells = [c.get_text(" ", strip=True) for c in tr.find_all(["td", "th"])]
        tr.replace_with("\n\x01" + " ".join(c for c in cells if c) + "\n")
    for blk in node.find_all(["p", "div", "li", "h1", "h2", "h3", "h4", "table"]):
        blk.insert_before("\n")
        blk.insert_after("\n")
    lines = [re.sub(r"[ \t\xa0]+", " ", ln).strip() for ln in node.get_text().splitlines()]
    out, blank = [], False
    for ln in lines:
        if ln:
            # tabelrijen direct onder elkaar, zonder lege regel ertussen
            if ln.startswith("\x01") and len(out) >= 2 and out[-1] == "" and out[-2].startswith("\x01"):
                out.pop()
            out.append(ln)
            blank = False
        elif out and not blank:
            out.append("")
            blank = True
    return "\n".join(out).replace("\x01", "").strip()


def check(w: dict, force=False) -> dict | None:
    key = "watch:" + w["url"] + "|" + (w.get("selector") or "")
    st = db.get_state(key, {}) or {}
    interval = float(w.get("interval_minutes", 15)) * 60
    if not force and time.time() - st.get("checked", 0) < interval:
        return None
    r = httpx.get(w["url"], headers={"User-Agent": UA}, timeout=30, follow_redirects=True)
    r.raise_for_status()
    text = extract_text(r.text, w.get("selector"))
    st["checked"] = time.time()
    if not text:
        log.warning("paginawachter %s: selector '%s' niet gevonden", w.get("name"), w.get("selector"))
        db.set_state(key, st)
        return None
    digest = hashlib.sha256(text.encode()).hexdigest()
    changed = st.get("hash") not in (None, digest)
    first = st.get("hash") is None
    st.update({"hash": digest, "text": text})
    if changed or (first and w.get("notify_on_first")):
        st["changed"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
        lines = text.splitlines()
        if w.get("title_from_first_line", True) and lines:
            title, body = f"{w['name']}: {lines[0]}", "\n".join(lines[1:]).strip()
        else:
            title, body = w["name"], text
        push.send(title, body or text, click=w["url"], priority=int(w.get("priority", 3)), tags=w.get("tags") or ["bell"])
        db.con().execute(
            "INSERT OR REPLACE INTO alerts(key, kind, title, message, url, at) VALUES(?,?,?,?,?,?)",
            (f"{key}|{digest[:12]}", "watch", title, body, w["url"], st["changed"]),
        )
        db.con().commit()
    db.set_state(key, st)
    return st


def run_once(cfg: dict):
    for w in cfg.get("watchers") or []:
        if not w.get("enabled", True):
            continue
        try:
            check(w)
        except Exception as e:
            log.warning("paginawachter %s mislukt: %s", w.get("name"), e)


def status(cfg: dict) -> list[dict]:
    out = []
    for w in cfg.get("watchers") or []:
        st = db.get_state("watch:" + w["url"] + "|" + (w.get("selector") or ""), {}) or {}
        out.append({"name": w["name"], "url": w["url"], "text": st.get("text"), "changed": st.get("changed"),
                    "checked": st.get("checked"), "enabled": w.get("enabled", True)})
    return out
