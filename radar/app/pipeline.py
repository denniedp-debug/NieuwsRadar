"""Eén run: nieuwe artikelen uit Miniflux halen, clusteren, bronnen tellen, pushregels toepassen."""
import json
import logging
from datetime import datetime, timedelta, timezone

import httpx
import numpy as np

from . import ai, db, push, settings
from .text import detect_origin, first_image, host, max_cvss, strip_html, watch_hits

log = logging.getLogger("radar.pipeline")


def now() -> datetime:
    return datetime.now(timezone.utc)


def iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat(timespec="seconds")


# --- Miniflux ---------------------------------------------------------------

def fetch_new_entries(limit_total=500) -> list[dict]:
    headers = {"X-Auth-Token": settings.MINIFLUX_API_KEY}
    last_id = db.get_state("last_entry_id")
    out = []
    params = {"order": "id", "direction": "asc", "limit": 100}
    if last_id:
        params["after_entry_id"] = last_id
    else:  # eerste run: alleen de laatste 48 uur
        params["after"] = int((now() - timedelta(hours=48)).timestamp())
    with httpx.Client(base_url=settings.MINIFLUX_URL, headers=headers, timeout=30) as c:
        while len(out) < limit_total:
            r = c.get("/v1/entries", params=params)
            r.raise_for_status()
            batch = r.json().get("entries") or []
            if not batch:
                break
            out.extend(batch)
            params.pop("after", None)
            params["after_entry_id"] = batch[-1]["id"]
            if len(batch) < params["limit"]:
                break
    return out


def normalize(e: dict, cfg: dict) -> dict:
    feed = e.get("feed") or {}
    cat_title = ((feed.get("category") or {}).get("title")) or ""
    category = (cfg.get("categories") or {}).get(cat_title, "world")
    text = strip_html(e.get("content", ""))
    site = host(feed.get("site_url") or e.get("url"))
    return {
        "id": e["id"],
        "title": (e.get("title") or "").strip(),
        "url": e.get("url"),
        "text": text,
        "image": first_image(e.get("content", ""), e.get("enclosures")),
        "feed_title": feed.get("title") or site,
        "site": site,
        "category": category,
        "origin": detect_origin(text, site, cfg.get("wire_services")),
        "is_official": 1 if category == "official" else 0,
        "published_at": e.get("published_at") or iso(now()),
    }


# --- Clustering ---------------------------------------------------------------

def open_clusters(window_hours: int):
    since = iso(now() - timedelta(hours=window_hours))
    rows = db.con().execute(
        "SELECT id, centroid, n_entries FROM clusters WHERE updated_at >= ?", (since,)
    ).fetchall()
    return [(r["id"], db.blob_to_vec(r["centroid"]), r["n_entries"]) for r in rows]


def assign(entry: dict, vec: np.ndarray, clusters: list, threshold: float) -> int:
    con = db.con()
    best_id, best_sim, best_idx = None, -1.0, -1
    for i, (cid, cvec, _) in enumerate(clusters):
        sim = float(np.dot(vec, cvec))
        if sim > best_sim:
            best_id, best_sim, best_idx = cid, sim, i
    ts = iso(now())
    if best_id is not None and best_sim >= threshold:
        cid, cvec, n = clusters[best_idx]
        new = (cvec * n + vec) / (n + 1)
        new = new / (np.linalg.norm(new) or 1)
        clusters[best_idx] = (cid, new, n + 1)
        con.execute(
            "UPDATE clusters SET centroid=?, n_entries=n_entries+1, updated_at=?, image=COALESCE(image, ?) WHERE id=?",
            (db.vec_to_blob(new), ts, entry["image"], cid),
        )
        return cid
    cur = con.execute(
        "INSERT INTO clusters(title, category, image, created_at, updated_at, centroid, n_entries) VALUES(?,?,?,?,?,?,1)",
        (entry["title"], entry["category"], entry["image"], ts, ts, db.vec_to_blob(vec)),
    )
    cid = cur.lastrowid
    clusters.append((cid, vec, 1))
    return cid


