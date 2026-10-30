import json
import logging
import threading
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import db, pipeline, security, settings, watchers

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
log = logging.getLogger("radar")
STATIC = Path(__file__).parent / "static"


def worker():
    last_news = last_security = 0.0
    while True:
        if time.time() - last_news >= settings.INTERVAL_SECONDS:
            try:
                pipeline.run_once()
                db.set_state("last_run", pipeline.iso(pipeline.now()))
            except Exception as e:
                log.warning("run mislukt: %s", e)
            last_news = time.time()
        if time.time() - last_security >= 900:  # elk kwartier
            security.run_once(settings.load())
            last_security = time.time()
        try:
            watchers.run_once(settings.load())  # eigen interval per wachter
        except Exception as e:
            log.warning("paginawachters mislukt: %s", e)
        time.sleep(60)


@asynccontextmanager
async def lifespan(app):
    db.con()
    threading.Thread(target=worker, daemon=True).start()
    yield


app = FastAPI(title="Nieuwsradar", lifespan=lifespan)

CAT_LABELS = {"it": "IT-security", "tech": "Tech", "nl": "Nederland", "kerk": "Kerk", "il": "Israël", "world": "Wereld"}


def _sources(cid):
    rows = db.con().execute(
        "SELECT id, feed_title, site, origin, url, title, published_at FROM entries WHERE cluster_id=? ORDER BY published_at",
        (cid,),
    ).fetchall()
    return [dict(r) for r in rows]


def _card(c, with_sources=False):
    src = _sources(c["id"])
    first_text = db.con().execute(
        "SELECT text FROM entries WHERE cluster_id=? ORDER BY published_at LIMIT 1", (c["id"],)
    ).fetchone()
    teaser = c["summary"] or c.get("teaser_nl") or ((first_text["text"][:220] + "…") if first_text and first_text["text"] else "")
    out = {
        "id": c["id"],
        "title": c.get("title_nl") or c["title"],
        "originalTitle": c["title"] if c.get("title_nl") else None,
        "category": c["category"],
        "categoryLabel": CAT_LABELS.get(c["category"], c["category"]),
        "status": c["status"],
        "independent": c["n_sources"],
        "articles": len(src),
        "image": c["image"],
        "teaser": teaser,
        "updatedAt": c["updated_at"],
        "createdAt": c["created_at"],
        "pushed": bool(c["pushed"]),
        "critical": bool(c["critical"]),
        "lead": ", ".join(dict.fromkeys(s["feed_title"] for s in src))[:60],
    }
    if with_sources:
        extra = json.loads(c["facts"] or "{}") if (c["facts"] or "").startswith("{") else {}
        out.update({
            "summary": c["summary"],
            "facts": extra.get("facts", []),
            "disputed": extra.get("disputed", []),
            "pushReason": c["push_reason"],
            "maxCvss": c["max_cvss"],
            "watchHits": json.loads(c["watch_hits"] or "[]"),
            "sources": src,
            "hidden": bool(c.get("hidden")),
            "hideReason": c.get("hide_reason"),
        })
    return out


@app.get("/api/clusters")
def list_clusters(cat: str = "all", q: str = "", limit: int = 60):
    sql = "SELECT * FROM clusters WHERE 1=1"
    args = []
    sql += " AND COALESCE(hidden, 0) = 1" if cat == "hidden" else " AND COALESCE(hidden, 0) = 0"
    if cat in ("all", "hidden"):
        pass
    elif cat == "ok":
        sql += " AND status != 'waiting'"
    else:
        sql += " AND category=?"
        args.append(cat)
    if q:
        sql += " AND (title_nl LIKE ? OR id IN (SELECT cluster_id FROM entries WHERE title LIKE ? OR text LIKE ?))"
        args += [f"%{q}%", f"%{q}%", f"%{q}%"]
    # Belangrijkste eerst: kritiek, dan bevestigd met veel bronnen, dan recent
    sql += " ORDER BY critical DESC, (status='waiting') ASC, date(updated_at) DESC, n_sources DESC, updated_at DESC LIMIT ?"
    args.append(min(limit, 200))
    return [_card(dict(r)) for r in db.con().execute(sql, args).fetchall()]


