# FitOn boekrapporten — via Supabase

Elke boekrun van de extensie komt in één Supabase-project terecht, met de
factuur-PDF erbij. Iedereen op de afdeling ziet het in het dashboard in de
extensie. Er hoeft geen eigen server te draaien.

```
Extensie (elke pc) ──► Supabase: tabel runs + opslag facturen ◄── Dashboard (in de extensie)
```

---

## 1. Project aanmaken (één keer)

1. Maak een account op [supabase.com](https://supabase.com) en een **New project**.
   Kies als regio **Frankfurt (eu-central-1)**.
2. Open **SQL Editor**, plak de inhoud van [`setup.sql`](setup.sql) en klik **Run**.
   Dit maakt de tabel, de kengetallen, de opslag voor facturen en de
   toegangsregels. Het script mag later opnieuw gedraaid worden.
3. Open **Project Settings → API Keys** en noteer:
   - de **Project URL** (`https://….supabase.co`)
   - de **publishable key** (`sb_publishable_…`), of onder *Legacy API keys* de
     **anon public** key (`eyJ…`). Beide werken.

## 2. Extensie koppelen (elke collega)

1. Klik op het icoon van de extensie → **Instellingen**.
2. Vul bij **Gedeeld dashboard** de Project URL en de key in.
3. Vink **De factuur-PDF meesturen** aan.
4. Klik **Opslaan** en sta de toegang toe die Chrome vraagt.
5. Klik **Verbinding testen**. Alle drie de onderdelen moeten groen zijn.

Het dashboard open je via het icoon van de extensie → **Dashboard openen**.

## 3. Een nieuwe versie aankondigen

Collega's zien vanzelf dat ze achterlopen — de extensie vraagt het elke zes uur
aan dit project en laat het zien in de popup, de instellingen en het paneel in
FitOn. Er wordt niets gedownload of geïnstalleerd; het zegt alleen dat je
achterloopt.

Breng je een versie uit, zet hem dan hier neer (**SQL Editor**, of *Table
Editor → releases*):

```sql
insert into public.releases (version, notes, url)
values ('9.20.0', 'Meerdere facturen tegelijk inlezen', 'https://…');
```

De `url` mag leeg blijven; dan staat er alleen dát er een nieuwe versie is.

Doe je dit niet, dan wordt de nieuwste versie afgeleid uit de rapporten: elke
boekrun vertelt op welke versie hij draaide, en een versie telt mee zodra er
twee runs mee gedaan zijn. Zo merkt iemand die achterloopt het alsnog, de eerste
keer dat een ander op een nieuwere versie boekt.

Een bestaand project moet `setup.sql` één keer opnieuw draaien voor de tabel
`releases` en de functie `fiton_latest_version`. Zolang dat niet gebeurd is,
meldt **Verbinding testen** dat onderdeel als niet gevonden en blijft de rest
gewoon werken.

---

## 4. Goed om te weten

- **Wie de URL en de key heeft, kan alles lezen**, ook de facturen. Deel ze
  alleen binnen de afdeling. Wijzigen of verwijderen kan via die key niet.
- **Iets verwijderen** doe je in Supabase zelf: een rapport in *Table Editor →
  runs*, een PDF in *Storage → facturen*.
- **Geen verbinding?** Dan blijft het rapport op de pc staan en gaat het mee met
  de volgende run. Er gaat niets verloren.
- **Gratis plan:** een project zonder enig gebruik gaat na een week op pauze.
  Met één klik in Supabase staat het weer aan. Wil je dat niet, of wil je
  dagelijkse back-ups, neem dan het Pro-plan.
- **Facturen op een tweede plek:** overleg bewaartermijn en toegang even met wie
  over documentbeheer gaat.