def refresh_cluster(cid: int, cfg: dict) -> dict:
    con = db.con()
    rows = con.execute("SELECT * FROM entries WHERE cluster_id=? ORDER BY published_at", (cid,)).fetchall()
    origins = {r["origin"] for r in rows}
    has_official = any(r["is_official"] for r in rows)
    cats = [r["category"] for r in rows if r["category"] != "official"]
    category = max(set(cats), key=cats.count) if cats else "it"
    alltext = " ".join(f"{r['title']} {r['text']}" for r in rows)
    cvss = max_cvss(alltext)
    hits = watch_hits(alltext, cfg.get("watchlist"))
    min_src = (cfg.get("clustering") or {}).get("confirmed_min_sources", 2)
    if len(origins) >= min_src:
        status = "confirmed"
    elif has_official:
        status = "official"
    else:
        status = "waiting"
    # titel: die van de eerste niet-persbureau-bron, anders de eerste
    title = next((r["title"] for r in rows if r["origin"] == r["site"]), rows[0]["title"])
    con.execute(
        "UPDATE clusters SET n_sources=?, has_official=?, category=?, max_cvss=?, watch_hits=?, status=?, title=? WHERE id=?",
        (len(origins), int(has_official), category, cvss, json.dumps(hits), status, title, cid),
    )
    return dict(con.execute("SELECT * FROM clusters WHERE id=?", (cid,)).fetchone())


def maybe_summarize(c: dict):
    if not settings.LLM_MODEL or c["status"] == "waiting" or c["summarized_sources"] == c["n_sources"]:
        return
    rows = db.con().execute(
        "SELECT feed_title, title, text FROM entries WHERE cluster_id=? ORDER BY published_at", (c["id"],)
    ).fetchall()
    res = ai.summarize([{"source": r["feed_title"], "title": r["title"], "text": r["text"]} for r in rows])
    if res:
        db.con().execute(
            "UPDATE clusters SET summary=?, facts=?, summarized_sources=? WHERE id=?",
            (res["summary"], json.dumps({"facts": res["facts"], "disputed": res["disputed"]}), c["n_sources"], c["id"]),
        )


def maybe_translate(c: dict) -> dict:
    """Engelstalige verhalen krijgen een Nederlandse kop en inleiding (origineel blijft bewaard)."""
    if not (settings.TRANSLATE and settings.TRANSLATE_MODEL):
        return c
    if c.get("translated_title") == c["title"]:
        return c  # al vertaald (of al beoordeeld) voor deze kop
    first = db.con().execute(
        "SELECT text FROM entries WHERE cluster_id=? ORDER BY published_at LIMIT 1", (c["id"],)
    ).fetchone()
    teaser = (first["text"] if first else "")[:400]
    if not ai.is_english(f"{c['title']} {teaser}"):
        db.con().execute("UPDATE clusters SET lang='nl', translated_title=? WHERE id=?", (c["title"], c["id"]))
        return c
    res = ai.translate(c["title"], teaser)
    if res:
        db.con().execute(
            "UPDATE clusters SET lang='en', title_nl=?, teaser_nl=?, translated_title=? WHERE id=?",
            (res["title"], res["teaser"], c["title"], c["id"]),
        )
        c = {**c, "title_nl": res["title"], "teaser_nl": res["teaser"], "lang": "en"}
    return c


def display_title(c: dict) -> str:
    return c.get("title_nl") or c["title"]


# --- Pushregels voor clusters ------------------------------------------------

