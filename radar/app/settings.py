import copy
import os

import yaml

from . import db

CONFIG_PATH = os.environ.get("RADAR_CONFIG", "/app/config.yaml")

MINIFLUX_URL = os.environ.get("MINIFLUX_URL", "http://miniflux:8080").rstrip("/")
MINIFLUX_API_KEY = os.environ.get("MINIFLUX_API_KEY", "")
OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://ollama:11434").rstrip("/")
EMBED_MODEL = os.environ.get("EMBED_MODEL", "bge-m3")
LLM_MODEL = os.environ.get("LLM_MODEL", "").strip()
TRANSLATE = os.environ.get("TRANSLATE", "").strip().lower() in ("1", "true", "ja", "yes", "on")
TRANSLATE_MODEL = (os.environ.get("TRANSLATE_MODEL", "").strip() or LLM_MODEL)
TRANSLATE_PER_RUN = int(os.environ.get("TRANSLATE_PER_RUN", "25"))
NTFY_URL = os.environ.get("NTFY_URL", "").rstrip("/")  # leeg = ntfy uit
VAPID_SUBJECT = os.environ.get("VAPID_SUBJECT") or os.environ.get("PUBLIC_URL", "https://localhost")
NTFY_TOPIC = os.environ.get("NTFY_TOPIC", "nieuwsradar")
NTFY_TOKEN = os.environ.get("NTFY_TOKEN", "")
PUBLIC_URL = os.environ.get("PUBLIC_URL", "http://localhost:8080").rstrip("/")
INTERVAL_SECONDS = int(os.environ.get("RADAR_INTERVAL", "300"))
FEED_MAX_AGE_HOURS = int(os.environ.get("FEED_MAX_AGE_HOURS", "48"))  # ouder verdwijnt uit de feed (blijft zoekbaar)
RETENTION_DAYS = int(os.environ.get("RETENTION_DAYS", "30"))          # daarna echt opruimen
WEATHER_LAT = os.environ.get("WEATHER_LAT", "52.04")
WEATHER_LON = os.environ.get("WEATHER_LON", "5.67")
WEATHER_PLACE = os.environ.get("WEATHER_PLACE", "Ede")
FIRST_RUN_HOURS = int(os.environ.get("FIRST_RUN_HOURS", "12"))   # eerste keer: zo ver terugkijken
EMBED_BATCH = int(os.environ.get("EMBED_BATCH", "16"))
EMBED_CHARS = int(os.environ.get("EMBED_CHARS", "300"))


def load():
    """config.yaml, met de schakelaars uit de PWA eroverheen."""
    with open(CONFIG_PATH, encoding="utf-8") as f:
        cfg = yaml.safe_load(f) or {}
    cfg = copy.deepcopy(cfg)
    overrides = db.get_state("push_overrides", {}) or {}
    for rule, enabled in overrides.items():
        if rule in cfg.get("push", {}):
            cfg["push"][rule]["enabled"] = bool(enabled)
    return cfg
