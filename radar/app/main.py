import json
import logging
import threading
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import auth, db, pipeline, security, settings, watchers

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
log = logging.getLogger("radar")
STATIC = Path(__file__).parent / "static"


def cleanup():
    """Verhalen ouder dan RETENTION_DAYS (en hun artikelen/leesstatus) verwijderen."""
    from datetime import timedelta
    since = pipeline.iso(pipeline.now() - timedelta(days=settings.RETENTION_DAYS))
    con = db.con()
    with db._lock:
        old = [r[0] for r in con.execute("SELECT id FROM clusters WHERE updated_at < ?", (since,))]
        for i in range(0, len(old), 500):
            ids = old[i:i + 500]
            q = ",".join("?" * len(ids))
            con.execute(f"DELETE FROM entries WHERE cluster_id IN ({q})", ids)
            con.execute(f"DELETE FROM reads WHERE cluster_id IN ({q})", ids)
            con.execute(f"DELETE FROM clusters WHERE id IN ({q})", ids)
        con.commit()
        if old:
            con.execute("VACUUM")
    if old:
        log.info("opgeruimd: %d oude verhalen", len(old))


def morning_digest(force: bool = False) -> int:
    """Eén melding per ochtend met de best bevestigde verhalen van de afgelopen 12 uur."""
    from datetime import datetime, timedelta
    from zoneinfo import ZoneInfo
    from . import push
    if not settings.MORNING_TIME and not force:
        return 0
    local = datetime.now(ZoneInfo("Europe/Amsterdam"))
    today = local.date().isoformat()
    if not force:
        try:
            hh, mm = (int(x) for x in settings.MORNING_TIME.split(":"))
        except ValueError:
            return 0
        if (local.hour, local.minute) < (hh, mm) or db.get_state("morning_sent") == today:
            return 0
        if (local.hour * 60 + local.minute) - (hh * 60 + mm) > 180:  # server lag uit: niet om 14:00 nog sturen
            db.set_state("morning_sent", today)
            return 0
    since = pipeline.iso(pipeline.now() - timedelta(hours=12))
    if force:
        today = None  # test: niet als "verstuurd" markeren
    rows = db.con().execute(
        "SELECT * FROM clusters WHERE updated_at >= ? AND status != 'waiting' AND COALESCE(hidden,0)=0 "
        "ORDER BY critical DESC, n_sources DESC, updated_at DESC LIMIT ?", (since, settings.MORNING_COUNT)).fetchall()
    if today:
        db.set_state("morning_sent", today)
    if not rows:
        return 0
    lines = [f"• {(r['title_nl'] or r['title'])[:110]} ({r['n_sources']} bronnen)" for r in rows]
    push.send(f"Goedemorgen · {len(rows)} bevestigde verhalen", "\n".join(lines),
              click=f"{settings.PUBLIC_URL}/", priority=3, tags=["sunrise"], topic="morning")
    log.info("ochtendoverzicht verstuurd (%d verhalen)", len(rows))
    return len(rows)


def worker():
    last_news = last_security = last_cleanup = 0.0
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
            morning_digest()
        except Exception as e:
            log.warning("ochtendoverzicht mislukt: %s", e)
        if time.time() - last_cleanup >= 6 * 3600:
            try:
                cleanup()
            except Exception as e:
                log.warning("opruimen mislukt: %s", e)
            last_cleanup = time.time()
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

PUBLIC_API = {"/api/me", "/api/pair", "/api/admin/login", "/api/admin/me"}


@app.middleware("http")
async def guard(request: Request, call_next):
    """Alleen gekoppelde apparaten mogen de API gebruiken; /api/admin/* alleen de beheerder."""
    path = request.url.path
    if auth.ENABLED and path.startswith("/api/") and path not in PUBLIC_API:
        if path.startswith("/api/admin/"):
            if not auth.is_admin(request.cookies.get(auth.ADMIN_COOKIE)):
                return JSONResponse({"detail": "beheerder niet ingelogd"}, status_code=401)
        else:
            dev = auth.device_for_token(request.cookies.get(auth.DEVICE_COOKIE))
            if not dev:
                return JSONResponse({"detail": "toestel niet gekoppeld"}, status_code=401)
            request.state.device = dev
    return await call_next(request)


def _device_id(request: Request, fallback: str = "") -> str:
    dev = getattr(request.state, "device", None)
    return dev["id"] if dev else fallback