def push_reason(c: dict, cfg: dict) -> tuple[str, bool] | None:
    rules = cfg.get("push") or {}
    hits = json.loads(c["watch_hits"] or "[]")
    w = rules.get("watchlist") or {}
    if w.get("enabled") and hits and c["status"] != "waiting":
        if c["has_official"]:
            return f"Watchlist ({', '.join(hits)}) + officieel advies", True
        if c["max_cvss"] is not None and c["max_cvss"] >= float(w.get("min_cvss", 9.0)):
            return f"Watchlist ({', '.join(hits)}) + CVSS {c['max_cvss']}", True
    b = rules.get("big_news") or {}
    if b.get("enabled") and c["n_sources"] >= int(b.get("min_sources", 4)):
        created = datetime.fromisoformat(c["created_at"])
        if now() - created <= timedelta(hours=float(b.get("within_hours", 6))):
            return f"Groot nieuws: {c['n_sources']} onafhankelijke bronnen", False
    k = rules.get("categories") or {}
    if k.get("enabled") and c["status"] == "confirmed" and c["category"] in (k.get("list") or []):
        return f"Bevestigd nieuws in rubriek {c['category']}", False
    return None


def maybe_push(c: dict, cfg: dict):
    if c["pushed"]:
        return
    res = push_reason(c, cfg)
    if not res:
        return
    reason, critical = res
    ok = push.send(
        title=("Kritiek: " if critical else "") + display_title(c),
        message=f"{reason}. Bevestigd door {c['n_sources']} onafhankelijke bron(nen).",
        click=f"{settings.PUBLIC_URL}/#/c/{c['id']}",
        priority=5 if critical else 4,
        tags=["rotating_light"] if critical else ["newspaper"],
        topic="security" if critical else "news",
    )
    if ok:
        db.con().execute(
            "UPDATE clusters SET pushed=1, push_reason=?, critical=? WHERE id=?", (reason, int(critical), c["id"])
        )


# --- De run -------------------------------------------------------------------

def translate_backlog(limit: int):
    """Oudere, nog niet beoordeelde verhalen van de laatste 48 uur alsnog vertalen."""
    if not (settings.TRANSLATE and settings.TRANSLATE_MODEL) or limit <= 0:
        return
    since = iso(now() - timedelta(hours=48))
    rows = db.con().execute(
        "SELECT * FROM clusters WHERE updated_at >= ? AND (translated_title IS NULL OR translated_title != title) "
        "ORDER BY updated_at DESC LIMIT ?", (since, limit),
    ).fetchall()
    for r in rows:
        maybe_translate(dict(r))
        db.con().commit()


def run_once():
    cfg = settings.load()
    cl = cfg.get("clustering") or {}
    raw = fetch_new_entries()
    if not raw:
        translate_backlog(settings.TRANSLATE_PER_RUN)
        return 0
    entries = [normalize(e, cfg) for e in raw if e.get("title")]
    clusters = open_clusters(int(cl.get("window_hours", 48)))
    touched = set()
    con = db.con()
    for i in range(0, len(entries), 16):
        chunk = entries[i:i + 16]
        vecs = ai.embed([f"{e['title']}. {e['text'][:800]}" for e in chunk])
        with db._lock:
            for e, v in zip(chunk, vecs):
                if con.execute("SELECT 1 FROM entries WHERE id=?", (e["id"],)).fetchone():
                    continue
                cid = assign(e, v, clusters, float(cl.get("similarity", 0.82)))
                con.execute(
                    "INSERT INTO entries(id, cluster_id, title, url, text, image, feed_title, site, category, origin, is_official, published_at)"
                    " VALUES(:id, :cid, :title, :url, :text, :image, :feed_title, :site, :category, :origin, :is_official, :published_at)",
                    {**e, "cid": cid},
                )
                touched.add(cid)
            con.commit()
        db.set_state("last_entry_id", chunk[-1]["id"])
    translated = 0
    for cid in touched:
        c = refresh_cluster(cid, cfg)
        maybe_summarize(c)
        if translated < settings.TRANSLATE_PER_RUN and c.get("translated_title") != c["title"]:
            c = maybe_translate(c)
            translated += 1
        maybe_push(c, cfg)
        con.commit()
    log.info("%d artikelen verwerkt, %d verhalen bijgewerkt", len(entries), len(touched))
    return len(entries)
