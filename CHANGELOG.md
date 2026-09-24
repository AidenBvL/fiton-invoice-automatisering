# Wat er veranderd is

## 9.27.0

**Container onbekend in FitOn: dan op ons eigen zendingnummer.** Een ONE-factuur
strandde op *FitOn meldt "no data found" voor dit containernummer*, terwijl
diezelfde factuur onder CUSTOMER'S REFERENCE ons zendingnummer 1002002093
noemt. De zoekroutine probeerde alleen de container en gaf op. Meldt FitOn nu
"no data found" op de container en noemt de factuur een zendingnummer van ons,
dan wordt daarop gezocht voordat de regel als niet gevonden wordt afgedaan.

**ONE-factuur: factuurnummer en omschrijvingen.** Het factuurnummer werd niet
gelezen: ONE zet *INVOICE NUMBER* op één regel, daaronder de adresregel van de
kolom ernaast, en pas twee regels lager het nummer. De zoeker kijkt nu twee
regels onder een label, in dezelfde kolom. De omschrijvingen sleepten de PER-
kolom en het tarief mee (*TERMINAL HANDLING CHARGE (D) BX 370.000*): een
eenheidswoord als *BX* of *BL* telde als tekst, en een eenheid vóór zijn tarief
werd niet als kolom gezien. Allebei verholpen. En een naam die op een voorzetsel
afbreekt — *CONTAINER MANAGEMENT FEE FOR* met *DISCHARGE* onder het bedrag — neemt
dat woord nu mee, net als eerder al bij een woord in kleine letters. De factuur
leest als vier regels op SZLU9744789, € 473,00, gelijk aan het totaal; de acht
andere facturen bij de hand lezen precies als eerst.

## 9.26.1

**Hapag-Lloyd stond op € 65,00 met vier regels van € 495,00.** De twee blokken
van die factuur worden sinds 9.26.0 samengevoegd tot één zending, maar het
zendingtotaal was al eerder in de keten bepaald en ging niet mee. Het
samengevoegde blok krijgt nu zijn eigen totaal: € 495,00, gelijk aan de factuur.
Bij alle acht facturen bij de hand is het zendingtotaal nu de som van de regels.

## 9.26.0

**Hapag-Lloyd en Yang Ming worden gelezen.** Van Hapag-Lloyd kwam alleen de
voettekst binnen, van Yang Ming stonden de bedragen in de kop. Allebei zat in de
PDF-lezer zelf, niet in de kostenherkenning:

- Hapag-Lloyd breekt tekstregels binnen de tekst af met een backslash gevolgd
  door een regeleinde. De lezer nam die escape niet aan, en daarmee viel elke
  regel met zo'n afbreking weg — de hele factuur, op de voettekst na.