def _cookie(response: Response, request: Request, name: str, value: str, max_age: int):
    response.set_cookie(name, value, max_age=max_age, httponly=True, samesite="lax",
                        secure=request.url.scheme == "https", path="/")


def _ip(request: Request) -> str:
    return (request.headers.get("x-forwarded-for", "").split(",")[0].strip()
            or (request.client.host if request.client else "?"))


@app.get("/api/me")
def me(request: Request):
    dev = auth.device_for_token(request.cookies.get(auth.DEVICE_COOKIE)) if auth.ENABLED else None
    return {"authEnabled": auth.ENABLED, "paired": (not auth.ENABLED) or bool(dev),
            "device": {"id": dev["id"], "name": dev["name"]} if dev else None}


class PairBody(BaseModel):
    code: str
    name: str = ""
    legacyId: str = ""


@app.post("/api/pair")
def pair(body: PairBody, request: Request, response: Response):
    ip = _ip(request)
    if auth.rate_limited(ip):
        raise HTTPException(429, "Te veel pogingen. Probeer het over een kwartier opnieuw.")
    token = auth.pair(body.code, body.name, body.legacyId, request.headers.get("user-agent", ""))
    if not token:
        auth.failed(ip)
        raise HTTPException(400, "Code onbekend of verlopen.")
    _cookie(response, request, auth.DEVICE_COOKIE, token, 400 * 86400)
    return {"ok": True}


class LoginBody(BaseModel):
    password: str


@app.post("/api/admin/login")
def admin_login(body: LoginBody, request: Request, response: Response):
    ip = _ip(request)
    if auth.rate_limited(ip, limit=5):
        raise HTTPException(429, "Te veel pogingen. Probeer het over een kwartier opnieuw.")
    token = auth.admin_login(body.password)
    if not token:
        auth.failed(ip)
        raise HTTPException(401, "Onjuist wachtwoord." if auth.ENABLED else "ADMIN_PASSWORD is niet ingesteld.")
    _cookie(response, request, auth.ADMIN_COOKIE, token, auth.ADMIN_HOURS * 3600)
    return {"ok": True}


@app.get("/api/admin/me")
def admin_me(request: Request):
    return {"enabled": auth.ENABLED, "admin": auth.is_admin(request.cookies.get(auth.ADMIN_COOKIE))}


@app.post("/api/admin/logout")
def admin_logout(request: Request, response: Response):
    auth.admin_logout(request.cookies.get(auth.ADMIN_COOKIE))
    response.delete_cookie(auth.ADMIN_COOKIE, path="/")
    return {"ok": True}


@app.get("/api/admin/devices")
def admin_devices():
    return auth.list_devices()


class CodeBody(BaseModel):
    name: str = ""


@app.post("/api/admin/codes")
def admin_code(body: CodeBody):
    return {"code": auth.create_code(body.name), "minutes": auth.CODE_MINUTES}


class RenameBody(BaseModel):
    name: str


@app.patch("/api/admin/devices/{dev_id}")
def admin_rename(dev_id: str, body: RenameBody):
    auth.rename_device(dev_id, body.name)
    return {"ok": True}


@app.delete("/api/admin/devices/{dev_id}")
def admin_revoke(dev_id: str):
    auth.revoke_device(dev_id)
    return {"ok": True}

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
        low = {d.lower().removeprefix("www.") for d in (settings.load().get("low_trust") or [])}
        extra = json.loads(c["facts"] or "{}") if (c["facts"] or "").startswith("{") else {}
        out.update({
            "summary": c["summary"],
            "facts": extra.get("facts", []),
            "disputed": extra.get("disputed", []),
            "pushReason": c["push_reason"],
            "maxCvss": c["max_cvss"],
            "watchHits": json.loads(c["watch_hits"] or "[]"),
            "sources": [{**x, "lowTrust": x["site"].removeprefix("www.") in low or x["origin"] in low} for x in src],
            "hidden": bool(c.get("hidden")),
            "hideReason": c.get("hide_reason"),
        })
    return out


