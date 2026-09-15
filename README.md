# FitOn Invoice Automation — Chrome extension

Books revenue **and cost** lines on FitOnPortal from per-client rate templates.
Everything is reviewed and editable before a single line is written.

- `manifest.json` — extension definition, and the `update_url` that drives auto-updates
- `content/invoice.js` — the whole tool: rate tables, config dialog, review screen, booking loop
- `content/pdf-crypto.js` — decryption and glyph tables for PDFs that hide their text
- `content/page-debug.js` — the `fiton.*` console commands, injected into the page
- `background.js` — install/update handling, and sending reports (with the PDF) to Supabase
- `supabase/` — `setup.sql` for the shared Supabase project, and how to connect (its own README)
- `dashboard/` — the older self-hosted dashboard server; **not part of the extension**
- `ui/options.html|js` — settings, field mappings, remote rates URL, dashboard connection
- `ui/dashboard.html|js` — the shared dashboard, read straight from Supabase
- `ui/supabase.js` — the Supabase calls shared by the worker, settings and dashboard
- `ui/popup.html|js` — status, the dashboard, and a manual update check
- `updates.xml` — self-hosted update manifest
- `build.sh` — packs a `.zip` and optionally a signed `.crx`

---

## 1. Try it locally

1. `chrome://extensions` → turn on **Developer mode**
2. **Load unpacked** → select this folder
3. Open a FitOnPortal revenue page — the panel appears bottom right

Local loading ignores `update_url`, so this is for testing only.

---

## 2. Cost lines

The revenue page field names are known and built in. The **cost page differs per
installation**, so it is mapped once, in the browser, without anyone reading HTML:

1. Open a cost entry page in FitOn
2. In the panel, click **Kosten**
3. Click **Velden leren**
4. Click each field as the blue bar asks for it — grootboek, aantal, prijs,
   omschrijving, btw, valuta, and the two buttons

Clicks are swallowed while learning, so pressing the Create button teaches its id
without submitting anything. The map is saved to `chrome.storage.sync`, so
colleagues signed into Chrome get it on every machine — and if you send them the
map, they never have to do this themselves.

The rate tables are sales prices. On the cost side use **Prijzen leegmaken** in
the review screen to blank them and type the actual supplier amounts, or work
from the *net net as per outlay* fields, which are already amount-entry.

---

## 3. Distribution with auto-updates

Two routes. Pick one before sharing anything.

### A. Chrome Web Store, unlisted (recommended)

Auto-updates work with no IT involvement and no signing keys to protect.
Unlisted means it does not appear in search — only people with the link can install.

1. One-off developer registration (a small fee applies)
2. `./build.sh` → upload `fiton-invoice-8.0.0.zip`
3. Set visibility to **Unlisted**, submit for review (usually a few days)
4. Share the link; Chrome updates everyone automatically when you publish a new version

Delete `update_url` from `manifest.json` for this route — the Web Store handles it.

### B. Self-hosted

Full control, no review wait, but **Chrome blocks self-hosted CRX installs
unless the extension is allowlisted by enterprise policy**. This route needs IT.

1. Generate a key once: `openssl genrsa -out key.pem 2048` — **back this up**;
   losing it means a new extension id and everyone reinstalling
2. `./build.sh key.pem` → produces `.zip` and `.crx`
3. Get the extension id from `chrome://extensions` after loading the CRX once,
   and put it in `updates.xml` as `appid`
4. Host `updates.xml` and the `.crx` on an internal HTTPS path
5. Point `update_url` in `manifest.json` at `updates.xml`
6. Ask IT to force-install via the `ExtensionSettings` policy with
   `installation_mode: force_installed` and your `update_url`

### Shipping a new version (either route)

1. Bump `version` in `manifest.json` — Chrome only updates when it **increases**
2. Route A: upload the new zip. Route B: rebuild the CRX, upload it, and update
   the `version` and `codebase` in `updates.xml`