@app.get("/api/clusters/{cid}")
def get_cluster(cid: int):
    r = db.con().execute("SELECT * FROM clusters WHERE id=?", (cid,)).fetchone()
    if not r:
        raise HTTPException(404)
    return _card(dict(r), with_sources=True)


class HideBody(BaseModel):
    hidden: bool


@app.post("/api/clusters/{cid}/hide")
def hide_cluster(cid: int, body: HideBody):
    """Niet interessant (leert ervan) of terugzetten."""
    con = db.con()
    r = con.execute("SELECT id, title, title_nl, centroid FROM clusters WHERE id=?", (cid,)).fetchone()
    if not r:
        raise HTTPException(404)
    with db._lock:
        if body.hidden:
            con.execute("UPDATE clusters SET hidden=1, hide_manual=1, hide_reason='zelf verborgen' WHERE id=?", (cid,))
            con.execute("INSERT OR IGNORE INTO negatives(cluster_id, title, vec, at) VALUES(?,?,?,datetime('now'))",
                        (cid, r["title_nl"] or r["title"], r["centroid"]))
        else:
            con.execute("UPDATE clusters SET hidden=0, hide_manual=-1, hide_reason=NULL WHERE id=?", (cid,))
            con.execute("DELETE FROM negatives WHERE cluster_id=?", (cid,))
        con.commit()
    return {"ok": True}


@app.get("/api/filters")
def get_filters():
    f = settings.load().get("filters") or {}
    negs = db.con().execute("SELECT id, cluster_id, title, at FROM negatives ORDER BY at DESC").fetchall()
    hidden = db.con().execute("SELECT COUNT(*) FROM clusters WHERE hidden=1").fetchone()[0]
    return {"keywords": f.get("keywords") or [], "similarity": f.get("similarity", 0.72),
            "learned": [dict(n) for n in negs], "hiddenCount": hidden}


@app.delete("/api/filters/learned/{nid}")
def forget_learned(nid: int):
    con = db.con()
    with db._lock:
        row = con.execute("SELECT cluster_id FROM negatives WHERE id=?", (nid,)).fetchone()
        con.execute("DELETE FROM negatives WHERE id=?", (nid,))
        # verhalen die alleen hierdoor verborgen waren, komen bij de volgende ronde vanzelf terug
        con.execute("UPDATE clusters SET hidden=0, hide_reason=NULL WHERE hide_manual=0 AND hidden=1 AND hide_reason LIKE 'lijkt op%'")
        if row:
            con.execute("UPDATE clusters SET hidden=0, hide_manual=0, hide_reason=NULL WHERE id=?", (row["cluster_id"],))
        con.commit()
    return {"ok": True}


@app.get("/api/entries/{eid}/text")
def entry_text(eid: int, full: bool = True):
    """Tekst van één artikel. Met full=true laat Miniflux de volledige pagina ophalen (eenmalig, daarna uit cache)."""
    import httpx
    from .text import html_to_text
    con = db.con()
    r = con.execute("SELECT id, text, full_text, url FROM entries WHERE id=?", (eid,)).fetchone()
    if not r:
        raise HTTPException(404)
    if r["full_text"]:
        return {"text": r["full_text"], "full": True, "url": r["url"]}
    if full and settings.MINIFLUX_API_KEY:
        try:
            resp = httpx.get(f"{settings.MINIFLUX_URL}/v1/entries/{eid}/fetch-content",
                             headers={"X-Auth-Token": settings.MINIFLUX_API_KEY}, timeout=30)
            resp.raise_for_status()
            text = html_to_text(resp.json().get("content", ""))
            if len(text) > len(r["text"] or "") + 200:  # alleen bewaren als het echt meer is
                with db._lock:
                    con.execute("UPDATE entries SET full_text=? WHERE id=?", (text, eid))
                    con.commit()
                return {"text": text, "full": True, "url": r["url"]}
        except Exception as e:
            log.warning("volledige tekst ophalen mislukt (%s): %s", eid, e)
    return {"text": r["text"] or "", "full": False, "url": r["url"]}


@app.get("/api/alerts")
def alerts(limit: int = 20):
    rows = db.con().execute("SELECT * FROM alerts ORDER BY at DESC LIMIT ?", (min(limit, 100),)).fetchall()
    return [dict(r) for r in rows]


