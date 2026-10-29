# NieuwsRadar

Eigen nieuwsoverzicht in Docker dat alleen nieuws als **bevestigd** markeert als meerdere *onafhankelijke* bronnen het melden. Daarnaast stuurt het pushmeldingen bij belangrijke IT-lekken en houdt het webpagina's in de gaten op wijzigingen. De interface is een installeerbare PWA in Material 3-stijl.

## Hoe het werkt

```
RSS-feeds ──► Miniflux ──► radar ──► PWA (feed + artikelpagina)
               (+RSSHub)     │  ▲
                             │  └── Ollama (embeddings, optioneel samenvatting)
                             ├──► ntfy ──► pushmelding op je telefoon
CISA KEV / NCSC-adviezen ────┤
Paginawachters (bijv. kerk) ─┘
```

1. **Miniflux** haalt alle feeds op (elke 10 minuten).
2. **radar** pakt nieuwe artikelen, maakt er met **Ollama** (`bge-m3`, meertalig) een embedding van en voegt artikelen over hetzelfde onderwerp samen tot één *verhaal*.
3. Per verhaal telt de radar de **herkomst**, niet het aantal sites. Een ANP-, Reuters-, AP- of AFP-tekst die NOS, RD en NU.nl allemaal overnemen telt als **één** bron.
4. Status: `bevestigd` (≥ 2 herkomsten binnen 48 uur), `officieel` (alleen een officiële bron zoals NCSC) of `wacht op bevestiging`.
5. Met `LLM_MODEL` ingesteld schrijft een lokaal model een samenvatting plus *"Wat de bronnen bevestigen"*. Daarin komen alleen feiten die minstens twee bronnen noemen, plus eventuele punten waarop de bronnen verschillen.

## Pushregels (`config.yaml` → `push`)

| Regel | Wanneer |
|---|---|
| `kev` | Nieuw lek in de CISA-lijst van actief misbruikte kwetsbaarheden (standaard alleen bij een trefwoord van de watchlist) |
| `ncsc_high_high` | NCSC-advies met kans en schade allebei **H** |
| `watchlist` | Bevestigd verhaal met een watchlist-trefwoord (bijv. PHP) **en** een officiële bron of CVSS ≥ 9 |
| `big_news` | ≥ 4 onafhankelijke bronnen binnen 6 uur |
| `categories` | Elk bevestigd verhaal in gekozen rubrieken (bijv. `il`) |

Regels kun je ook in de PWA aan- en uitzetten.

## Paginawachters (`config.yaml` → `watchers`)

Je krijgt een melding zodra een deel van een webpagina verandert. De tekst van dat deel gaat mee in de melding. Voorbeeld (staat er al in):

```yaml
watchers:
  - name: Petrakerk Ede
    url: https://petrakerkede.nl/live-luisteren/
    selector: .liturgie-column      # het blok met datum, liturgie, tekst en thema
    interval_minutes: 10
```

Zo ziet de melding eruit:

> **Petrakerk Ede: Dinsdag 27 oktober 2026, 19.30**
> Zingen: Psalm 66: 3
> Lezen: DL
> …
> Tekst: Jozua 3: 8-17
> Thema: De weg door de Jordaaan

Voor een andere pagina zoek je de selector zo op: rechtsklik op het blok › *Inspecteren* › kijk naar de `class`. Met de knop **Stuur testmelding** in de PWA krijg je meteen de huidige tekst.

## Installeren

```bash
git clone https://github.com/denniedp-debug/NieuwsRadar.git
cd NieuwsRadar
cp .env.example .env          # wachtwoorden invullen
docker compose up -d
```

1. Open Miniflux op `http://<server>:8081`, log in met je admin-gegevens en importeer `feeds.opml` (*Feeds › Importeren*).
2. Maak in Miniflux een API-sleutel aan (*Instellingen › API-sleutels*), zet die in `.env` als `MINIFLUX_API_KEY` en voer `docker compose up -d radar` uit.
3. Installeer de **ntfy**-app (Android/iOS), voeg je server toe (`http://<server>:8082`) en abonneer op het topic uit `.env` (standaard `nieuwsradar`).
4. Open de PWA op `http://<server>:8080`. Voor installeren als app en de service worker is **HTTPS** nodig, behalve op `localhost`. Zet er dus een reverse proxy voor (Caddy, Traefik, Nginx Proxy Manager) of gebruik Tailscale.

### RD.nl met je account

Abonneeartikelen staan achter een betaalmuur. In Miniflux kun je per feed een cookie meegeven:

1. Log in op rd.nl in je browser en kopieer de sessie-cookie (*Ontwikkelhulpmiddelen › Application › Cookies*).
2. Voeg de RD-feed toe in Miniflux, ga naar *Bewerken › Geavanceerd*, vul **Cookies** in en zet **Originele inhoud ophalen** aan.

De cookie verloopt na verloop van tijd. Ververs hem als artikelen weer afgekapt binnenkomen. Heeft rd.nl geen RSS-feed (meer), gebruik dan RSSHub of de scraper-regels van Miniflux.

### Feeds controleren

Niet alle adressen in `feeds.opml` konden vooraf getest worden. Miniflux toont per feed of het ophalen lukt; vervang adressen die een fout geven.

## Bronkeuze Israël

Geen enkele bron is neutraal. Daarom staan er Israëlische media uit verschillende kampen in (Times of Israel, Jerusalem Post, Ynetnews, Haaretz) plus Al Jazeera. Een feit dat zowel Israëlische als niet-Israëlische bronnen melden, is het sterkst bevestigd.

## Ontwikkelen

```bash
cd radar
pip install -r requirements.txt
RADAR_DB=./dev.db RADAR_CONFIG=../config.yaml MINIFLUX_URL=http://localhost:8081 \
MINIFLUX_API_KEY=... OLLAMA_URL=http://localhost:11434 uvicorn app.main:app --reload --port 8080
```
