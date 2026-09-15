# Wat er veranderd is

## 9.20.0

**Meerdere facturen tegelijk inlezen.** Sleep zoveel PDF's op de scanner als je
wilt — een stapel containernota's van dezelfde rederij gaat in één keer. Elke
factuur houdt zijn eigen factuurnummer, crediteur en totaalcontrole; er wordt
niets tussen ze gedeeld, dus twee nota's van dezelfde rederij overschrijven
elkaars crediteur niet meer. Alle zendingen komen in één werklijst, en elke
regel wordt geboekt met het factuurnummer en de crediteur van de factuur waar
hij op stond. Dat geldt ook voor de dubbelcontrole en de omschrijving.

Het eindrapport groepeert per factuur, en het dashboard krijgt één regel per
factuur in plaats van één voor de hele stapel: er wordt op factuurnummer
gezocht, en een regel die er drie omvat is onder geen van drieën te vinden.

**Versiecontrole.** Automatisch bijwerken werkt alleen als de extensie uit de
Web Store of van een `update_url` komt; zolang dat er niet is kan een collega
maanden achterlopen zonder dat iets dat zegt. De extensie vraagt nu zelf elke
zes uur aan het gedeelde project welke versie de huidige is, en laat het zien in
de popup, in de instellingen en in het paneel op de pagina zelf. Er wordt niets
gedownload of geïnstalleerd — het meldt alleen dat je achterloopt.

Een versie aankondigen is één regel in `releases` (zie `supabase/README.md`).
Staat daar niets, dan wordt de nieuwste versie afgeleid uit de rapporten, die
al vertellen op welke versie ze draaiden. Wie geen Supabase gebruikt, kan in de
instellingen een eigen JSON-bestand opgeven.

Verder: `fiton.readFile()` leest meerdere bestanden en zet er één regel per
bestand bij, `fiton.version()` is nieuw, en `fiton.marks()` werkt nu ook vanuit
de console van de pagina zelf.