@app.get("/api/clusters")
def list_clusters(request: Request, cat: str = "all", q: str = "", limit: int = 60, device: str = "", view: str = "feed"):
    """view=feed: ongelezen en recent · view=archive: door dit apparaat gelezen · zoeken: alles."""
    device = _device_id(request, device)
    from datetime import timedelta
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
    read_sql = "SELECT cluster_id FROM reads WHERE device=?"
    if q:
        sql += " AND (title_nl LIKE ? OR id IN (SELECT cluster_id FROM entries WHERE title LIKE ? OR text LIKE ?))"
        args += [f"%{q}%", f"%{q}%", f"%{q}%"]
    elif view == "archive":
        sql += f" AND id IN ({read_sql})"
        args.append(device)
    elif cat != "hidden":
        since = pipeline.iso(pipeline.now() - timedelta(hours=settings.FEED_MAX_AGE_HOURS))
        sql += f" AND updated_at >= ? AND id NOT IN ({read_sql})"
        args += [since, device]
    if view == "archive" and not q:
        sql += " ORDER BY (SELECT at FROM reads WHERE device=? AND cluster_id=clusters.id) DESC LIMIT ?"
        args.append(device)
    else:
        # Belangrijkste eerst: kritiek, dan bevestigd met veel bronnen, dan recent
        sql += " ORDER BY critical DESC, (status='waiting') ASC, date(updated_at) DESC, n_sources DESC, updated_at DESC LIMIT ?"
    args.append(min(limit, 200))
    read_ids = {r[0] for r in db.con().execute(read_sql, (device,))} if device else set()
    return [{**_card(dict(r)), "read": r["id"] in read_ids} for r in db.con().execute(sql, args).fetchall()]


class ReadBody(BaseModel):
    device: str
    ids: list[int]
    read: bool = True


@app.post("/api/read")
def mark_read(body: ReadBody, request: Request):
    """Gelezen/gearchiveerd per apparaat (zo heeft ieder toestel een eigen lijst)."""
    body.device = _device_id(request, body.device)
    if not body.device or len(body.device) > 64:
        raise HTTPException(400)
    con = db.con()
    with db._lock:
        for cid in body.ids[:500]:
            if body.read:
                con.execute("INSERT OR IGNORE INTO reads(device, cluster_id, at) VALUES(?,?,datetime('now'))", (body.device, cid))
            else:
                con.execute("DELETE FROM reads WHERE device=? AND cluster_id=?", (body.device, cid))
        con.commit()
    return {"ok": True}


_weather = {"at": 0.0, "data": None}


@app.get("/api/weather")
def weather():
    """Actueel weer via Open-Meteo (gratis, geen sleutel). 10 minuten gecachet."""
    import httpx
    if _weather["data"] and time.time() - _weather["at"] < 600:
        return _weather["data"]
    try:
        r = httpx.get("https://api.open-meteo.com/v1/forecast", params={
            "latitude": settings.WEATHER_LAT, "longitude": settings.WEATHER_LON,
            "current": "temperature_2m,weather_code,is_day,precipitation",
            "daily": "temperature_2m_max,temperature_2m_min,precipitation_probability_max",
            "timezone": "Europe/Amsterdam", "forecast_days": 1}, timeout=15)
        r.raise_for_status()
        j = r.json()
        cur, day = j.get("current", {}), j.get("daily", {})
        _weather["data"] = {
            "place": settings.WEATHER_PLACE,
            "temp": cur.get("temperature_2m"), "code": cur.get("weather_code"), "isDay": bool(cur.get("is_day", 1)),
            "max": (day.get("temperature_2m_max") or [None])[0], "min": (day.get("temperature_2m_min") or [None])[0],
            "rainChance": (day.get("precipitation_probability_max") or [None])[0],
        }
        _weather["at"] = time.time()
    except Exception as e:
        log.warning("weer ophalen mislukt: %s", e)
        if not _weather["data"]:
            raise HTTPException(503)
    return _weather["data"]


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
def push_subscribe(body: Subscription, request: Request):
    from . import webpush
    try:
        webpush.subscribe(body.subscription, body.label, _device_id(request) or None)
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


@app.post("/api/push/morning-test")
def push_morning_test():
    """Ochtendoverzicht nu versturen (om te testen)."""
    return {"stories": morning_digest(force=True)}


@app.post("/api/push/test")
def push_test(body: Endpoint):
    from . import webpush
    n = webpush.send("NieuwsRadar", "Meldingen werken op dit apparaat.", url="/", priority=3, endpoint=body.endpoint)
    return {"sent": n}


@app.get("/health")
def health():
    return {"ok": True}


@app.get("/admin")
def admin_page():
    return FileResponse(STATIC / "admin.html", headers={"Cache-Control": "no-cache"})


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
