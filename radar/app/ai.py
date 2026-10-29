"""Ollama: embeddings voor clustering, optioneel een LLM voor samenvattingen."""
import json
import logging

import httpx
import numpy as np

from . import settings

log = logging.getLogger("radar.ai")


def embed(texts: list[str]) -> list[np.ndarray]:
    r = httpx.post(
        f"{settings.OLLAMA_URL}/api/embed",
        json={"model": settings.EMBED_MODEL, "input": texts},
        timeout=120,
    )
    r.raise_for_status()
    out = []
    for v in r.json()["embeddings"]:
        a = np.asarray(v, dtype=np.float32)
        n = np.linalg.norm(a)
        out.append(a / n if n else a)
    return out


PROMPT = """Je krijgt meerdere nieuwsartikelen over hetzelfde onderwerp, elk met bronnaam.
Schrijf in het Nederlands:
1. "summary": een neutrale samenvatting van 2-3 zinnen met alleen wat meerdere bronnen melden.
2. "facts": maximaal 5 feiten. Neem een feit ALLEEN op als minstens twee verschillende bronnen het noemen.
   Per feit: {"text": "...", "by": ["bron1", "bron2"]}.
3. "disputed": maximaal 3 punten waarop de bronnen elkaar tegenspreken of anders duiden (mag leeg).
Verzin niets. Antwoord uitsluitend met JSON: {"summary": "...", "facts": [...], "disputed": [...]}

Artikelen:
"""


def summarize(articles: list[dict]) -> dict | None:
    if not settings.LLM_MODEL:
        return None
    body = "\n\n".join(f"[{a['source']}] {a['title']}\n{a['text'][:1500]}" for a in articles[:6])
    try:
        r = httpx.post(
            f"{settings.OLLAMA_URL}/api/chat",
            json={
                "model": settings.LLM_MODEL,
                "messages": [{"role": "user", "content": PROMPT + body}],
                "format": "json",
                "stream": False,
                "options": {"temperature": 0.1},
            },
            timeout=600,
        )
        r.raise_for_status()
        data = json.loads(r.json()["message"]["content"])
        return {
            "summary": str(data.get("summary", "")).strip(),
            "facts": [f for f in data.get("facts", []) if isinstance(f, dict) and len(f.get("by", [])) >= 2],
            "disputed": [str(d) for d in data.get("disputed", [])][:3],
        }
    except Exception as e:  # LLM is optioneel; nooit de pipeline laten stoppen
        log.warning("samenvatten mislukt: %s", e)
        return None
