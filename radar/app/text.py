import html
import re
from urllib.parse import urlparse

_TAG = re.compile(r"<[^>]+>")
_WS = re.compile(r"\s+")
_IMG = re.compile(r"""<img[^>]+src=["']([^"']+)["']""", re.I)
_CVSS = re.compile(r"CVSS(?:v?\d(?:\.\d)?)?(?:[^0-9]{0,25})(\d{1,2}(?:[.,]\d)?)", re.I)


def strip_html(s: str) -> str:
    return _WS.sub(" ", html.unescape(_TAG.sub(" ", s or ""))).strip()


_BLOCK = re.compile(r"</?(p|div|br|h[1-6]|li|blockquote|tr|section|article|figure|figcaption)\b[^>]*>", re.I)
_DROP = re.compile(r"<(script|style|noscript|iframe|svg)\b.*?</\1>", re.I | re.S)


def html_to_text(s: str) -> str:
    """Leesbare tekst met alinea's (lege regel ertussen) uit HTML."""
    s = _DROP.sub(" ", s or "")
    s = _BLOCK.sub("\n\n", s)
    s = html.unescape(_TAG.sub(" ", s))
    paras = [_WS.sub(" ", p).strip() for p in re.split(r"\n\s*\n", s)]
    return "\n\n".join(p for p in paras if p)


def first_image(content: str, enclosures=None) -> str | None:
    for enc in enclosures or []:
        if (enc.get("mime_type") or "").startswith("image/"):
            return enc.get("url")
    m = _IMG.search(content or "")
    return m.group(1) if m else None


def host(url: str) -> str:
    h = urlparse(url or "").netloc.lower()
    return h[4:] if h.startswith("www.") else h


def detect_origin(text: str, site: str, wire_services: dict) -> str:
    """Persbureau-tekst krijgt de herkomst van het persbureau, de rest die van de site."""
    head_tail = text[:600] + " " + text[-400:]
    for name, patterns in (wire_services or {}).items():
        for p in patterns:
            if re.search(p, head_tail):
                return name
    return site


def max_cvss(text: str) -> float | None:
    best = None
    for m in _CVSS.finditer(text or ""):
        try:
            v = float(m.group(1).replace(",", "."))
        except ValueError:
            continue
        if 0 <= v <= 10:
            best = v if best is None else max(best, v)
    return best


def watch_hits(text: str, watchlist: list[str]) -> list[str]:
    hits = []
    for w in watchlist or []:
        if re.search(r"(?<![\w-])" + re.escape(w) + r"(?![\w-])", text, re.I):
            hits.append(w)
    return hits
