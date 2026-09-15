# FitOn boekrapporten — gedeeld dashboard

> **Let op:** de gewone route is nu Supabase, zonder eigen server — zie
> [`../supabase/README.md`](../supabase/README.md). Deze server is alleen nog
> voor wie het zelf wil hosten.

Elke boekrun van de extensie komt hier binnen en is voor alle collega's zichtbaar:
wie wat wanneer heeft geboekt, welke regels, welk bedrag, of het goed ging, en
optioneel de factuur zelf erbij.

Twee bestanden, geen dependencies: `server.js` en `dashboard.html`. De gegevens
komen in `fiton-runs.db` (SQLite) naast de server te staan.

---

## 1. Starten

Node 22 of nieuwer (voor de ingebouwde SQLite).

```bash
cp .env.example .env          # en vul het token in
node server.js
```

Dan staat het op `http://<die-machine>:8099/`. Bij het opstarten zegt de server
welk `.env`-bestand hij gebruikt, of dat hij er geen gevonden heeft.

Een token genereren dat niemand raadt:

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
```

Alles kan ook als omgevingsvariabele; die gaat voor op `.env`, zodat
`FITON_PORT=9000 node server.js` blijft werken en een systemd-unit of container
het bestand kan overrulen. Een ander pad kan met `FITON_ENV=/pad/naar/.env`.

Zet `.env` niet in git en deel hem niet mee met de extensie.

| Instelling | Betekenis |
|---|---|
| `FITON_TOKEN` | Gedeeld geheim. Zonder token mag iedereen die erbij kan posten. |
| `FITON_PORT` | Standaard 8099. |
| `FITON_HOST` | Standaard `0.0.0.0`. Zet op `127.0.0.1` om alleen lokaal te luisteren. |
| `FITON_STORE_DOCUMENTS` | `1` = facturen meesturen en bewaren in `documents/`. Standaard uit. |
| `FITON_DATA` | Waar de database en documenten komen. Standaard naast `server.js`. |

Voor permanent draaien: een systemd-unit, een Windows-service via `nssm`, of
een container. `.env` staat los van hoe je start, dus dat werkt overal hetzelfde. Zet er een reverse proxy met HTTPS voor als hij buiten het
interne netwerk bereikbaar is.

## 2. De extensie erop aansluiten

In de instellingen van de extensie, onder **Gedeeld dashboard**:

1. Adres van de server, bijvoorbeeld `http://fiton-rapporten.intern:8099`
2. Hetzelfde token als `FITON_TOKEN`
3. Eventueel "de factuur-PDF meesturen" aanvinken

Bij **Opslaan** vraagt Chrome toestemming voor dat adres. Sta dat toe, anders
blokkeert Chrome het versturen en blijven rapporten in de wachtrij.

Een run vanuit een factuur (werklijst) stuurt één rapport voor de hele factuur,
nadat de laatste container klaar is, met per container een regel en eventueel
de PDF.

Leeg laten betekent dat er niets verstuurd wordt en alles blijft zoals het was.

## 3. Wat er verstuurd wordt

Na afloop van een boekrun: tijdstip, de FitOn-gebruiker die de factuur inlas
(uit de navigatiebalk), factuurnummer, crediteur, en per zending de eenheid
(container, trailer, wagon, AWB…), soort vervoer, kostenregels met grootboek en
bedrag, het resultaat met reden, de controle tegen het factuurtotaal, het
bestand en de doorlooptijd. De PDF alleen als dat is aangevinkt.

Is de server niet bereikbaar, dan blijft het rapport op de machine staan en gaat
het mee met de volgende run. Er gaat niets verloren en de gebruiker merkt er
niets van.

## 4. Voordat dit live gaat

- **Het token is geen inlog.** Het houdt een verdwaalde tab tegen, meer niet.
  Wie het adres kent kan meelezen. Op een intern netwerk is dat meestal genoeg;
  daarbuiten hoort er de bedrijfslogin voor.
- **Facturen meesturen betekent een tweede vindplaats.** De extensie leest
  facturen nu lokaal en stuurt niets weg. Met deze optie aan komen ze op een
  server te staan: bewaartermijn, back-up en wie erbij mag zijn dan vragen voor
  degene die over documentbeheer gaat, niet voor de extensie.
- **Zet er iemand op.** Een database zonder eigenaar loopt vol en valt om.

## 5. API

| Methode | Pad | Doel |
|---|---|---|
| POST | `/api/runs` | Rapport opslaan. Token in header `x-fiton-token`. |
| GET | `/api/runs?q=&status=&user=&limit=` | Lijst, nieuwste eerst. Zoekt op factuur, crediteur, shipment, container, gebruiker. `status` = `done`, `partial` of `failed`. |
| GET | `/api/stats` | Kengetallen over de laatste 30 dagen en de gebruikers. |
| GET | `/api/runs/:id` | Eén run met alle regels. |
| GET | `/api/runs/:id/document` | De factuur, als die bewaard is. |

Het lezen is bewust niet achter het token gezet, zodat het dashboard gewoon in
een browser opent. Wil je dat wel, zet dan de proxy ervoor met een login.
