import logging

import httpx

from . import settings

log = logging.getLogger("radar.push")


def send(title: str, message: str, click: str | None = None, priority: int = 4, tags=None) -> bool:
    """Publiceer via ntfy (JSON-variant, zodat UTF-8 in titels goed gaat)."""
    payload = {
        "topic": settings.NTFY_TOPIC,
        "title": title[:250],
        "message": message[:3500],
        "priority": priority,
        "tags": tags or [],
    }
    if click:
        payload["click"] = click
    headers = {"Authorization": f"Bearer {settings.NTFY_TOKEN}"} if settings.NTFY_TOKEN else {}
    try:
        r = httpx.post(settings.NTFY_URL + "/", json=payload, headers=headers, timeout=15)
        r.raise_for_status()
        return True
    except Exception as e:
        log.warning("push mislukt: %s", e)
        return False
