"""Eén plek om meldingen te versturen: Web Push naar de PWA en (optioneel) ntfy."""
import logging

import httpx

from . import settings

log = logging.getLogger("radar.push")


def _ntfy(title, message, click, priority, tags) -> bool:
    if not settings.NTFY_URL:
        return False
    payload = {"topic": settings.NTFY_TOPIC, "title": title[:250], "message": message[:3500],
               "priority": priority, "tags": tags or []}
    if click:
        payload["click"] = click
    headers = {"Authorization": f"Bearer {settings.NTFY_TOKEN}"} if settings.NTFY_TOKEN else {}
    try:
        r = httpx.post(settings.NTFY_URL + "/", json=payload, headers=headers, timeout=15)
        r.raise_for_status()
        return True
    except Exception as e:
        log.warning("ntfy mislukt: %s", e)
        return False


def send(title: str, message: str, click: str | None = None, priority: int = 4, tags=None, topic: str | None = None) -> bool:
    """topic: 'news', 'security' of 'watch:<naam>' — elk apparaat kiest zelf wat het wil ontvangen."""
    from . import webpush  # lazy: voorkomt kringverwijzing bij opstarten
    sent_web = 0
    try:
        sent_web = webpush.send(title, message, url=click, priority=priority, topic=topic)
    except Exception as e:
        log.warning("web push mislukt: %s", e)
    sent_ntfy = _ntfy(title, message, click, priority, tags)
    return bool(sent_web or sent_ntfy)