Chrome checks roughly every 5 hours. The popup's **Controleer op updates** forces
a check immediately, which is useful when you want everyone on a fix today.

---

## 4. Crediteuren bijwerken

Open een kostenregel in FitOn en klik in het paneel op **Crediteuren verversen**.
De extensie leest dan het crediteurvenster helemaal uit, inclusief "Show More",
en controleert de gelezen nummers tegen de crediteuren die ze al kent voordat er
iets wordt opgeslagen. Dit geldt per browser, dus elke collega klikt één keer.

Herkent de extensie een afzender niet — een dienstenspecificatie met alleen een
logo bijvoorbeeld — kies de crediteur dan zelf. Bij het boeken onthoudt ze het
logo, jullie klantnummer en het vaste deel van de factuurnummering, zodat
dezelfde afzender daarna vanzelf herkend wordt. `fiton.marks()` laat zien wat er
geleerd is.

---

## 5. Optioneel: gedeeld dashboard

Zonder dit blijft alles zoals het was: rapporten staan alleen op je eigen
machine. Met een gedeeld Supabase-project ziet iedereen op de afdeling elke
boekrun, met de regels, wie hem inlas en de factuur-PDF. Er draait geen eigen
server; het dashboard zit in de extensie (popup → **Dashboard openen**).

Instellen: zie `supabase/README.md`. Kort: project aanmaken, `supabase/setup.sql`
draaien, en Project URL plus key invullen bij de instellingen.

Wie liever een eigen server draait: `dashboard/README.md`.

---

## 6. Optional: rates from a URL

Settings accepts an HTTPS URL to a JSON rate file. With it set, rates can be
changed for everyone without shipping a version. Leave it blank to use the tables
built into the extension. Add the host to `host_permissions` in `manifest.json`
before using this, or the fetch is blocked.

---

## Debuggen (F12)

Op een FitOnPortal-pagina:

```
fiton.help()          alle commando's
fiton.info()          versie, herkende pagina, veldnamen, knoppen
fiton.readFile()      kies een factuur en zie precies wat eruit komt
fiton.readText(`…`)   idem voor geplakte tekst
fiton.rows()          de gelezen regels met posities
fiton.ledger('Tol')   welk grootboek een omschrijving krijgt
fiton.state()         lopende boekrun en werklijst
fiton.timing()        hoe lang elke regel duurde in de laatste run
fiton.marks()         geleerde kenmerken (logo, klantnr) per crediteur
fiton.capture(true)   POST-verzoeken opnemen (overleeft de refresh van APEX)
fiton.requests()      opgenomen verzoeken; fiton.requests(3) toont er één helemaal
```

`fiton.capture` is een hulpmiddel om te zien wat FitOn precies verstuurt. Het
staat standaard uit, want de opgenomen verzoeken bevatten sessietokens. Wis ze
na gebruik met `fiton.requests('clear')`.

Werkt `fiton` niet, dan draait de console in een andere context: kies in de
dropdown linksboven in het Console-tabblad (staat op "top") de extensie, of
herlaad de pagina. In Edge en Chrome heet die dropdown hetzelfde.

## Notes

- Settings and field maps live in `chrome.storage.sync` (shared between machines).
  Run state and presets stay in page `localStorage` (per browser).
- The booking loop verifies each line against the revenue list before moving on,
  stops rather than skipping if a line does not save, and never types into a
  saved record. Those checks matter more on a shared install than a personal one.
- All amounts are EUR and the currency field is forced to EUR on every line.
- De btw-code wordt door FitOn zelf bepaald (het proces `getVatSeq`, dat afgaat
  als crediteur, grootboek of datum verandert). De extensie wacht tot de server
  klaar is, zet daarna 0% en controleert dat het blijft staan. Houdt de pagina
  een andere code vast, dan stopt ze in plaats van de regel verkeerd te boeken.
