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
NTFY_URL = os.environ.get("NTFY_URL", "http://ntfy:80").rstrip("/")
NTFY_TOPIC = os.environ.get("NTFY_TOPIC", "nieuwsradar")
NTFY_TOKEN = os.environ.get("NTFY_TOKEN", "")
PUBLIC_URL = os.environ.get("PUBLIC_URL", "http://localhost:8080").rstrip("/")
INTERVAL_SECONDS = int(os.environ.get("RADAR_INTERVAL", "300"))


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