RULE_LABELS = {
    "kev": ("Actief misbruikt lek", "CVE in CISA KEV-catalogus"),
    "ncsc_high_high": ("NCSC-advies hoog/hoog", "Kans en schade beide “H”"),
    "watchlist": ("Trefwoord op watchlist", "Plus CERT/NCSC-bron of hoge CVSS"),
    "big_news": ("Groot nieuws", "Veel onafhankelijke bronnen in korte tijd"),
    "categories": ("Rubrieken", "Elk bevestigd verhaal in gekozen rubrieken"),
}


@app.get("/api/settings")
def get_settings():
    cfg = settings.load()
    rules = [
        {"id": k, "label": RULE_LABELS.get(k, (k, ""))[0], "hint": RULE_LABELS.get(k, (k, ""))[1], "enabled": bool(v.get("enabled"))}
        for k, v in (cfg.get("push") or {}).items()
    ]
    return {
        "rules": rules,
        "watchlist": cfg.get("watchlist", []),
        "ntfyTopic": settings.NTFY_TOPIC,
        "lastRun": db.get_state("last_run"),
    }


class RuleToggle(BaseModel):
    enabled: bool


@app.put("/api/rules/{rule}")
def toggle_rule(rule: str, body: RuleToggle):
    if rule not in RULE_LABELS:
        raise HTTPException(404)
    o = db.get_state("push_overrides", {}) or {}
    o[rule] = body.enabled
    db.set_state("push_overrides", o)
    return {"ok": True}


@app.get("/api/watchers")
def get_watchers():
    return watchers.status(settings.load())


@app.post("/api/watchers/test")
def test_watchers():
    """Controleer alle wachters nu en stuur de huidige tekst als testmelding."""
    from . import push
    out = []
    for w in settings.load().get("watchers") or []:
        st = watchers.check(w, force=True) or {}
        lines = (st.get("text") or "").splitlines()
        if lines:
            push.send(f"[test] {w['name']}: {lines[0]}", "\n".join(lines[1:]), click=w["url"], priority=2, topic="watch:" + w["name"])
        out.append({"name": w["name"], "found": bool(lines)})
    return out


class Subscription(BaseModel):
    subscription: dict
    label: str = ""


class Endpoint(BaseModel):
    endpoint: str


@app.get("/api/push/key")
def push_key():
    from . import webpush
    return {"publicKey": webpush.public_key(), "devices": webpush.count(), "ntfy": bool(settings.NTFY_URL)}


@app.post("/api/push/subscribe")
def push_subscribe(body: Subscription):
    from . import webpush
    try:
        webpush.subscribe(body.subscription, body.label)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"ok": True, "devices": webpush.count()}


@app.post("/api/push/unsubscribe")
def push_unsubscribe(body: Endpoint):
    from . import webpush
    webpush.unsubscribe(body.endpoint)
    return {"ok": True}


class Prefs(BaseModel):
    endpoint: str
    prefs: dict | None = None


@app.post("/api/push/prefs")
def push_prefs(body: Prefs):
    """Zonder prefs: huidige voorkeuren opvragen. Met prefs: opslaan."""
    from . import webpush
    if body.prefs is not None:
        webpush.set_prefs(body.endpoint, body.prefs)
    cur = webpush.get_prefs(body.endpoint)
    if cur is None:
        raise HTTPException(404, "onbekend apparaat")
    return {"prefs": cur, "watchers": [w["name"] for w in settings.load().get("watchers") or []]}


@app.post("/api/push/test")
def push_test(body: Endpoint):
    from . import webpush
    n = webpush.send("NieuwsRadar", "Meldingen werken op dit apparaat.", url="/", priority=3, endpoint=body.endpoint)
    return {"sent": n}


@app.get("/health")
def health():
    return {"ok": True}


@app.get("/")
def index():
    return FileResponse(STATIC / "index.html")


@app.get("/sw.js")
def sw():  # service worker moet vanaf de root geserveerd worden
    return FileResponse(STATIC / "sw.js", media_type="application/javascript", headers={"Cache-Control": "no-cache"})


@app.get("/manifest.webmanifest")
def manifest():
    return FileResponse(STATIC / "manifest.webmanifest", media_type="application/manifest+json")


app.mount("/static", StaticFiles(directory=STATIC), name="static")