- Yang Ming schrijft elke kostenregel met de PDF-operator `'` ("volgende regel,
  toon tekst"). De lezer kende alleen `Tj` en `TJ`, waardoor de regelpositie
  nooit opschoof en alles erna op de verkeerde hoogte belandde. `'` en `"`
  worden nu gelezen.
- Hapag-Lloyd zet elke regel in een vaste-breedte-letter als één tekst, met
  de kolommen door spaties uit elkaar: *ADMIN FEE DEST      65,00 EUR    1 BIL*.
  Zo'n tekst wordt nu op elke reeks spaties in cellen geknipt, geplaatst op
  tekenpositie, zodat de bedragen een kolom vormen zoals op elke andere factuur.

En wat daarna nog overbleef: de titel *I N V O I C E  NO.:* met gespatieerde
hoofdletters wordt dichtgeschoven voor het factuurnummer; een dubbele punt in
een eigen cel tussen *Invoice No.* en het nummer wordt overgeslagen; een
crediteurnaam die met letterspatiëring is gezet (*Y AN G M I N G*) wordt
herkend door spaties en punten weg te laten; een document met precies één
container geeft die ook aan een blok kosten dat vóór de containerregel staat
(Hapag-Lloyd zet *ADMIN FEE DEST* boven *HLBU 9066045*); en *TMNL SECURITY
DEST* en *EQUIPM.MAINTEN.FEE* kennen hun grootboek (4985 en 4984).

Hapag-Lloyd leest nu als vier regels op HLBU9066045, € 495,00; Yang Ming als
vijf regels op YMLU5470952, € 507,00; allebei exact gelijk aan het
factuurtotaal, met factuurnummer en crediteur. De zes andere facturen bij de
hand lezen precies als eerst.

## 9.25.6

**Dezelfde factuur twee keer ingesleept.** Een rapport van 15 facturen telde
7557036174 twee keer: dezelfde nota onder twee bestandsnamen. De eerste boekte
MNBU0363247, de tweede trof de regel aan en werd overgeslagen met "staat al op
deze zending" — correct, maar verwarrend. Het inleesvenster herkent dat nu:
een document met hetzelfde factuurnummer en hetzelfde totaal als een eerder
ingelezen document staat uit, met de melding dat het dezelfde factuur nog een
keer is. Aanvinken kan altijd. En gebeurt het toch, dan zegt het rapport wat er
gebeurde: *Factuur 7557036174 is twee keer ingelezen; de kosten van MNBU0363247
zijn bij de eerste geboekt.*

## 9.25.5

**"Staat al op deze zending" terwijl de run hem net boekte.** Een zending komt
alleen op *Overgeslagen* als het factuurnummer al op de zending stond vóórdat er
geboekt werd — een zending die in de run zelf geboekt is, wordt nooit daarna nog
overgeslagen. Het gebeurt wel als een factuur dezelfde container twee keer noemt:
de eerste vermelding boekt de kosten, de tweede treft ze aan en wordt
overgeslagen, en het rapport zei dan alleen "staat al op deze zending". Dat leest
alsof de run niets gedaan heeft. Nu staat er wat er gebeurde: *MNBU0363247 staat
twee keer op factuur 7557036174; de kosten zijn bij de eerste vermelding geboekt*.
Staat er nog steeds "staat al op deze zending", dan stond hij er echt al — uit een
eerdere run of met de hand.

## 9.25.4

**CMA CGM-omschrijvingen.** CMA CGM zet de naam van een kostenregel op een eigen
regel boven de kolommen — *Container maintenance Fee at destination* boven
*40RH C C2 1 UNI* — en het afgebroken laatste woord (*destination*) nog onder
het bedrag. De regel zelf zei dus niets, de naam kwam er alleen vóór als hij
een grootboek opleverde, en het losse woord raakte kwijt: *Terminal Handling
Charge (DTHC) at - 40RH C*, en *40RH C C2* op Diversen. Zegt een regel zelf
niets, dan is nu de dichtstbijzijnde regel met woorden erboven de naam, met of
zonder grootboek, en vervangt die de kolommen in plaats van ervoor te komen. Een
naam die op *at* afbreekt krijgt het kleine-letterwoord onder de cijfers erbij.
De factuur leest nu als *Terminal Handling Charge (DTHC) at destination*,
*Container maintenance Fee at destination* (op 4984 Equipment Maintenance),
*Container inspection & Survey Fee at destination* en *Documentation Fee at
destination*; bedragen en totaal ongewijzigd. De andere vier facturen bij de
hand lezen precies als eerst.

## 9.25.3

**Een container met het aantal erachter werd geen container.** Samskip schrijft
*HMMU5493213 1 x 40ft Reefer Container*, en het patroon voor een containernummer
stond na de zeven cijfers nog een los cijfer toe — bedoeld voor schrijfwijzen
als *CGMU 803082/7*. Het aantal werd zo een achtste cijfer, HMMU54932131 is geen
container, en de enige container op de factuur werd niet gevonden. Het patroon
is nu strikt: zeven cijfers, óf zes en een los controlecijfer.

Daarbij telt nu het controlecijfer van ISO 6346 mee: staan er op een pagina
twee nummers die op een container lijken, dan wint het nummer dat klopt. Het is
geen poortwachter — een rederij kan er een verkeerd afdrukken, en een eenzaam
nummer telt ook zonder — maar wel de doorslag waar een factuurnummer of
boekingsnummer dezelfde vorm heeft.

## 9.25.2

**De nacontrole leest de lijst onder het formulier, niet de zending opnieuw.**
In 9.25.0 werd elke zending na het boeken opnieuw opgezocht om de kostenregels
na te lezen — een extra zoekopdracht per zending. Dat is niet nodig: na de
laatste Create komt het formulier leeg terug met daaronder de lijst van alle
regels op de zending, dezelfde lijst waar de teller "row(s) 1 - 3 of 3" bij
hoort. Die wordt nu direct gelezen, tegen een nulmeting van dezelfde lijst bij
de start van het boeken, zodat rijen van een andere factuur nooit voor de onze
doorgaan. Elke regel wordt op bedrag en factuurnummer teruggevonden; ontbreekt
er een, dan staat de zending als *onvolledig* in het rapport en het dashboard,
met de regels erbij. Het vinkje en de heropen-lus uit 9.25.0 zijn weg.

## 9.25.1

**Omschrijvingen zonder de kolommen erachter.** Maersk sluit elke regel af met
zijn tariefkolommen — *Documentation fee - Destination 1 DOC EUR DK VAT 0%* — en
dat kwam zo op de boeking. De opschoning stript de aantal-, eenheid-, valuta- en
btw-kolommen van achteren, maar strandde meteen op *0%*. Percentages, het
btw-woord en de landcode (*DK*, *NL*) gaan nu ook, met een grens: het btw-woord
en de landcode alleen als wat ervóór staat óók een kolom is, zodat *Import VAT*
gewoon *Import VAT* blijft. Het geldt voor elke leverancier die zo'n staart
schrijft; de drie facturen bij de hand lezen als *Documentation fee -
Destination*, *Terminal Handling Service - Destination* en *Container Protect
Essential*, met dezelfde bedragen en totalen als eerst.

## 9.25.0

**Na het boeken wordt de zending nagelezen.** Een Maersk-factuur van drie regels
(€ 463,00) kwam in het rapport als volledig geboekt, terwijl er één regel op de
zending stond: FitOn weigerde de eerste twee omdat het btw-bedrag leeg was, en de
run merkte dat niet. Daar zaten twee gaten:

- De opslagcontrole leest "row(s) 1 - 3 of 3" onder het formulier. Op een
  zending zonder kosten staat daar "no data found", en dat las als *onleesbaar*
  — dus geen controle, en de volgende regel werd over de geweigerde heen getypt.
  Dat is nu nul regels, en de eerste regel wordt net zo gecontroleerd als de rest.
- Het btw-bedrag hoort de pagina zelf uit te rekenen. Blijft het leeg bij de
  0%-code, dan wordt het nu op 0 gezet voordat er op Create wordt geklikt.

En het sluitstuk: na het boeken wordt de zending opnieuw opgezocht en worden de
kostenregels nagelezen, regel voor regel, tegen wat erin ging. Rijen die er vóór
de run al stonden tellen niet mee. Staat alles erop, dan is de zending geboekt;
zo niet, dan staat ze als *onvolledig* in het rapport en het dashboard, met
precies de regels die ontbreken. Het kost per zending één extra zoekopdracht; het
vinkje *Na het boeken de zending opnieuw openen en controleren* staat standaard
aan en is per run uit te zetten.

**Een half geboekte factuur is opnieuw in te slepen.** Tot nu toe was een zending
waar het factuurnummer al op stond "al geboekt", ook als er één regel van de drie
stond. Nu wordt per regel gekeken welke er al is — op bedrag, op de rijen met dat
factuurnummer, en twee regels van € 8,50 hebben twee rijen nodig — en alleen wat
ontbreekt wordt geboekt. Staat alles er al, dan wordt de zending overgeslagen
zoals eerst.

## 9.24.0

**Kostenregels zijn aan te passen voor het boeken.** Wat de parser leest is niet
altijd wat geboekt moet worden, en tot nu toe waren er dan twee smaken: het
verkeerde boeken, of helemaal niets. In *Gevonden kosten* staat nu achter elke
regel een ✎: omschrijving, grootboek en bedrag zijn te wijzigen, een regel is te
verwijderen en er is er een toe te voegen. Het totaal wordt daarna opnieuw tegen
de factuur gecontroleerd — komt het uit, dan is de factuur geverifieerd; zo niet,
dan blijft *Toch boeken* nodig. Een gekozen grootboek gaat vóór elke regel en
komt zo ook in het eindrapport en het dashboard terecht.

**Een ONE-demurragefactuur van € 190 kwam binnen als € 570.** De regel SUM en de
regel *Ex.Rate: 1.00000 Sub Total* werden allebei als kosten gelezen. SUM telt nu
als totaal, en een omschrijving die *eindigt* op een totaalwoord ook — de
wisselkoers ervoor verborg het woord. *Lump sum* blijft een kostenregel.

De regel zelf heette *R5 13 Sep 2026 15 Sep 2026 13 Sep 2026 14 Sep 2026 2 1 - 5
190.000* en viel op 4930 Trucking. Data zijn geen woorden, dus zo'n omschrijving
telt nu als leeg, en dan wordt de kostensoort genomen die de factuur bovenaan
noemt: *Charge: DMIF(DEMURRAGE INBOUND LADEN CONTAINER)*. Dat boekt op 4934
Demurrage, en de factuur leest als één regel van € 190,00, gelijk aan het totaal.

## 9.23.0

**Het dashboard groepeert per inlezing.** Wie 34 facturen in één keer inlas,
kreeg 34 losse regels in het dashboard, tussen de regels van collega's door. Elke
inlezing is nu één dossier: één regel met wanneer, door wie, hoeveel facturen,
een balkje met geboekt / deels / mislukt, het totaalbedrag en het resultaat. Klik
erop en de facturen klappen eronder uit; klik op een factuur en rechts staat wat
er geboekt is, per zending, met de PDF erbij zoals eerst.

Daarvoor krijgt elke inlezing in de extensie een eigen id, die met elk
factuurrapport meegaat. Rapporten van vóór deze versie hebben dat id niet, maar
dragen wél het starttijdstip van de run mee — daarop worden ze alsnog tot
dossiers gevouwen, dus ook wat er al staat wordt overzichtelijk. Er hoeft niets
aan Supabase te veranderen: het id zit in het detail-veld dat er al was, en het
dashboard leest het daaruit.

**Het dashboard zelf is opnieuw ingedeeld.** Rustiger: dossiers links, het
detail rechts, en per dossier een overzicht met wat aandacht nodig heeft — de
facturen die niet of maar deels geboekt zijn, met de reden, om direct op door te
klikken. De filters *Volledig geboekt / Deels / Niet gelukt* werken nu op het
dossier. Zoeken vindt een factuur, crediteur, zending of container en opent het
dossier waar die in zit, met de treffers gemarkeerd, zodat je ziet met welke
inlezing hij meekwam. Een dossier waarvan nog niet alle rapporten binnen zijn —
een pc die het dashboard even niet kon bereiken — zegt hoeveel er nog komen.

## 9.22.1

**Cosco-facturen werden niet gelezen.** Een Cosco-factuur gaf *Geen kostenregels
herkend in dit document*, terwijl er zes kostenregels en een totaal op staan.
Cosco schrijft zijn tekst met een tweebytes-lettertype (Identity-H), maar als
gewone `( … )`-strings in plaats van als hex — en alleen hex-strings gingen door
de glyph-tabel van het lettertype. Daardoor kwam ORIGINAL binnen als `25,*,1$/`,
en de bedragen als stuurtekens: geen letters, geen bedragen, geen regels. Zo'n
string gaat nu ook door de tabel, en alleen wanneer élk tekenpaar erin staat,
zodat een lettertype met enkelbyte-codes en een eigen tabel er niets van merkt.
Daarbij worden nu ook de `\b`- en `\f`-escapes gelezen, want bij Cosco zijn dat
de glyphs voor `%` en `)`.

**Het factuurnummer rechtsboven.** Cosco zet *INVOICE NO.* in een kader met het
nummer ernaast, anderhalve punt hoger op de pagina — voor ons een andere regel —
terwijl lager in de goederenomschrijving het eigen factuurnummer van de shipper
staat (`INVOICE NO: 912601382`). Als platte tekst werd díé het eerst gevonden.
Een cel die precies het label is, met een factuurnummer als eerstvolgende cel op
dezelfde regel van de pagina, is nu wat het document zelf zijn factuurnummer
noemt, en gaat vóór elk patroon in de tekst: 3086658819.

**Omschrijvingen sleepten de kolommen mee.** `Port Security Charge 1 8.5000 EUR
1.00000 0%` in plaats van `Port Security Charge`: de volle regel won van de korte
door de drie letters van EUR. Een valutacode telt niet meer als tekst.

**Grootboek.** Cosco's `CUSTMS INSP FEE` gaat naar 5105 Customs Inspection en
*Secure Release Fee* naar 4945 Documentation Fee; de andere vier vielen al goed
(Port/Carrier Security Charge op 4985, DEST TRML HANDLG op 4959, DEST. DOC FEE op
4945). De factuur leest nu als zes regels op container OTPU6156590, € 418,00,
exact gelijk aan het totaal op de factuur.

## 9.22.0

**Het eindrapport is er een om door te sturen.** Kopiëren gaf een rij
tab-gescheiden velden — prima voor Excel, maar niet iets dat je aan de
boekhouding mailt. Er komt nu een uitgeschreven rapport uit, op een vaste breedte
zodat het een plakbeurt in een mail of een ticket overleeft:

- een kop met factuur, crediteur, factuurtotaal, wie hem inlas, wanneer en hoe
  lang het duurde;
- een resultaatblok met geboekt, overgeslagen en niet gelukt — elk met zijn
  aantal én zijn bedrag, want een aantal alleen zegt niet of er nog € 4.000 op
  een mislukking staat;
- bij meerdere facturen in één run een regel per factuur met wat ervan geboekt
  is;
- en daarna elke zending onder het kopje van wat ermee gebeurd is, met z'n
  kostenregels eronder — in plaats van één platte tabel waarin een overgeslagen
  regel er hetzelfde uitziet als een geboekte.

**En in het Engels.** Naast *Kopieer rapport* staat *Copy in English*: hetzelfde
rapport, vertaald, met Engelse getalnotatie en Engelse datums. Ook de reden
waarom een zending is overgeslagen of niet gelukt — die wordt nu naast de
Nederlandse zin als code vastgelegd, zodat het Engelse rapport er zijn eigen zin
van maakt in plaats van er "geen zoekresultaat" in te laten staan.

**Het rapport op het scherm** toont in de samenvatting per uitkomst ook het
bedrag, en een factuur waarvan de leverancier geen nummer afdrukt is nu aan zijn
bestandsnaam te herkennen in plaats van aan een streepje.

## 9.21.1

**Een wegzending op een dienstenspecificatie werd overgeslagen.** Lineage zet bij
een wegzending een trailernummer waar bij een zeezending een container staat —
`Ref.: 2002003905 Container: 21026` — en 21026 bewijst met z'n vorm niets, dus er
werd geen eenheid herkend en geen blok geopend. De kosten van die zending vielen
daardoor bij het blok erboven: € 404,70 aan wegkosten werd meegeboekt op
zeezending 1002002053, die daarmee op € 1.091,48 uitkwam in plaats van € 686,78.
Een regel zonder bedrag die een van onze eigen zendingnummers noemt, opent nu een
eigen blok.

Daarbij hoort: een container die één keer in de kop staat geldt alleen voor het
hele document als géén enkel blok er zelf een noemt. Op een specificatie waar elk
blok z'n eigen container draagt, zou het blok met een trailer anders de eerste
container van de pagina krijgen en als díé zending worden opgezocht.

**Tonnages verloren hun derde decimaal.** `22,862 Ton` werd `22,86`, en daarmee
klopte de regel niet meer: 22,86 × 13,77 is € 314,78, terwijl de factuur € 314,81
zegt. Een aantal wordt nu op drie decimalen bewaard — een tonnage wordt tot op de
kilo gewogen. Op de specificatie waar dit op viel kloppen nu alle 47 regels:
aantal × stuksprijs is precies het bedrag op de factuur.

## 9.21.0

**Facturen die verkeerd gelezen werden.** Allemaal gevonden op echte facturen,
en na elke wijziging zijn alle facturen die we bij de hand hadden opnieuw door
de oude en de nieuwe versie gehaald om te zien dat er niets anders meeschoof.

*MSC.* Een factuur van € 600 kwam binnen als € 1.800: hetzelfde bedrag drie
keer geteld. MSC zet een label en zijn bedrag op één regel, maar met de
basislijnen een halve punt uit elkaar, en regels worden op die basislijn
gegroepeerd — het label belandde in een regel zonder bedrag en het bedrag in een
regel zonder label, waar het als kostenregel werd gelezen. Staat er nu een
totaal-label naast een bedrag op dezelfde regel, dan is dat bedrag van dat label.
En een regel die een btw-percentage noemt is de btw-specificatie, nooit een
kostenregel.

*Containers en zendingen.* Het containernummer kwam als `SZ LU 9491905` uit de
PDF — de lettercode komt in stukjes uit de tekstlaag — en werd zo helemaal niet
als container herkend, dus er werd niets opgezocht. De letters mogen nu uit
elkaar staan. Daarnaast werd alleen de éérste containerkandidaat op de pagina
getest: een factuurnummer als `NLIC0129529` is óók vier letters en zeven cijfers,
en daar hield het zoeken op, waarna een heel blok kosten geen zending had om bij
te horen. Alle kandidaten worden nu getest.

*Wat een shipmentnummer is.* Een kostenregel wordt altijd op een zending met
1002, 2002 of 3002 geboekt. Dat is nu ook wat geaccepteerd wordt. Daarvóór gold
"100 gevolgd door van alles", waardoor het klantnummer van MSC — dat op élke
factuur van ze staat — voor een shipment id werd aangezien en al hun facturen
onder een nummer werden gezocht dat FitOn niet heeft.

*Zoeken.* In Forwarding > Search wordt gezocht op containernummer of B/L, dus
die twee komen eerst; de rest is wat overblijft als een factuur geen van beide
noemt.

*Aantal × stuksprijs.* Een MSC-opslagregel leest "from 18/08/2026 to 27/08/2026",
en 18 × 27 is precies € 486,00 — het bedrag van de regel. Die werd dus geboekt
als 18 stuks à € 27,00. Datums tellen niet meer mee als aantal of prijs. Echte
aantallen blijven staan: 5 × € 320,00 op een Maersk-regel, 24 pallets × € 18,63
op Lineage, 7 dagen × € 42,00 op een regel die z'n datumbereik ernaast draagt.

*Een boeking van € 0,00.* Een zending kan zonder kostenregels overblijven — als
z'n enige regel het factuurtotaal blijkt te zijn, of een herhaling van iets dat
al geteld was. Wat overbleef was een container zonder regels, en die werd alsnog
geboekt. Zo'n zending gaat er nu uit.

*Een halve factuur overgeslagen als dubbele van zichzelf.* Twee blokken voor
dezelfde container werden apart gehouden tenzij hun referenties exact gelijk
waren. Een blok dat géén referentie noemt werd daardoor een eigen zending, apart
geboekt, waarna de tweede helft werd geweigerd omdat het factuurnummer inmiddels
op de zending stond. Een blok zonder referentie splitst een container niet meer;
twee verschillende referenties nog steeds wel.

*OOCL.* Een factuur van € 60,00 kwam binnen als € 180,00. Erachter zit een
Reefer Power and Monitoring Notice die datzelfde bedrag vier keer herhaalt.
Regels onthouden nu van welk vel ze komen: kloppen de kosten samen met geen
enkel totaal uit het document, maar kloppen de kosten van één vel wél met een
totaal op dat vel, dan is dat vel de factuur en is de rest bijlage. Dat gebeurt
alleen bij een document dat toch al niet klopte.

*ONE.* Boekte z'n terminal security als "DISCHARGE", op Diversen. ONE zet de
omschrijving náást de bedragen met de basislijnen een halve punt uit elkaar, en
de regel erbóven is de doorgelopen omschrijving van de vórige kostenregel — er
werd alleen omhoog gekeken. Tekst op dezelfde basislijn wint nu.

*Grootboeken.* Een rij kolomkoppen is geen kostensoort meer (`CHARGE DESCRIPTION
BASIS RATE CUR VAT%` wees een grootboek aan puur door het woord VAT erin).
Noemt een regel zelf geen kostensoort, dan wordt het dichtstbijzijnde kopje
erboven dat dat wél doet ervoor gezet — zo boekt MSC "Plug In" op 4955 Special
Equipment en "Storage" op 4933 Storage Charges, in plaats van allebei op
Trucking Costs. OOCL's `RF PWR AND MONITOR CHRG` is hetzelfde als MSC's
"Plug In" en gaat mee naar 4955; daardoor verhuist ook CMA CGM's "Terminal
Reefer Monitoring at destination" van Diversen naar 4955.

**Het shipmentnummer in het eindrapport.** Per zending staat er nu bij op welk
dossier de kosten terecht zijn gekomen, gelezen van de zendingspagina zelf
(`P606_BOOKING_NO_DISPLAY` voor zee en lucht, `P3701_BOOKING_NO_DISPLAY` voor
weg) — de factuur noemt dat nummer nooit. Het staat in de rapporttabel, in
"Rapport kopiëren" en in het dashboard, waar het de referentie van de factuur
vervangt.

**Versiecontrole.** Een mislukte controle meldde zichzelf als "geen bron
ingesteld" en liet de foutmelding die het verklaarde ongebruikt; de
instellingenpagina zei daarnaast "je hebt de nieuwste versie" in het groen
naast de rode melding dat de controle mislukt was. Verder worden de
releasenotities en de link nu ontdaan van opmaak voordat ze getoond worden, kan
één vertypte regel in `releases` de controle niet meer voor de hele afdeling
breken, en zegt `fiton.version()` eindelijk ook óf je de nieuwste versie draait
in plaats van alleen welke je hebt.

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
bestand bij, `fiton.version()` zegt nu niet alleen wat hier draait maar ook of
dat de nieuwste is, en `fiton.marks()` werkt eindelijk ook vanuit de console van
de pagina zelf — dat stond wel in de README, maar de brug naar de pagina kende
het commando niet.
