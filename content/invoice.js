/* FitOn Invoice Automation - content script.
   Packaged as a Chrome extension; see README.md for install and auto-update setup. */

(function() {
    'use strict';

    const DEBUG = true;
    const VERSION = (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getManifest)
        ? chrome.runtime.getManifest().version : '8.0';
    let isProcessing = false;

    /* =========================================================================
       CURRENCY
       -------------------------------------------------------------------------
       Every rate in this script is in EUR. Nothing is ever expressed in USD.
       CURRENCY_CODE is also pushed into the portal's currency field (if one is
       present on the revenue line) so a line can never be saved in USD by
       accident. Add the real APEX item id to CURRENCY_FIELD_IDS if your portal
       uses a different one - the console will tell you if none was found.
       ========================================================================= */
    /* =========================================================================
       PAGE MAPS - which fields to fill, per FitOn page
       -------------------------------------------------------------------------
       "revenue" is the sales side and its ids are known. "cost" is the purchase
       side; its ids differ per installation, so they are learned in the browser
       (panel > "Velden leren") and stored in the extension's synced settings,
       shared across every machine the user is signed into.
       ========================================================================= */
    const FIELD_KEYS = [
        { key: 'ledger',        label: 'Grootboek (zichtbaar veld)' },
        { key: 'ledgerHidden',  label: 'Grootboek (verborgen waarde)', optional: true },
        { key: 'qty',           label: 'Aantal' },
        { key: 'price',         label: 'Prijs' },
        { key: 'desc',          label: 'Omschrijving' },
        { key: 'vat',           label: 'BTW-code', optional: true },
        { key: 'currency',      label: 'Valuta', optional: true },
        { key: 'createBtn',     label: 'Knop: opslaan (Create)' },
        { key: 'createNextBtn', label: 'Knop: volgende regel (Create Next)' }
    ];

    const DEFAULT_MAPS = {
        revenue: {
            label: 'Omzet',
            breadcrumb: 'Revenue',
            ledger: 'P674_LEDGER_SEQ',
            ledgerHidden: 'P674_LEDGER_SEQ_HIDDENVALUE',
            qty: 'P674_QUANTITY',
            price: 'P674_PRICE',
            desc: 'P674_DESCRIPTION',
            vat: 'P674_VAT_SEQ',
            currency: 'P674_CURRENCY_SEQ',
            amount: 'P674_AMOUNT',
            vatAmount: 'P674_VAT_AMOUNT',
            createBtn: 'B59420024908124917',
            createNextBtn: 'B268178700524764320'
        },
        cost: {
            // Confirmed on FitOn: the cost entry form is APEX page 673.
            label: 'Kosten',
            breadcrumb: 'Cost',
            ledger: 'P673_LEDGER_SEQ',
            ledgerHidden: 'P673_LEDGER_SEQ_HIDDENVALUE',
            qty: 'P673_QUANTITY',
            price: 'P673_PRICE',
            desc: 'P673_DESCRIPTION',
            vat: 'P673_VAT_SEQ',
            currency: 'P673_CURRENCY_SEQ',
            amount: 'P673_AMOUNT',
            vatAmount: 'P673_VAT_AMOUNT',
            creditor: 'P673_CREDITOR_RELATION_SEQ',
            creditorHidden: 'P673_CREDITOR_RELATION_SEQ_HIDDENVALUE',
            createBtn: 'B59359322609116685',
            createNextBtn: 'B268178818434764321'
        },
        costRoad: {
            // Road shipment: Financials > Costs > Create opens APEX page 3708.
            // The buttons are found by their label; their ids are not known yet.
            label: 'Kosten',
            breadcrumb: 'Cost',
            ledger: 'P3708_LEDGER_SEQ',
            ledgerHidden: 'P3708_LEDGER_SEQ_HIDDENVALUE',
            qty: 'P3708_QUANTITY',
            price: 'P3708_PRICE',
            desc: 'P3708_DESCRIPTION',
            vat: 'P3708_VAT_SEQ',
            currency: 'P3708_CURRENCY_SEQ',
            amount: 'P3708_AMOUNT',
            vatAmount: 'P3708_VAT_AMOUNT',
            creditor: 'P3708_CREDITOR_RELATION_SEQ',
            creditorHidden: 'P3708_CREDITOR_RELATION_SEQ_HIDDENVALUE'
        },
        revenueRoad: {
            // The road revenue form's page number is not confirmed yet, so no ids:
            // add it to the road form pages and its fields are found automatically.
            label: 'Omzet',
            breadcrumb: 'Revenue'
        }
    };

    /* -------------------------------------------------------------------------
       AUTO-MAPPING
       FitOn is Oracle APEX, so page items are named P<page>_<ITEM> and the URL
       carries the page number: /ords/f?p=10050:606:<session>:::::
       The cost page therefore usually needs no configuration at all - read the
       page number, try the same item suffixes, and keep whatever exists. The
       Create buttons have generated ids that differ per page, so those are found
       by their label instead. Learn mode stays available for anything unusual.
       ------------------------------------------------------------------------- */
    const ITEM_SUFFIXES = {
        ledger:       ['LEDGER_SEQ'],
        ledgerHidden: ['LEDGER_SEQ_HIDDENVALUE'],
        qty:          ['QUANTITY', 'QTY'],
        price:        ['PRICE', 'UNIT_PRICE', 'COST_PRICE'],
        desc:         ['DESCRIPTION', 'OMSCHRIJVING'],
        vat:          ['VAT_SEQ', 'VAT_CODE'],
        currency:     ['CURRENCY_SEQ', 'CURRENCY', 'CURR_SEQ', 'CURRENCY_CODE', 'VALUTA'],
        amount:       ['AMOUNT'],
        vatAmount:    ['VAT_AMOUNT'],
        creditor:       ['CREDITOR_RELATION_SEQ', 'CREDITOR_SEQ'],
        creditorHidden: ['CREDITOR_RELATION_SEQ_HIDDENVALUE', 'CREDITOR_SEQ_HIDDENVALUE']
    };

    function apexPageId() {
        // /ords/f?p=<app>:<page>:<session>:::::
        const fromUrl = location.href.match(/[?&]p=\d+:(\d+):/);
        if (fromUrl) return fromUrl[1];

        // Fallback: whichever P<n>_ prefix appears most often in the form.
        const counts = {};
        document.querySelectorAll('[id^="P"]').forEach(node => {
            const m = node.id.match(/^P(\d+)_/);
            if (m) counts[m[1]] = (counts[m[1]] || 0) + 1;
        });
        const best = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
        return best || null;
    }

    function deriveMap() {
        const page = apexPageId();
        if (!page) return null;
        const map = { page };
        let hits = 0;
        for (const [key, suffixes] of Object.entries(ITEM_SUFFIXES)) {
            for (const suffix of suffixes) {
                const id = `P${page}_${suffix}`;
                if (document.getElementById(id)) { map[key] = id; hits++; break; }
            }
        }
        // Needs the fields we actually write, or it is not an entry form.
        if (!map.ledger || !map.qty || !map.price) return null;
        if (deriveMap._last !== page) {            // only when the page changes
            deriveMap._last = page;
            log(`Auto-mapped page ${page} (${hits} fields)`, map);
        }
        return map;
    }

    let autoMapCache = { href: '', map: null };
    function currentAutoMap() {
        if (autoMapCache.href !== location.href || !autoMapCache.map) {
            autoMapCache = { href: location.href, map: deriveMap() };
        }
        return autoMapCache.map;
    }

    /* FitOn page numbers, adjustable on the settings page. Sea and air shipments
       show the Costs region on the shipment page (606); a road shipment (3701)
       keeps it behind the Financials button, on 3706. roadForms are the entry
       forms of a road shipment (3708 = cost), which use the *Road field maps. */
    const DEFAULT_PAGES = { costs: ['606', '3706'], financials: ['3701'], roadForms: ['3708'] };
    const pageList = key => ((SETTINGS.pages || {})[key] || DEFAULT_PAGES[key]).map(String);

    /* The field map for this page: "cost" on a sea/air form, "costRoad" on a
       road one, so what is learned on one never lands on the other. MODE itself
       stays "revenue" or "cost". */
    const MODES = ['revenue', 'cost'];
    function mapKey(mode) {
        return pageList('roadForms').includes(apexPageId()) ? mode + 'Road' : mode;
    }

    // Live settings; replaced once chrome.storage answers.
    let SETTINGS = {
        maps: JSON.parse(JSON.stringify(DEFAULT_MAPS)),
        pages: JSON.parse(JSON.stringify(DEFAULT_PAGES)),
        ratesUrl: '',
        defaultMode: 'revenue'
    };
    let MODE = 'revenue';

    function F() {
        const key = mapKey(MODE);
        const stored = SETTINGS.maps[key] || {};
        const auto = currentAutoMap() || {};
        const base = DEFAULT_MAPS[key] || DEFAULT_MAPS[MODE] || DEFAULT_MAPS.revenue;
        const merged = Object.assign({}, base);
        // auto-derived wins over the built-in default; anything learned or typed
        // by hand wins over both.
        for (const k of Object.keys(auto)) if (auto[k]) merged[k] = auto[k];
        // A field id names its page (P673_...). One saved for another page must not
        // hide what was found on this one: the road cost form is P3708, and saving
        // the settings page stores the P673 ids.
        for (const k of Object.keys(stored)) {
            if (!stored[k]) continue;
            const page = (/^P(\d+)_/.exec(stored[k]) || [])[1];
            if (page && auto.page && page !== auto.page && auto[k]) continue;
            merged[k] = stored[k];
        }
        return merged;
    }
    function el(key) {
        const id = F()[key];
        return id ? document.getElementById(id) : null;
    }
    function mapIsConfigured(mode) {
        const previous = MODE;
        MODE = mode;
        const m = F();
        const fieldsOk = !!(m.ledger && m.qty && m.price && m.desc);
        // Buttons may come from the map or from their label on the page.
        const buttonsOk = (!!m.createBtn || !!findButtonByText(/^create$/i, /next|another|volgende|apply|change|delete|opslaan/i))
                       && (!!m.createNextBtn || !!getCreateNextButton());
        MODE = previous;
        return fieldsOk && (buttonsOk || mode === 'revenue');
    }

    function loadSettings() {
        return new Promise(resolve => {
            if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.sync) return resolve();
            chrome.storage.sync.get(['maps', 'pages', 'ratesUrl', 'defaultMode', 'carrierRates'], data => {
                if (data && data.maps) {
                    SETTINGS.maps = Object.assign(JSON.parse(JSON.stringify(DEFAULT_MAPS)), data.maps);
                }
                if (data && data.pages) {
                    SETTINGS.pages = Object.assign(JSON.parse(JSON.stringify(DEFAULT_PAGES)), data.pages);
                }
                if (data && data.ratesUrl) SETTINGS.ratesUrl = data.ratesUrl;
                if (data && data.defaultMode) SETTINGS.defaultMode = data.defaultMode;
                MODE = SETTINGS.defaultMode || 'revenue';
                resolve();
            });
        });
    }
    // Filled from SEED_CARRIER_RATES once that table is declared (see below).
    let CARRIER_RATES = {};
    let RATES_META = { source: 'ingebouwd', version: null, at: null };

    function carrierRate(carrier, type, chargeKey) {
        const c = CARRIER_RATES[carrier] || {};
        const t = c[type] || {};
        const v = t[chargeKey];
        return (typeof v === 'number' && !isNaN(v)) ? v : null;
    }

    function setCarrierRates(carrier, type, amounts) {
        CARRIER_RATES[carrier] = CARRIER_RATES[carrier] || {};
        CARRIER_RATES[carrier][type] = Object.assign({}, CARRIER_RATES[carrier][type], amounts);
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.sync) {
            chrome.storage.sync.set({ carrierRates: CARRIER_RATES });
        }
    }

    /* Remote rates: one JSON file everyone reads, so a tariff change does not
       need a new extension version. Cached locally and only replaced by a valid
       document, so a broken or unreachable file never breaks a booking. */
    function applyRemoteRates(doc, source) {
        if (!doc || typeof doc !== 'object' || !doc.carrierRates) return false;
        const merged = JSON.parse(JSON.stringify(SEED_CARRIER_RATES));
        for (const [carrier, types] of Object.entries(doc.carrierRates)) {
            if (!types || typeof types !== 'object') continue;
            merged[carrier] = merged[carrier] || {};
            for (const [type, charges] of Object.entries(types)) {
                if (!charges || typeof charges !== 'object') continue;
                const clean = {};
                for (const [k, v] of Object.entries(charges)) {
                    const n = parseFloat(v);
                    if (!isNaN(n) && n >= 0) clean[k] = n;
                }
                merged[carrier][type] = Object.assign({}, merged[carrier][type], clean);
            }
        }
        CARRIER_RATES = merged;
        RATES_META = { source, version: doc.version || null, at: doc.updatedAt || null };
        log('Carrier rates applied', RATES_META);
        return true;
    }

    async function loadRemoteRates() {
        if (typeof chrome === 'undefined' || !chrome.storage) return;

        // stored user edits first
        await new Promise(res => chrome.storage.sync.get(['carrierRates'], d => {
            if (d && d.carrierRates) {
                CARRIER_RATES = Object.assign(JSON.parse(JSON.stringify(SEED_CARRIER_RATES)), d.carrierRates);
                RATES_META = { source: 'eigen invoer', version: null, at: null };
            }
            res();
        }));

        // then the cached remote copy, so we are never worse off offline
        await new Promise(res => chrome.storage.local.get(['ratesCache'], d => {
            if (d && d.ratesCache) applyRemoteRates(d.ratesCache.doc, 'cache');
            res();
        }));

        if (!SETTINGS.ratesUrl) return;
        try {
            const resp = await fetch(SETTINGS.ratesUrl, { cache: 'no-cache' });
            if (!resp.ok) throw new Error('HTTP ' + resp.status);
            const doc = await resp.json();
            if (applyRemoteRates(doc, 'online')) {
                chrome.storage.local.set({ ratesCache: { doc, at: Date.now() } });
            } else {
                log('Remote rates document ignored: no usable carrierRates');
            }
        } catch (e) {
            log('Remote rates fetch failed, keeping cached/built-in rates: ' + e.message);
        }
    }

    function persistMaps() {
        if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.sync) return;
        chrome.storage.sync.set({ maps: SETTINGS.maps });
    }

    const DEFAULT_VAT_SEQ = '162';   // per-line override via item.vatSeq (see OUTLAY_ITEMS)
    const CURRENCY_CODE = 'EUR';
    const CURRENCY_SYMBOL = '€';
    const CURRENCY_FIELD_IDS = [
        'P674_CURRENCY', 'P674_CURRENCY_SEQ', 'P674_CURR_SEQ',
        'P674_CURRENCY_CODE', 'P674_VALUTA'
    ];

    /* =========================================================================
       RATE VALIDITY (from the offer letters)
       ========================================================================= */
    const VALIDITY = {
        general:   '2026-12-31',   // all rates
        transport: '2026-12-31'    // confirmed: trucking rates run to the same date
    };

    /* =========================================================================
       CENTRAL RATE CONFIGURATION - all amounts in EUR
       -------------------------------------------------------------------------
       Modal labels AND billed amounts are both generated from these values, so
       a label can never drift away from the price that actually gets booked.

       NOTE ON ECT / RWG: deliberately left at the flat 23.50 / 31.00 on request,
       even though the offer letters quote lower per-client figures.
       ========================================================================= */

    // Confirmed standard rates, applied to every client regardless of the figure
    // printed in that client's offer letter.
    const ECT_SURCHARGE = 23.50;
    const RWG_SURCHARGE = 31.00;

    // NVWA: EUR 0.01377 / kg, min EUR 82.62 (= 6.000 kg), max EUR 633.42 (= 46.000 kg)
    const NVWA = { rate: 0.01377, min: 82.62, max: 633.42, minKg: 6000, maxKg: 46000 };

    const LEDGER = {
        // --- used by the rate templates ---
        trucking:     { id: "4930", name: "Trucking Costs (Common)" },
        fuel:         { id: "4932", name: "Fuel Surcharge (Common)" },
        importDoc:    { id: "4942", name: "Import Document (Common)" },
        transit:      { id: "4943", name: "Transit Document (Common)" },
        docs:         { id: "4945", name: "Documentation Fee (Common)" },
        handling:     { id: "4947", name: "Handling Fee (Common)" },
        peak:         { id: "4952", name: "Peak Season Surcharge (Common)" },
        waiting:      { id: "4960", name: "Waiting Hours (Common)" },
        ggb:          { id: "4961", name: "GGB Entry (Common)" },
        vet:          { id: "4962", name: "VET Check (Common)" },
        nvwa:         { id: "4963", name: "NVWA Charges (Common)" },
        customsInsp:  { id: "5105", name: "Customs Inspection (X-ray and/or Physical) (Common)" },
        misc:         { id: "5106", name: "Miscellaneous (Common)" },
        extraStop:    { id: "5110", name: "Extra Stop  (Common)" },
        toll:         { id: "5113", name: "Toll/Maut Surcharge (Common)" },

        // --- used by the net-net outlay rows ---
        storage:      { id: "4933", name: "Storage Charges (Common)" },
        demurrage:    { id: "4934", name: "Demurrage (Common)" },
        detention:    { id: "4935", name: "Detention (Common)" },
        isps:         { id: "4949", name: "ISPS (Common)" },
        thc:          { id: "4959", name: "Terminal Handling Charges (Common)" },
        specialEquip: { id: "4955", name: "Special Equipment Surcharge (Common)" },
        duty:         { id: "4924", name: "Duty (DUTY/VAT)" },
        vat:          { id: "4925", name: "VAT (DUTY/VAT)" },
        extraCosts:   { id: "5794", name: "Extra Costs (Common)" },

        // --- available but not currently mapped (see reference list below) ---
        scanningFee:      { id: "4968", name: "Scanning Fee (Common)" },
        gasMeasurement:   { id: "5101", name: "Gas Measurement (Common)" },
        kcb:              { id: "5102", name: "KCB Charges (Common)" },
        fumigation:       { id: "5118", name: "Fumigation Charges (Common)" },
        customsFine:      { id: "5270", name: "Customs Fine (Common)" },
        certOrigin:       { id: "4938", name: "Certificate of Origin (Common)" },
        vgm:              { id: "5107", name: "VGM (Common)" },
        lashing:          { id: "4950", name: "Lashing and Securing (Common)" },
        imo:              { id: "4931", name: "IMO Surcharge (Common)" },
        antiDumping:      { id: "5120", name: "Anti Dumping Charges (DUTY/VAT)" },
        barging:          { id: "5138", name: "Barging (Common)" },
        airfreight:       { id: "4936", name: "Airfreight (Common)" },
        postage:          { id: "5121", name: "Postage  (Common)" },
        commission:       { id: "5137", name: "Commission (Common)" },
        insurance:        { id: "4948", name: "Insurance (Common)" },
        adminFeeDest:     { id: "4983", name: "Admin Fee Destination (Common)" },
        containerInspect: { id: "4981", name: "Container inspection fees and survey fees (Common)" },
        containerProtect: { id: "4982", name: "Container Protect Essential (Common)" },
        terminalSecDest:  { id: "4985", name: "Terminal Security Destination (Common)" },
        equipMaintenance: { id: "4984", name: "Equipment Mainenance Fee (Common)" },
        importTerminal:   { id: "4967", name: "Import Terminal & Transfer Fee (Common)" },
        congestion:       { id: "4939", name: "Congestion Surcharge (Common)" },
        emergencyFuel:    { id: "5569", name: "Emergency Fuel Surcharge (Common)" },
        terminalClimate:  { id: "5543", name: "Terminal Climate Fee (Common)" },
        oceanFreight:     { id: "4929", name: "Ocean Freight (Common)" },
        plugIn:           { id: "4955", name: "Special Equipment Surcharge (Common)" },
        closureTransit:   { id: "5134", name: "Closure of Transit Document (Common)" },
        stopGoCheckpoint: { id: "5109", name: "Stop & Go Checkpoint (Common)" },
        storageCustomsDoc:{ id: "5112", name: "Storage Customs Document (Common)" },
        containerHandling:{ id: "5116", name: "Container Handling  (Common)" },
        warehouseInOut:   { id: "5115", name: "Warehouse IN/OUT (Common)" },
        warehouseStorage: { id: "4956", name: "Warehouse Storage (Common)" },
        crossdock:        { id: "5104", name: "Crossdock Charges (Common)" },
        deliveryCharges:  { id: "5103", name: "Delivery Charges (Common)" },
        noShow:           { id: "4964", name: "No Show (Common)" },
        fiscalRep:        { id: "5136", name: "Import Fiscal Representation (Common)" },
        t2l:              { id: "4957", name: "T2L(F) (Common)" },
        exportDoc:        { id: "4941", name: "Export Document (Common)" },
        tolheffing:       { id: "5916", name: "Tolheffing (Common)" }
    };

    /* -------------------------------------------------------------------------
       FULL LEDGER REFERENCE (FitOnPortal) - for picking a better match later.

       4924 Duty (DUTY/VAT)                        4983 Admin Fee Destination
       4925 VAT (DUTY/VAT)                         4984 Equipment Mainenance Fee
       4928 Advance fee                            4985 Terminal Security Destination
       4929 Ocean Freight                          5101 Gas Measurement
       4930 Trucking Costs                         5102 KCB Charges
       4931 IMO Surcharge                          5103 Delivery Charges
       4932 Fuel Surcharge                         5104 Crossdock Charges
       4933 Storage Charges                        5105 Customs Inspection (X-ray/Physical)
       4934 Demurrage                              5106 Miscellaneous
       4935 Detention                              5107 VGM
       4936 Airfreight                             5108 Dolavs
       4937 Bill of Lading Fee                     5109 Stop & Go Checkpoint
       4938 Certificate of Origin                  5110 Extra Stop
       4939 Congestion Surcharge                   5111 Mobility Charges
       4940 Courier Fee                            5112 Storage Customs Document
       4941 Export Document                        5113 Toll/Maut Surcharge
       4942 Import Document                        5114 Consultancy Fee
       4943 Transit Document                       5115 Warehouse IN/OUT
       4944 Delivery Order Fee                     5116 Container Handling
       4945 Documentation Fee                      5118 Fumigation Charges
       4946 Emergency Risk Surcharge               5119 Extra HS Codes
       4947 Handling Fee                           5120 Anti Dumping Charges (DUTY/VAT)
       4948 Insurance                              5121 Postage
       4949 ISPS                                   5134 Closure of Transit Document
       4950 Lashing and Securing                   5136 Import Fiscal Representation
       4951 Manifest Correction                    5137 Commission
       4952 Peak Season Surcharge                  5138 Barging
       4953 Piracy Surcharge                       5266 Duty - Bond (DUTY/VAT)
       4954 Profit Share                           5270 Customs Fine
       4955 Special Equipment Surcharge            5344 CMR
       4956 Warehouse Storage                      5527 Cancellation Fee
       4957 T2L(F)                                 5531 Dangerous Goods Declaration (DGD)
       4958 Telex Release Fee                      5533 IMO Declaration Port Authorities
       4959 Terminal Handling Charges              5543 Terminal Climate Fee
       4960 Waiting Hours                          5546 Purchase Container
       4961 GGB Entry                              5558 EUR-1 Document
       4962 VET Check                              5569 Emergency Fuel Surcharge
       4963 NVWA Charges                           5794 Extra Costs
       4964 No Show                                5809 Cargo Rent
       4965 Emission Trading System Charges        5916 Tolheffing
       4966 Airfreight Handling Fee                5917 Uittreksel KVK
       4967 Import Terminal & Transfer Fee         5926 EXCISE DOCUMENT / E-AD
       4968 Scanning Fee                           4971 Guidance Document
       4969 Security Fee                           4981 Container inspection/survey fees
       4982 Container Protect Essential
       ------------------------------------------------------------------------- */

    /* =========================================================================
       CARRIER COST TEMPLATES
       -------------------------------------------------------------------------
       Carrier arrival invoices repeat the same handful of charges; only the
       amounts differ per carrier and container type. So the CHARGE LIST is fixed
       here and the AMOUNTS live in storage, per carrier + container type. Type
       them once and they are remembered; or point the extension at a rates URL
       and one person maintains them for everyone (Instellingen > Tarieven).

       Seeded from a real Hapag-Lloyd arrival notice: 40' HC reefer, Buenos Aires
       to Rotterdam - admin fee 65, terminal security 30, THC 370, equipment
       maintenance 30, total 495 EUR.
       ========================================================================= */
    /* Suppliers that send consolidated specifications, with their FitOn creditor. */
    const SPEC_SUPPLIERS = [
        { key: 'lineage', name: 'Lineage Rotterdam Maasvlakte B.V.', code: 'LINEMAA', creditorSeq: '71587',
          match: /lineage/i }
    ];

    const CARRIERS = [
        { key: 'hapag', creditorSeq: '66205', account: '54443735',      name: 'Hapag-Lloyd',  creditorHints: ['HAPAG', 'HLCU', 'HLBU'],
          tariff: 'https://www.hapag-lloyd.com/en/online-business/quotation/tariffs/local-charges-service-fees.html' },
        { key: 'msc', creditorSeq: '66208', account: '1001467713',        name: 'MSC',          creditorHints: ['MEDIROT', 'MSC', 'MEDU'],
          tariff: 'https://www.msc.com/en/local-information/europe/netherlands' },
        { key: 'maersk', creditorSeq: '66204', account: '20289178',     name: 'Maersk',       creditorHints: ['MAERSK', 'MAEU'],
          tariff: 'https://www.maersk.com/local-information/europe/netherlands/import' },
        { key: 'cmacgm', creditorSeq: '66203', account: '0007337250/001',     name: 'CMA CGM',      creditorHints: ['CMA CGM', 'CMDU'],
          tariff: 'https://www.cma-cgm.com/local/netherlands/tariffs-local-charges' },
        { key: 'oocl', creditorSeq: '71415', account: '8137444000',       name: 'OOCL',         creditorHints: ['OOCL', 'OOLU'],
          tariff: 'https://www.oocl.com/netherlands/eng/localinformation/localsurcharges/Pages/Local%20Port%20Charges%20Netherlands.aspx' },
        { key: 'yangming', creditorSeq: '66548', account: 'CORYBROTHENLRHO',   name: 'Yang Ming',    creditorHints: ['YANG MING', 'YMLU'], tariff: '' },
        { key: 'evergreen', creditorSeq: '66547',  name: 'Evergreen',    creditorHints: ['EVERGREEN', 'EGLV'], tariff: '' },
        { key: 'one', creditorSeq: '66378', account: 'NL506502',        name: 'ONE',          creditorHints: ['OCEAN NETWORK', 'ONEY'], tariff: '' },
        { key: 'cosco', creditorSeq: '66210',      name: 'COSCO',        creditorHints: ['COSCO', 'COSU'], tariff: '' },
        { key: 'hamburgsud', name: 'Hamburg Süd',  creditorHints: ['HAMBURG SUD', 'SUDU'], tariff: '' }
    ];

    const CONTAINER_TYPES = [
        { key: '40RF', label: "40' HC reefer" },
        { key: '20RF', label: "20' reefer" },
        { key: '40DV', label: "40' dry" },
        { key: '40HC', label: "40' HC dry" },
        { key: '20DV', label: "20' dry" }
    ];

    // The charges a carrier arrival invoice is made of.
    const CARRIER_CHARGES = [
        // Every line below appears on at least one of the arrival invoices.
        { key: 'thc',        ledger: LEDGER.thc,              desc: 'THC destination' },
        { key: 'docfee',     ledger: LEDGER.docs,             desc: 'Documentation fee destination' },
        { key: 'admin',      ledger: LEDGER.adminFeeDest,     desc: 'Admin fee destination' },
        { key: 'importfee',  ledger: LEDGER.handling,         desc: 'Import handling / service fee' },
        { key: 'security',   ledger: LEDGER.terminalSecDest,  desc: 'Terminal / port security charge' },
        { key: 'equipment',  ledger: LEDGER.equipMaintenance, desc: 'Equipment maintenance / management fee' },
        { key: 'inspection', ledger: LEDGER.containerInspect, desc: 'Container inspection / survey fee' },
        { key: 'protect',    ledger: LEDGER.containerProtect, desc: 'Container Protect Essential' },
        { key: 'pluginfee',  ledger: LEDGER.specialEquip,     desc: 'Initial plug-in fee' },
        { key: 'isps',       ledger: LEDGER.isps,             desc: 'ISPS' },
        { key: 'congestion', ledger: LEDGER.congestion,       desc: 'Congestion surcharge' },
        { key: 'climate',    ledger: LEDGER.terminalClimate,  desc: 'Terminal climate fee' },
        { key: 'fuel',       ledger: LEDGER.emergencyFuel,    desc: 'Emergency fuel surcharge' },
        { key: 'transfer',   ledger: LEDGER.importTerminal,   desc: 'Import terminal & transfer fee' },
        { key: 'demurrage',  ledger: LEDGER.demurrage,        desc: 'Demurrage' },
        { key: 'detention',  ledger: LEDGER.detention,        desc: 'Detention' },
        { key: 'storage',    ledger: LEDGER.storage,          desc: 'Storage charges' }
    ];

    // carrierRates[carrier][containerType][chargeKey] = amount
    const SEED_CARRIER_RATES = {
        // Taken from seven real arrival invoices into Rotterdam, all 40' reefer,
        // August-September 2026. Amounts in EUR, excl. VAT (all were 0% VAT).
        hapag:     { '40RF': { thc: 370.00, admin: 65.00, security: 30.00, equipment: 30.00 } },        // inv 2512134858, Buenos Aires - 495,00
        msc:       { '40RF': { thc: 335.00, importfee: 58.00, security: 25.00, inspection: 23.00 } },   // inv NL260903808I, Rio Grande - 441,00
        yangming:  { '40RF': { thc: 325.00, importfee: 75.00, isps: 17.00, pluginfee: 60.00, inspection: 30.00 } }, // inv 1416801, Ningbo - 507,00
        oocl:      { '40RF': { thc: 355.00, docfee: 50.00 } },                                          // inv 513 26688DH, Dalian - 405,00
        cmacgm:    { '40RF': { thc: 350.00, docfee: 50.00, equipment: 40.00, inspection: 45.00 } },     // inv NLIC0125218, Santos - 485,00
        maersk:    { '40RF': { thc: 385.00, docfee: 50.00, protect: 28.00 } },                          // inv 7556325038, Paita - 463,00
        one:       { '40RF': { thc: 370.00, docfee: 56.00, security: 20.00, equipment: 27.00 } }        // inv 310020202520, Chittagong - 473,00
    };

    CARRIER_RATES = JSON.parse(JSON.stringify(SEED_CARRIER_RATES));

    const CLIENTS = {
        vbfood: {
            name: 'VB Food International AG',
            subtitle: 'Basel, Switzerland · offer 27-03-2026 · payment 21 days',
            lang: 'en',
            ggb:             { price: 31.00, desc: 'CHED / CVED' },
            inspectionPoint: { price: 105.00, desc: 'Use of inspection point' },
            copyChed:        { price: 10.00, desc: 'Copy CHED / CVED', defaultQty: 1 },
            afterHours:      { price: 16.00, desc: 'Extra charges inspection point after 17:00 hrs (15%)' },
            catchCerts: false,
            genset:  { price: 155.00, desc: 'Gen-Set surcharge', defaultChecked: false },
            plugin:  { price: 57.00, desc: 'Plug-in charges at Coldstore Frigocare per container', label: 'Plug-in days Coldstore Frigocare' },
            chassis: { price: 62.00, desc: 'Chassis rental per chassis, per calendar day' },
            waiting: { price: 67.00, desc: 'Waiting hours terminal, inspection points, unloading and loading' },
            dieselDefault: '35%',
            dieselIncluded: 0,
            fixedFuelBase: 0,
            nvwaPerKgLine: false,
            nvwaDesc: kg => `Net weight: ${kg} kg`,
            options: [
                { key: 't1',         ledger: LEDGER.transit,  desc: 'Transit document from (T1)', price: 41.00 },
                { key: 'reexport',   ledger: LEDGER.transit,  desc: 'Re-Exportdocument', price: 41.00 },
                { key: 'splitcved',  ledger: LEDGER.docs,     desc: 'Splitting CVED', price: 15.50 },
                { key: 'maasvlakte', perCtr: true, ledger: LEDGER.trucking, desc: 'Surcharge Maasvlakte Terminals (incl. 1 hr free pick-up/delivery)', price: 83.00, fuelBase: true },
                { key: 'multishop', perCtr: true,  ledger: LEDGER.trucking, desc: 'Multishop checkpoint surcharge 1 hour free', price: 67.00 },
                { key: 'noshowlineage', ledger: LEDGER.noShow, desc: 'Inspection point no show Lineage', price: 60.00 },
                { key: 'noshowthermo',  ledger: LEDGER.noShow, desc: 'Inspection point no show Thermotraffic', price: 160.00 }
            ],
            debtorHints: ['VB Food', 'VBFOOD', 'VB FOOD INTERNATIONAL'],
            extras: [
                { group: 'Terminal Matrans', key: 'mat_thc', ledger: LEDGER.containerHandling, desc: 'Matrans: container handling fee, off and on chassis', price: 125.00, unit: 'ctr' },
                { group: 'Terminal Matrans', key: 'mat_plug1', ledger: LEDGER.plugIn, desc: 'Matrans: storage & plug-in day 1', price: 47.50, unit: 'dag' },
                { group: 'Terminal Matrans', key: 'mat_plug2', ledger: LEDGER.plugIn, desc: 'Matrans: storage & plug-in day 2 and onwards', price: 37.50, unit: 'dag' },
                { group: 'Terminal Matrans', key: 'mat_admin', ledger: LEDGER.docs, desc: 'Matrans: administration and customs handling', price: 90.00, unit: 'ctr' },
                { group: 'Terminal Matrans', key: 'mat_storage', ledger: LEDGER.warehouseStorage, desc: 'Matrans: storage per day', price: 12.50, unit: 'dag' },
                { group: 'Terminal Rhenus', key: 'rhe_thc', ledger: LEDGER.containerHandling, desc: 'Rhenus: container handling fee, off and on chassis', price: 125.00, unit: 'ctr' },
                { group: 'Terminal Rhenus', key: 'rhe_plug', ledger: LEDGER.plugIn, desc: 'Rhenus: plug-in per container per day', price: 75.00, unit: 'dag' },
                { group: 'Terminal Rhenus', key: 'rhe_storage', ledger: LEDGER.warehouseStorage, desc: 'Rhenus: storage per day', price: 12.50, unit: 'dag' }
            ],
            base: [
                { ledger: LEDGER.vet,      desc: 'Inspection appointment', qty: 1.000, price: 16.00, perCtr: true },
                { ledger: LEDGER.handling, desc: 'Handling fee',           qty: 1.000, price: 31.00, perCtr: true }
            ]
        },

        eurofoodlink: {
            name: 'Eurofoodlink B.V.',
            subtitle: 'Breda, Nederland · offerte 27-03-2026 · betaling 30 dagen',
            lang: 'nl',
            ggb:             { price: 36.00, desc: 'CHED / CVED' },
            inspectionPoint: { price: 105.00, desc: 'Gebruik keurpunt en facilitaire kosten' },
            copyChed:        { price: 20.50, desc: 'Kopie GGB / CVED (bij opslag/overladen)', defaultQty: 0 },
            afterHours:      { price: 15.75, desc: 'Toeslag keurpunt na 17:00 uur (15%)' },
            catchCerts: { catchDesc: 'Vangstcertificaat', procDesc: 'Verwerkingsverklaring' },
            genset:  { price: 160.00, desc: 'Gen-Set toeslag', defaultChecked: true },
            plugin:  null,
            chassis: { price: 69.00, desc: 'Chassishuur per chassis, per kalenderdag' },
            waiting: { price: 69.00, desc: 'Wachturen terminal, keurpunten, laden en lossen' },
            dieselDefault: '21%',
            dieselIncluded: 0,
            fixedFuelBase: 85.00,   // Maasvlakte toeslag zit in de vaste template
            nvwaPerKgLine: false,
            nvwaDesc: kg => `Netto gewicht: ${kg} kg`,
            tantieme: ['Fix Fisch', 'EBO v/d Bor', 'Seafood Centre', 'Marcel Wijen', 'Dun Yong Food Services'],
            options: [
                { key: 't1',        ledger: LEDGER.transit, desc: 'Transit document (T1)', price: 46.00 },
                { key: 'opslagdoc', ledger: LEDGER.transit, desc: 'Opslagdocument transito', price: 36.00 },
                { key: 'afmeldt1',  ledger: LEDGER.transit, desc: 'Afmelden T1 document', price: 25.00 },
                { key: 'zegel',     ledger: LEDGER.docs,    desc: 'Douane verzegeling container', price: 15.00 },
                { key: 'uitvoer',   ledger: LEDGER.docs,    desc: 'Aangifte ten uitvoer directe vertegenwoordiging', price: 46.00 },
                { key: 'noshowlineage', ledger: LEDGER.noShow, desc: 'Kosten keurpunt bij no show Lineage', price: 60.00 },
                { key: 'noshowthermo',  ledger: LEDGER.noShow, desc: 'Kosten keurpunt bij no show Thermotraffic', price: 160.00 }
            ],
            debtorHints: ['Eurofoodlink', 'EUROFOOD'],
            extras: [
                { group: 'Frigocare (Lineage)', key: 'inuitslag', ledger: LEDGER.warehouseInOut, desc: 'In- en uitslag per pallet of overladen per pallet', price: 12.60, unit: 'pallet' },
                { group: 'Frigocare (Lineage)', key: 'inuitslaglos', ledger: LEDGER.warehouseInOut, desc: 'In- en uitslag of overladen los (bruto gewicht)', price: 31.50, unit: 'ton' },
                { group: 'Frigocare (Lineage)', key: 'overladenpallet', ledger: LEDGER.crossdock, desc: 'Overladen pallet - vaste prijs', price: 315.00, unit: 'ctr' },
                { group: 'Frigocare (Lineage)', key: 'sorteren', ledger: LEDGER.warehouseInOut, desc: 'Sorteerkosten 2 t/m 5 soorten (bruto gewicht)', price: 8.65, unit: 'ton' },
                { group: 'Frigocare (Lineage)', key: 'folie', ledger: LEDGER.warehouseInOut, desc: 'Folien pallets', price: 5.00, unit: 'pallet' },
                { group: 'Frigocare (Lineage)', key: 'opslag', ledger: LEDGER.warehouseStorage, desc: 'Opslag per kalenderweek of gedeeltelijk', price: 4.45, unit: 'pallet/week' },
                { group: 'Frigocare (Lineage)', key: 'shunting', ledger: LEDGER.containerHandling, desc: 'Container shunting van en aan het dok', price: 52.50, unit: 'ctr' },
                { group: 'Frigocare (Lineage)', key: 'weging', ledger: LEDGER.misc, desc: 'Container / truck weging', price: 47.25, unit: 'unit' },
                { group: 'Frigocare (Lineage)', key: 'europallet', ledger: LEDGER.misc, desc: 'Europallets indien niet geruild', price: 20.00, unit: 'pallet' },
                { group: 'Terminal Matrans', key: 'mat_thc', ledger: LEDGER.containerHandling, desc: 'Matrans: terminal handling, afzetten en opzetten', price: 125.00, unit: 'ctr' },
                { group: 'Terminal Matrans', key: 'mat_plug1', ledger: LEDGER.plugIn, desc: 'Matrans: plug-in kosten dag 1', price: 47.50, unit: 'dag' },
                { group: 'Terminal Matrans', key: 'mat_plug2', ledger: LEDGER.plugIn, desc: 'Matrans: plug-in kosten vanaf dag 2', price: 37.50, unit: 'dag' },
                { group: 'Terminal Matrans', key: 'mat_admin', ledger: LEDGER.docs, desc: 'Matrans: administratie en douanedocumentatie', price: 85.00, unit: 'ctr' },
                { group: 'Terminal Rhenus', key: 'rhe_thc', ledger: LEDGER.containerHandling, desc: 'Rhenus: terminal handling, afzetten en opzetten', price: 125.00, unit: 'ctr' },
                { group: 'Terminal Rhenus', key: 'rhe_plug', ledger: LEDGER.plugIn, desc: 'Rhenus: plug-in kosten per kalenderdag', price: 75.00, unit: 'dag' },
                { group: 'Terminal Rhenus', key: 'rhe_admin', ledger: LEDGER.docs, desc: 'Rhenus: administratie en douanedocumentatie', price: 85.00, unit: 'ctr' },
                { group: 'Terminal Rhenus', key: 'rhe_opslag', ledger: LEDGER.warehouseStorage, desc: 'Rhenus: opslag per kalenderdag', price: 12.50, unit: 'dag' }
            ],
            base: [
                { ledger: LEDGER.vet,       desc: 'Administratieve afwikkeling documentatie', qty: 1.000, price: 18.00 },
                { ledger: LEDGER.vet,       desc: 'Aanmelden van de inspectie',               qty: 1.000, price: 41.00, perCtr: true },
                { ledger: LEDGER.importDoc, desc: 'Maken van invoeraangifte',                 qty: 1.000, price: 82.00 },
                { ledger: LEDGER.handling,  desc: 'Handling fee',                             qty: 1.000, price: 41.00, perCtr: true },
                { ledger: LEDGER.extraStop, desc: 'Toeslag extra stop keurpunt',              qty: 1.000, price: 69.00, perCtr: true },
                { ledger: LEDGER.trucking,  desc: 'Maasvlakte terminal toeslag',              qty: 1.000, price: 85.00, perCtr: true }
            ]
        },

        kuhneheitz: {
            name: 'Kuhne + Heitz',
            subtitle: 'Dordrecht, Nederland · offerte 02-04-2026 · betaling 30 dagen',
            lang: 'nl',
            // CHED / CVED wordt als GGB Entry geboekt - nooit dubbel.
            ggb:             { price: 31.00, desc: 'CHED / CVED' },
            inspectionPoint: { price: 105.00, desc: 'Gebruik keurpunt' },
            copyChed:        { price: 21.00, desc: 'Kopie GGB / CVED (bij opslag/overladen)', defaultQty: 1 },
            afterHours:      { price: 15.75, desc: 'Toeslag keurpunt na 17:00 uur (15%)' },
            catchCerts: { catchDesc: 'Vangstcertificaat + importeursdecl', procDesc: 'Verwerkingsverklaring' },
            genset:  { price: 160.00, desc: 'Gen-Set toeslag', defaultChecked: true },
            plugin:  { price: 55.00, desc: 'Reefer plug-in kosten per container per kalenderdag (Frigocare)', label: 'Reefer plug-in dagen Frigocare' },
            chassis: { price: 69.00, desc: 'Chassishuur per chassis, per kalenderdag' },
            waiting: { price: 69.00, desc: 'Wachturen lossen' },
            dieselDefault: '32%',
            dieselIncluded: 0.15,   // tarieven zijn inclusief 15% dieseltoeslag
            fixedFuelBase: 0,
            nvwaPerKgLine: true,    // factuurregel als aantal kg x 0,01377
            nvwaDesc: kg => `NVWA keurloon, netto gewicht: ${kg} kg`,
            options: [
                { key: 't1keurpunt',   ledger: LEDGER.transit, desc: 'T1 van terminal naar keurpunt', price: 36.00 },
                { key: 't1bestemming', ledger: LEDGER.transit, desc: 'T1 van keurpunt naar bestemming', price: 41.00 },
                { key: 't2l',          ledger: LEDGER.docs,    desc: 'T2L document', price: 41.00 },
                { key: 'zegel',        ledger: LEDGER.docs,    desc: 'Douane verzegeling container', price: 8.00 },
                { key: 'uitvoer',      ledger: LEDGER.docs,    desc: 'Aangifte ten uitvoer directe vertegenwoordiging', price: 51.00 },
                { key: 'noshowlineage', ledger: LEDGER.noShow, desc: 'Kosten keurpunt bij no show Lineage', price: 60.00 },
                { key: 'noshowthermo',  ledger: LEDGER.noShow, desc: 'Kosten keurpunt bij no show Thermotraffic', price: 160.00 }
            ],
            debtorHints: ['Kuhne + Heitz', 'Kühne + Heitz', 'KUHNDOR', 'Kuhne en Heitz'],
            extras: [
                { group: 'Frigocare', key: 'inuitslag', ledger: LEDGER.warehouseInOut, desc: 'In- en uitslag per pallet (ook indien los/los)', price: 12.50, unit: 'pallet' },
                { group: 'Frigocare', key: 'losseCartons', ledger: LEDGER.warehouseInOut, desc: 'In- en uitslag toeslag losse cartons (bruto gewicht)', price: 30.50, unit: 'ton' },
                { group: 'Frigocare', key: 'sorteren25', ledger: LEDGER.warehouseInOut, desc: 'Sorteerkosten 2 t/m 5 soorten (bruto gewicht)', price: 8.40, unit: 'ton' },
                { group: 'Frigocare', key: 'sorteren610', ledger: LEDGER.warehouseInOut, desc: 'Sorteerkosten 6 t/m 10 soorten (bruto gewicht)', price: 11.00, unit: 'ton' },
                { group: 'Frigocare', key: 'folie', ledger: LEDGER.warehouseInOut, desc: 'Folien pallets', price: 4.70, unit: 'pallet' },
                { group: 'Frigocare', key: 'opslag', ledger: LEDGER.warehouseStorage, desc: 'Opslag per kalenderweek of gedeeltelijk', price: 4.35, unit: 'pallet/week' },
                { group: 'Frigocare', key: 'shunting', ledger: LEDGER.containerHandling, desc: 'Container shunting van en aan het dok', price: 52.50, unit: 'ctr' },
                { group: 'Frigocare', key: 'weging', ledger: LEDGER.misc, desc: 'Container / truck weging', price: 47.00, unit: 'unit' },
                { group: 'Frigocare', key: 'labelling', ledger: LEDGER.misc, desc: 'Labelling / stickeren', price: 0.55, unit: 'sticker' },
                { group: 'Lineage Maasvlakte', key: 'lin_plug', ledger: LEDGER.plugIn, desc: 'Lineage: reefer plug-in en parking per container', price: 94.50, unit: 'dag' },
                { group: 'Lineage Maasvlakte', key: 'lin_shunt', ledger: LEDGER.containerHandling, desc: 'Lineage: shunten container', price: 52.50, unit: 'ctr' },
                { group: 'Terminal Matrans', key: 'mat_thc', ledger: LEDGER.containerHandling, desc: 'Matrans: terminal handling, afzetten en opzetten', price: 125.00, unit: 'ctr' },
                { group: 'Terminal Matrans', key: 'mat_plug1', ledger: LEDGER.plugIn, desc: 'Matrans: plug-in kosten dag 1', price: 47.50, unit: 'dag' },
                { group: 'Terminal Matrans', key: 'mat_plug2', ledger: LEDGER.plugIn, desc: 'Matrans: plug-in kosten vanaf dag 2', price: 37.50, unit: 'dag' },
                { group: 'Terminal Matrans', key: 'mat_admin', ledger: LEDGER.docs, desc: 'Matrans: administratie en douanedocumentatie', price: 85.00, unit: 'ctr' },
                { group: 'Terminal Rhenus', key: 'rhe_thc', ledger: LEDGER.containerHandling, desc: 'Rhenus: terminal handling, afzetten en opzetten', price: 125.00, unit: 'ctr' },
                { group: 'Terminal Rhenus', key: 'rhe_plug', ledger: LEDGER.plugIn, desc: 'Rhenus: plug-in kosten per kalenderdag', price: 75.00, unit: 'dag' },
                { group: 'Terminal Rhenus', key: 'rhe_admin', ledger: LEDGER.docs, desc: 'Rhenus: administratie en douanedocumentatie', price: 85.00, unit: 'ctr' },
                { group: 'Terminal Rhenus', key: 'rhe_opslag', ledger: LEDGER.warehouseStorage, desc: 'Rhenus: opslag per kalenderdag', price: 12.50, unit: 'dag' }
            ],
            base: [
                { ledger: LEDGER.vet,      desc: 'Aanmelden inspectie',      qty: 1.000, price: 21.00, perCtr: true },
                { ledger: LEDGER.vet,      desc: 'Afwikkeling documentatie', qty: 1.000, price: 16.00 },
                { ledger: LEDGER.handling, desc: 'Handling fee',             qty: 1.000, price: 26.00, perCtr: true }
            ]
        },

        anduronda: {
            name: 'Anduronda Import GmbH',
            subtitle: 'Köln, Germany · offer 27-03-2026 · payment 21 days',
            lang: 'en',
            ggb:             { price: 36.00, desc: 'CHED / CVED' },
            inspectionPoint: { price: 105.00, desc: 'Use of inspection point' },
            copyChed:        { price: 20.00, desc: 'Copy CHED / CVED', defaultQty: 1 },
            afterHours:      { price: 15.75, desc: 'Extra charges inspection point after 17:00 hrs (15%)' },
            catchCerts: { catchDesc: 'Catch certificate', procDesc: 'Handling processing statement' },
            genset:  { price: 153.00, desc: 'Gen-Set surcharge', defaultChecked: true, ledger: LEDGER.trucking },
            plugin:  { price: 57.50, desc: 'Reefer plug-in charges per container per calendar day', label: 'Reefer plug-in days' },
            chassis: { price: 66.00, desc: 'Chassis rental per chassis, per calendar day' },
            waiting: { price: 66.00, desc: 'Waiting hours terminal, inspection points, unloading and loading' },
            dieselDefault: '21%',
            dieselIncluded: 0,
            fixedFuelBase: 82.00,   // Maasvlakte surcharge is part of the fixed template
            nvwaPerKgLine: false,
            nvwaDesc: kg => `Net weight: ${kg} kg`,
            options: [
                { key: 't1checkpoint',  ledger: LEDGER.transit, desc: 'Transit document from Terminal to Checkpoint (T1)', price: 41.00 },
                { key: 't1destination', ledger: LEDGER.transit, desc: 'Transit document from Checkpoint to Destination (T1)', price: 41.00 },
                { key: 'seal',          ledger: LEDGER.docs,    desc: 'Customs seal - under transit', price: 12.50 },
                { key: 'noshowlineage', ledger: LEDGER.noShow, desc: 'Inspection point no show Lineage', price: 60.00 },
                { key: 'noshowthermo',  ledger: LEDGER.noShow, desc: 'Inspection point no show Thermotraffic', price: 160.00 }
            ],
            debtorHints: ['Anduronda', 'ANDURONDA'],
            extras: [
                { group: 'Coldstore', key: 'inouttake', ledger: LEDGER.warehouseInOut, desc: 'In and outtake, crossdocking if palletized', price: 12.30, unit: 'pallet' },
                { group: 'Coldstore', key: 'inouttakeloose', ledger: LEDGER.warehouseInOut, desc: 'In and outtake, not palletized / loose (grossweight)', price: 31.50, unit: 'ton' },
                { group: 'Coldstore', key: 'crossloose', ledger: LEDGER.crossdock, desc: 'Crossdocking, not palletized / loose (grossweight)', price: 31.50, unit: 'ton' },
                { group: 'Coldstore', key: 'crosspallet', ledger: LEDGER.crossdock, desc: 'Crossdocking palletized by truck, fixed price per unit', price: 315.00, unit: 'unit' },
                { group: 'Coldstore', key: 'sorting25', ledger: LEDGER.warehouseInOut, desc: 'Sorting sizes 2 to 5 (grossweight)', price: 9.00, unit: 'ton' },
                { group: 'Coldstore', key: 'sorting610', ledger: LEDGER.warehouseInOut, desc: 'Sorting sizes 6 to 10 (grossweight)', price: 10.75, unit: 'ton' },
                { group: 'Coldstore', key: 'foil', ledger: LEDGER.warehouseInOut, desc: 'Foil wrapping pallets', price: 4.70, unit: 'pallet' },
                { group: 'Coldstore', key: 'storage', ledger: LEDGER.warehouseStorage, desc: 'Storage costs per calendar week', price: 4.45, unit: 'pallet/week' },
                { group: 'Coldstore', key: 'shunting', ledger: LEDGER.containerHandling, desc: 'Container shunting - checkpoint & coldstore on and off dock', price: 52.50, unit: 'ctr' },
                { group: 'Coldstore', key: 'weighing', ledger: LEDGER.misc, desc: 'Container / truck weighing', price: 49.50, unit: 'unit' },
                { group: 'Terminal RCT', key: 'rct_handling', ledger: LEDGER.containerHandling, desc: 'RCT: container handling fee, off and on chassis', price: 40.00, unit: 'ctr' },
                { group: 'Terminal RCT', key: 'rct_storage', ledger: LEDGER.plugIn, desc: 'RCT: storage & plug-in per calendar day', price: 60.00, unit: 'dag' },
                { group: 'Terminal Matrans', key: 'mat_thc', ledger: LEDGER.containerHandling, desc: 'Matrans: container handling fee, off and on chassis', price: 125.00, unit: 'ctr' },
                { group: 'Terminal Matrans', key: 'mat_plug1', ledger: LEDGER.plugIn, desc: 'Matrans: storage & plug-in day 1', price: 47.50, unit: 'dag' },
                { group: 'Terminal Matrans', key: 'mat_plug2', ledger: LEDGER.plugIn, desc: 'Matrans: storage & plug-in day 2 and onwards', price: 37.50, unit: 'dag' },
                { group: 'Terminal Matrans', key: 'mat_admin', ledger: LEDGER.docs, desc: 'Matrans: administration and customs handling', price: 85.00, unit: 'ctr' },
                { group: 'Terminal Matrans', key: 'mat_storage', ledger: LEDGER.warehouseStorage, desc: 'Matrans: storage per day', price: 12.50, unit: 'dag' },
                { group: 'Terminal Rhenus', key: 'rhe_thc', ledger: LEDGER.containerHandling, desc: 'Rhenus: container handling fee, off and on chassis', price: 125.00, unit: 'ctr' },
                { group: 'Terminal Rhenus', key: 'rhe_plug', ledger: LEDGER.plugIn, desc: 'Rhenus: plug-in per container per day', price: 75.00, unit: 'dag' },
                { group: 'Terminal Rhenus', key: 'rhe_storage', ledger: LEDGER.warehouseStorage, desc: 'Rhenus: storage per day', price: 12.50, unit: 'dag' }
            ],
            base: [
                { ledger: LEDGER.extraStop, desc: 'Checkpoint Stop',                                                    qty: 1.000, price: 66.00, perCtr: true },
                { ledger: LEDGER.importDoc, desc: 'Import customs clearance processing',                                 qty: 1.000, price: 67.00 },
                { ledger: LEDGER.trucking,  desc: 'Surcharge Maasvlakte Terminals (incl. 1 hr free pick-up/delivery)',   qty: 1.000, price: 82.00, perCtr: true },
                { ledger: LEDGER.vet,       desc: 'Inspection appointment',                                              qty: 1.000, price: 21.00, perCtr: true },
                { ledger: LEDGER.vet,       desc: 'Inspection point surcharge for handling customs document(s)',         qty: 1.000, price: 18.00 }
            ]
        },

        dutchseafood: {
            name: 'Dutch Seafood Trading B.V.',
            subtitle: 'Hoofddorp, Netherlands · offer 27-03-2026 · payment 21 days',
            lang: 'en',
            ggb:             { price: 41.00, desc: 'CHED / CVED' },
            inspectionPoint: { price: 120.00, desc: 'Use of inspection point' },
            copyChed:        { price: 21.00, desc: 'Copy CHED / CVED (on request before inspection)', defaultQty: 0 },
            afterHours:      { price: 15.75, desc: 'Extra charges inspection point after 17:00 hrs (15%)' },
            catchCerts: false,
            genset:  { price: 150.00, desc: 'Gen-Set surcharge', defaultChecked: true },
            plugin:  null,
            chassis: null,          // no chassis rental rate in this offer
            waiting: { price: 70.00, desc: 'Waiting hours terminal, inspection points, unloading and loading' },
            dieselDefault: '21%',
            dieselIncluded: 0,
            fixedFuelBase: 0,
            nvwaPerKgLine: false,
            nvwaDesc: kg => `Net weight: ${kg} kg`,
            options: [
                { key: 't1checkpoint', ledger: LEDGER.transit,  desc: 'Transit document Checkpoint (T1)', price: 51.00 },
                { key: 'maasvlakte', perCtr: true,   ledger: LEDGER.trucking, desc: 'Surcharge Maasvlakte Terminals (incl. 1 hr free pick-up/delivery)', price: 86.00, fuelBase: true },
                { key: 'multishop', perCtr: true,    ledger: LEDGER.trucking, desc: 'Multishop checkpoint surcharge 1 hour free', price: 70.00 },
                { key: 'noshowlineage', ledger: LEDGER.noShow, desc: 'Inspection point no show Lineage', price: 60.00 },
                { key: 'noshowthermo',  ledger: LEDGER.noShow, desc: 'Inspection point no show Thermotraffic', price: 160.00 }
            ],
            debtorHints: ['Dutch Seafood', 'DUTCHSEA', 'DUTCH SEAFOOD TRADING'],
            extras: [
                { group: 'Coldstore', key: 'inouttake', ledger: LEDGER.warehouseInOut, desc: 'In and outtake, crossdocking if palletized', price: 13.10, unit: 'pallet' },
                { group: 'Coldstore', key: 'inouttakeloose', ledger: LEDGER.warehouseInOut, desc: 'In and outtake, not palletized / loose (grossweight)', price: 32.50, unit: 'ton' },
                { group: 'Coldstore', key: 'sorting2', ledger: LEDGER.warehouseInOut, desc: 'Sorting sizes if 2 sizes (grossweight)', price: 8.95, unit: 'ton' },
                { group: 'Coldstore', key: 'foil', ledger: LEDGER.warehouseInOut, desc: 'Foil wrapping pallets', price: 5.25, unit: 'pallet' },
                { group: 'Coldstore', key: 'storage', ledger: LEDGER.warehouseStorage, desc: 'Storage costs per calendar week', price: 4.75, unit: 'pallet/week' },
                { group: 'Coldstore', key: 'shunting', ledger: LEDGER.containerHandling, desc: 'Container shunting - checkpoint & coldstore on and off dock', price: 58.00, unit: 'ctr' },
                { group: 'Coldstore', key: 'weighing', ledger: LEDGER.misc, desc: 'Container / truck weighing', price: 52.50, unit: 'unit' }
            ],
            base: [
                { ledger: LEDGER.vet,       desc: 'Inspection appointment',                                      qty: 1.000, price: 31.50, perCtr: true },
                { ledger: LEDGER.vet,       desc: 'Inspection point surcharge for handling customs document(s)', qty: 1.000, price: 18.00 },
                { ledger: LEDGER.importDoc, desc: 'Import customs clearance under direct representation',        qty: 1.000, price: 104.00 },
                { ledger: LEDGER.handling,  desc: 'Handling fee',                                                qty: 1.000, price: 52.00, perCtr: true }
            ]
        }
    };

    /* -------------------------------------------------------------------------
       DESTINATIONS - one source for both the checkbox list and the billed price.
       fuelIncluded: the rate already contains fuel, so it stays out of the
       diesel calculation base.
       ------------------------------------------------------------------------- */
    const DESTINATIONS = {
        eurofoodlink: [
            { id: 'EF_1',  price: 412.00,  label: 'Lokaal RTM',                       desc: 'Terminal Rotterdam – Lokaal RTM.' },
            { id: 'EF_2',  price: 385.00,  label: 'Via keurpunt naar Matrans',        desc: 'Terminal Rotterdam – Via keurpunt naar Matrans.' },
            { id: 'EF_3',  price: 385.00,  label: 'Via keurpunt naar Rhenus',         desc: 'Terminal Rotterdam – Via keurpunt naar Rhenus.' },
            { id: 'EF_4',  price: 535.00,  label: 'Amsterdam (3 uur vrij)',           desc: 'Terminal Rotterdam – Amsterdam (3 uur vrij van lossing).' },
            { id: 'EF_5',  price: 562.00,  label: 'Breskens (2 uur vrij)',            desc: 'Terminal Rotterdam – Breskens (2 uur vrij van lossing).' },
            { id: 'EF_6',  price: 385.00,  label: 'Den Haag / Scheveningen (2 uur vrij)', desc: 'Terminal Rotterdam – Den Haag / Scheveningen (2 uur vrij van lossing).' },
            { id: 'EF_7',  price: 455.00,  label: 'Ijmuiden (2 uur vrij)',            desc: 'Terminal Rotterdam – Ijmuiden (2 uur vrij van lossing).' },
            { id: 'EF_8',  price: 562.00,  label: 'Leveroy (2 uur vrij)',             desc: 'Terminal Rotterdam – Leveroy (2 uur vrij van lossing).' },
            { id: 'EF_9',  price: 583.00,  label: 'Horn (2 uur vrij)',                desc: 'Terminal Rotterdam – Horn (2 uur vrij van lossing).' },
            { id: 'EF_10', price: 428.00,  label: 'Nieuw Vennep (2 uur vrij)',        desc: 'Terminal Rotterdam – Nieuw Vennep (2 uur vrij van lossing).' },
            { id: 'EF_11', price: 482.00,  label: 'Nijkerk/Huissen (2 uur vrij)',     desc: 'Terminal Rotterdam – Nijkerk/Huissen (2 uur vrij van lossing).' },
            { id: 'EF_12', price: 385.00,  label: 'Rijnsburg (2 uur vrij)',           desc: 'Terminal Rotterdam – Rijnsburg (2 uur vrij van lossing).' },
            { id: 'EF_13', price: 523.00,  label: 'Lommel (2 uur vrij)',              desc: 'Terminal Rotterdam – Lommel (2 uur vrij van lossing).' },
            { id: 'EF_14', price: 562.00,  label: 'Urk (2 uur vrij)',                 desc: 'Terminal Rotterdam – Urk (2 uur vrij van lossing).' },
            { id: 'EF_15', price: 471.00,  label: 'Yerseke (2 uur vrij)',             desc: 'Terminal Rotterdam – Yerseke (2 uur vrij van lossing).' },
            { id: 'EF_16', price: 1030.00, label: 'Bielefeld (2 uur vrij)',           desc: 'Terminal Rotterdam – Bielefeld (2 uur vrij van lossing).', foreign: true },
            { id: 'EF_17', price: 1750.00, label: 'Deizisau (73779) (2 uur vrij)',    desc: 'Terminal Rotterdam – Deizisau (73779) (2 uur vrij van lossing).', foreign: true },
            { id: 'EF_18', price: 1525.00, label: 'Hamburg (2 uur vrij)',             desc: 'Terminal Rotterdam – Hamburg (2 uur vrij van lossing).', foreign: true, note: 'na-offerte' }
        ],
        kuhneheitz: [
            { id: 'KH_1',  price: 352.00,  label: 'Lokaal RTM afkoppelen All-in',  desc: 'Trucking Rotterdam terminal naar lokaal RTM afkoppelen', checked: true },
            { id: 'KH_2',  price: 375.00,  label: 'Via keurpunt naar Matrans',     desc: 'Trucking Rotterdam terminal via keurpunt naar Matrans' },
            { id: 'KH_3',  price: 375.00,  label: 'Via keurpunt naar Rhenus',      desc: 'Trucking Rotterdam terminal via keurpunt naar Rhenus' },
            { id: 'KH_4',  price: 579.00,  label: 'Alphen a/d Rijn',               desc: 'Trucking Rotterdam terminal naar Alphen a/d Rijn' },
            { id: 'KH_5',  price: 723.00,  label: 'Arnhem / Heerhugowaard',        desc: 'Trucking Rotterdam terminal naar Arnhem / Heerhugowaard' },
            { id: 'KH_6',  price: 642.00,  label: 'Barneveld/Nijkerk/Woudenberg/Hansweert', desc: 'Trucking Rotterdam terminal naar Barneveld/Nijkerk/Woudenberg/Hansweert' },
            { id: 'KH_7',  price: 589.00,  label: 'Breda / Hazeldonk',             desc: 'Trucking Rotterdam terminal naar Breda / Hazeldonk' },
            { id: 'KH_8',  price: 648.00,  label: 'Brecht',                        desc: 'Trucking Rotterdam terminal naar Brecht', foreign: true },
            { id: 'KH_9',  price: 893.00,  label: 'Brugge',                        desc: 'Trucking Rotterdam terminal naar Brugge', foreign: true },
            { id: 'KH_10', price: 787.00,  label: 'Brussel/Drogenbos',             desc: 'Trucking Rotterdam terminal naar Brussel/Drogenbos', foreign: true },
            { id: 'KH_11', price: 1197.00, label: 'Dissen',                        desc: 'Trucking Rotterdam terminal naar Dissen', foreign: true },
            { id: 'KH_12', price: 851.00,  label: 'Harlingen',                     desc: 'Trucking Rotterdam terminal naar Harlingen' },
            { id: 'KH_13', price: 653.00,  label: 'Huissen/Oss',                   desc: 'Trucking Rotterdam terminal naar Huissen/Oss' },
            { id: 'KH_14', price: 664.00,  label: 'Kesteren',                      desc: 'Trucking Rotterdam terminal naar Kesteren' },
            { id: 'KH_15', price: 1106.00, label: 'Koln',                          desc: 'Trucking Rotterdam terminal naar Koln', foreign: true },
            { id: 'KH_16', price: 839.00,  label: 'Leveroy/Urk',                   desc: 'Trucking Rotterdam terminal naar Leveroy/Urk' },
            { id: 'KH_17', price: 824.00,  label: 'Lichtenvoorde',                 desc: 'Trucking Rotterdam terminal naar Lichtenvoorde' },
            { id: 'KH_18', price: 552.00,  label: 'Moerdijk',                      desc: 'Trucking Rotterdam terminal naar Moerdijk' },
            { id: 'KH_19', price: 925.00,  label: 'Niederkruchten',                desc: 'Trucking Rotterdam terminal naar Niederkruchten', foreign: true },
            { id: 'KH_20', price: 733.00,  label: 'Puurs',                         desc: 'Trucking Rotterdam terminal naar Puurs', foreign: true },
            { id: 'KH_21', price: 611.00,  label: 'Rosmalen',                      desc: 'Trucking Rotterdam terminal naar Rosmalen' },
            { id: 'KH_22', price: 552.00,  label: 'Zoetermeer',                    desc: 'Trucking Rotterdam terminal naar Zoetermeer' }
        ],
        anduronda: [
            { id: 'A_1', price: 358.00, label: 'Coldstore Rotterdam All-in',  desc: 'Terminal Rotterdam - Coldstore Rotterdam All-in.' },
            { id: 'A_2', price: 225.00, label: 'RCT (storage & plug-in)',     desc: 'Terminal Rotterdam - RCT (storage & plug-in).' },
            { id: 'A_3', price: 350.00, label: 'Matrans Terminal',            desc: 'Terminal Rotterdam - Matrans Terminal.' },
            { id: 'A_4', price: 764.00, label: 'Koln (D-50996)',              desc: 'Terminal Rotterdam - Koln (D-50996) 2 Hrs free of unloading.', foreign: true },
            { id: 'A_5', price: 820.00, label: 'Troisdorf (D-53842)',         desc: 'Terminal Rotterdam – Troisdorf (D-53842) 2 Hrs free of unloading.', foreign: true },
            { id: 'A_6', price: 702.00, label: 'Herne (D-44653)',             desc: 'Terminal Rotterdam – Herne (D-44653) 2 Hrs free of unloading.', foreign: true, checked: true }
        ],
        dutchseafood: [
            { id: 'DS_1', price: 430.00,  label: 'Coldstore Rotterdam All-in',        desc: 'Terminal Rotterdam – Coldstore Rotterdam All-in.', checked: true },
            { id: 'DS_2', price: 611.00,  label: 'Amsterdam / Harderwijk (3 hrs free)', desc: 'Terminal Rotterdam – Amsterdam / Harderwijk (3 hours freetime for unloading).' },
            { id: 'DS_3', price: 2300.00, label: 'Neustadt a.d. Aisch (91413) (2 hrs free)', desc: 'Terminal Rotterdam – Neustadt a.d. Aisch (91413) (2 hours freetime for unloading).', foreign: true }
        ],
        vbfood: [
            { id: 'VB_1', price: 352.00,  label: 'Coldstore Eurofrigo / Frigocare All-in', desc: 'Terminal Rotterdam - Coldstore Eurofrigo / frigocare All-in.', checked: true },
            { id: 'VB_2', price: 254.00,  label: 'Coldstore Coolport',   desc: 'Terminal Rotterdam – Coldstore Coolport' },
            { id: 'VB_3', price: 254.00,  label: 'RSC, CTT or Matrans',  desc: 'Terminal Rotterdam – RSC, CTT or Matrans' },
            { id: 'VB_4', price: 190.00,  label: 'Rhenus – CTT',         desc: 'Rhenus – CTT including fuelsurcharge', fuelIncluded: true, note: 'incl. fuel' },
            { id: 'VB_5', price: 518.00,  label: 'Breskens',             desc: 'Terminal Rotterdam – Breskens' },
            { id: 'VB_6', price: 2096.00, label: 'Moehlin (CH-4313)',    desc: 'Terminal Rotterdam – Moehlin (CH-4313)', foreign: true },
            // Excluding surcharges: the Maasvlakte surcharge is added on top and
            // the diesel surcharge is calculated over the base plus Maasvlakte.
            { id: 'VB_7', price: 254.00,  label: 'Rhenus → FLX hub',      desc: 'Rhenus – FLX hub (excl. toeslagen)', note: '+ Maasvlakte', requires: ['maasvlakte'] }
        ]
    };

    /* =========================================================================
       NET NET AS PER OUTLAY
       -------------------------------------------------------------------------
       Terms & conditions, all four offers:
         "Shipping line (agent); seafreight costs, THC, ISPS, ISPC, Demurrage,
          Detention, Storage, Plug-in charges. Customs charges, inspection costs,
          NVWA Laboratory check, extra surcharges, Import Duties are always
          charged net net as per outlay."
       These have NO tariff in any offer, so the script must never invent one.
       Each row below is an empty amount field: you type the figure from the
       supplier invoice and only filled rows become invoice lines.

       LEDGER MAPPING: each row books to its own ledger (THC 4959, ISPS 4949,
       Demurrage 4934, Detention 4935, Storage 4933, Duty 4924, VAT 4925, etc.).
       Nothing falls back to Miscellaneous. See the full ledger reference above
       if you want to move a row.

       VAT: import duties and disbursements often carry a different VAT code
       than the default 162. Set `vatSeq` on a row to override it per line.
       ========================================================================= */
    const OUTLAY_ITEMS = [
        { key: 'thc',               ledger: LEDGER.thc,          nl: 'THC, terminal handling charges',       en: 'THC, terminal handling charges' },
        { key: 'isps',              ledger: LEDGER.isps,         nl: 'ISPS / ISPC toeslag',                   en: 'ISPS / ISPC surcharge' },
        { key: 'demurrage',         ledger: LEDGER.demurrage,    nl: 'Demurrage',                             en: 'Demurrage' },
        { key: 'detention',         ledger: LEDGER.detention,    nl: 'Detention',                             en: 'Detention' },
        { key: 'storage',           ledger: LEDGER.storage,      nl: 'Opslagkosten',                          en: 'Storage charges' },
        { key: 'pluginCarrier',     ledger: LEDGER.specialEquip, nl: 'Plug-in kosten rederij / terminal',     en: 'Plug-in charges carrier / terminal' },
        { key: 'customsInspection', ledger: LEDGER.customsInsp,  nl: 'Douane-inspectie (scan en/of fysiek)',  en: 'Customs inspection (X-ray and/or physical)' },
        { key: 'customsCharges',    ledger: LEDGER.extraCosts,   nl: 'Douanekosten',                          en: 'Customs charges' },
        { key: 'nvwaLab',           ledger: LEDGER.nvwa,         nl: 'NVWA laboratoriumonderzoek',            en: 'NVWA laboratory check' },
        { key: 'extraSurcharges',   ledger: LEDGER.extraCosts,   nl: 'Extra toeslagen rederij',               en: 'Extra carrier surcharges' },
        // Confirmed: duties and import VAT are invoiced with VAT code 162 (0%),
        // the same as every other line, so no per-row vatSeq override is needed.
        { key: 'importDuties',      ledger: LEDGER.duty,         nl: 'Invoerrechten',                         en: 'Import duties',  vatWarning: true },
        { key: 'importVat',         ledger: LEDGER.vat,          nl: 'BTW bij invoer',                        en: 'Import VAT',     vatWarning: true }
    ];

    /* =========================================================================
       HELPERS
       ========================================================================= */

    const round2 = n => parseFloat(Number(n).toFixed(2));
    const money = n => CURRENCY_SYMBOL + Number(n).toLocaleString('nl-NL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    function log(msg, data = '') {
        if (!DEBUG) return;
        const t = new Date().toISOString().split('T')[1].slice(0, 8);
        console.log(`[InvoiceBot ${t}] ${msg} ${data ? JSON.stringify(data) : ''}`);
    }

    async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

    // Poll for a condition instead of sleeping blind.
    async function waitFor(fn, timeout, interval) {
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
            try { if (fn()) return true; } catch (e) {}
            await sleep(interval || 60);
        }
        return false;
    }

    /* Button ids on the revenue page, with a label fallback if FitOn renumbers. */
    function findButtonByText(include, exclude) {
        const nodes = document.querySelectorAll('button, a.t-Button, input[type="button"], input[type="submit"]');
        for (const el of nodes) {
            if (el.disabled || el.getAttribute('aria-disabled') === 'true') continue;
            const label = (el.innerText || el.textContent || el.value || '').trim();
            if (!label || !include.test(label)) continue;
            if (exclude && exclude.test(label)) continue;
            return el;
        }
        return null;
    }

    /* A saved record is shown in EDIT mode: same fields, but the button reads
       "Apply Changes", not "Create". Only a real Create button counts, or the
       next line gets typed over the record that was just saved. */
    function isEditForm() {
        return !!findButtonByText(/^(apply changes|save changes|wijzigingen toepassen|opslaan|delete|verwijderen)$/i);
    }
    function getCreateButton() {
        return el('createBtn')
            || findButtonByText(/^create$/i, /next|another|volgende|apply|change|delete|opslaan/i);
    }
    function getCreateNextButton() {
        return el('createNextBtn')
            || findButtonByText(/create\s*next|create and create another|opslaan en volgende/i);
    }

    /* The only honest proof that a line was booked is the revenue list growing.
       Returns null when the count cannot be read. */
    function getSavedRowCount() {
        const text = (document.body && document.body.innerText) || '';
        const m = text.match(/row\(s\)\s*\d+\s*[-–]\s*\d+\s*of\s*(\d+)/i);
        if (m) return parseInt(m[1], 10);
        if (/\b1\s*row\(s\)\b/i.test(text)) return 1;
        return null;
    }

    /* Identifies the shipment this page belongs to, for resume and duplicate checks. */
    function shipmentKey() {
        const m = location.href.match(/[?&:](\d{4,})(?::|&|$)/);
        return (location.pathname + (m ? m[1] : '')).slice(-80);
    }

    const TIMING = {
        fieldWait: 100, afterLedger: 200, vatStep: 100, settle: 200, ajaxIdle: 4000,
        beforeCreateNext: 300, afterCreateNext: 500, retry: 300, afterCreate: 2200,
        btnWait: 6000, formWait: 8000, saveWait: 12000
    };

    /* Which FitOn page are we on? Prefer the map whose ledger field is present,
       otherwise fall back to the breadcrumb. Returns null when neither matches. */
    function detectMode() {
        // The breadcrumb names the page: Shipment > Revenue, or Shipment > Cost.
        const labels = Array.from(document.querySelectorAll('.t-Breadcrumb-label, .t-Breadcrumb-item'))
            .map(x => (x.textContent || '').trim().toLowerCase());
        for (const mode of MODES) {
            const map = SETTINGS.maps[mapKey(mode)] || {};
            const crumb = map.breadcrumb || (DEFAULT_MAPS[mapKey(mode)] || DEFAULT_MAPS[mode]).breadcrumb;
            if (crumb && labels.some(l => l === crumb.toLowerCase())) {
                if (deriveMap() || document.getElementById(map.ledger || '')) return mode;
            }
        }
        // No breadcrumb match: fall back to an explicitly configured field id.
        // A road map still belongs to its mode: costRoad is "cost".
        for (const key of Object.keys(SETTINGS.maps)) {
            const id = (SETTINGS.maps[key] || {}).ledger;
            if (id && document.getElementById(id)) return key.replace(/Road$/, '');
        }
        // Last resort: a recognisable entry form, assume the current mode.
        return deriveMap() ? MODE : null;
    }

    /* Where are we? The panel is useful on more than the entry forms: the
       specification import starts from Search, and a running worklist passes
       through the shipment page. */
    function pageKind() {
        const found = detectMode();
        if (found) { MODE = found; return 'entry'; }
        if (onSearchPage()) return 'search';
        if (onShipmentPage()) return 'shipment';
        return null;
    }

    function isEntryPage() { return !!pageKind(); }

    function setNativeValue(element, value) {
        element.focus();
        element.value = value;
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
        element.blur();
    }

    function expiredRates() {
        const today = new Date().toISOString().slice(0, 10);
        return {
            transport: today > VALIDITY.transport,
            general: today > VALIDITY.general
        };
    }

    /* =========================================================================
       STYLES - light, neutral, print-shop plain. Scoped under .fip-
       ========================================================================= */
    const styleElem = document.createElement('style');
    styleElem.textContent = `
        .fip-root, .fip-root * { box-sizing: border-box; }
        .fip-root {
            --fip-bg: #ffffff;
            --fip-surface: #f8fafc;
            --fip-border: #e2e8f0;
            --fip-text: #0f172a;
            --fip-muted: #64748b;
            --fip-accent: #1d4ed8;
            --fip-accent-soft: #eff6ff;
            --fip-danger: #b91c1c;
            --fip-warn-bg: #fffbeb;
            --fip-warn-border: #fcd34d;
            --fip-warn-text: #92400e;
            --fip-ok: #15803d;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
            color: var(--fip-text);
            font-size: 13px;
            line-height: 1.45;
        }

        /* ---- floating panel ---- */
        #fiton-invoice-helper {
            position: fixed; bottom: 20px; right: 20px; z-index: 9999;
            display: flex; flex-direction: column;
            width: 292px; max-height: 92vh;
            background: var(--fip-bg);
            border: 1px solid var(--fip-border); border-radius: 10px;
            box-shadow: 0 4px 6px -1px rgba(15,23,42,.08), 0 12px 28px -6px rgba(15,23,42,.18);
            overflow: hidden;
            animation: fip-panel-in .28s cubic-bezier(.22,1,.36,1) both;
            transition: box-shadow .2s ease, border-color .2s ease;
        }
        #fiton-invoice-helper.is-busy {
            border-color: #bfdbfe;
            box-shadow: 0 4px 6px -1px rgba(29,78,216,.10), 0 14px 32px -6px rgba(29,78,216,.28);
        }
        @keyframes fip-panel-in {
            from { opacity: 0; transform: translateY(10px) scale(.985); }
            to   { opacity: 1; transform: none; }
        }
        .fip-panel-head {
            display: flex; align-items: center; gap: 8px;
            padding: 11px 13px; background: var(--fip-surface);
            border-bottom: 1px solid var(--fip-border);
            cursor: default; user-select: none;
        }
        .fip-panel-head .fip-dot {
            width: 7px; height: 7px; border-radius: 50%; background: var(--fip-muted); flex: none;
        }
        .fip-panel-head.is-running .fip-dot { background: var(--fip-accent); animation: fip-pulse 1.4s infinite; }
        .fip-panel-head.is-done .fip-dot { background: var(--fip-ok); }
        @keyframes fip-pulse { 0%,100% { opacity: 1 } 50% { opacity: .3 } }
        .fip-panel-title { font-weight: 600; font-size: 13px; flex: 1; letter-spacing: -.01em; }
        .fip-ver { font-size: 10px; color: var(--fip-muted); font-weight: 500; }
        .fip-collapse {
            border: none; background: none; cursor: pointer; color: var(--fip-muted);
            font-size: 15px; line-height: 1; padding: 2px 4px; border-radius: 4px;
        }
        .fip-collapse:hover { background: #e2e8f0; color: var(--fip-text); }
        .fip-panel-body { padding: 13px; flex: 1 1 auto; overflow-y: auto; min-height: 0; }
        #fiton-invoice-helper.is-collapsed .fip-panel-body { display: none; }
        #fiton-invoice-helper.is-collapsed { height: auto; }
        .fip-panel-head { flex: none; }

        /* The dialog resizes freely in both directions from its bottom-right
           corner. A custom grip is used rather than the CSS resize property: the
           dialog is centred, so the native handle only moves at half the speed
           of the pointer and sits underneath the footer buttons.
           The floating panel keeps a fixed size. */
        .fip-modal {
            position: relative;
            resize: none;
            min-width: 380px; min-height: 300px;
            max-width: 96vw; max-height: 92vh;
        }
        .fip-modal-grip {
            position: absolute; right: 0; bottom: 0; width: 22px; height: 22px;
            cursor: nwse-resize; z-index: 5; touch-action: none;
            background: transparent; border: none; padding: 0;
        }
        .fip-modal-grip::before, .fip-modal-grip::after {
            content: ''; position: absolute; right: 4px; background: #94a3b8;
            border-radius: 1px; transition: background .15s ease;
        }
        .fip-modal-grip::before { bottom: 4px; width: 12px; height: 2px; transform: rotate(-45deg); transform-origin: 100% 100%; }
        .fip-modal-grip::after  { bottom: 4px; width: 6px;  height: 2px; transform: rotate(-45deg); transform-origin: 100% 100%; margin-bottom: 4px; }
        .fip-modal-grip:hover::before, .fip-modal-grip:hover::after,
        .fip-modal.is-resizing .fip-modal-grip::before, .fip-modal.is-resizing .fip-modal-grip::after {
            background: var(--fip-accent);
        }
        .fip-modal.is-resizing { animation: none; user-select: none; }
        .fip-modal.is-resizing .fip-modal-body { pointer-events: none; }

        .fip-label {
            display: block; font-size: 11px; font-weight: 600; color: var(--fip-muted);
            text-transform: uppercase; letter-spacing: .04em; margin-bottom: 5px;
        }
        .fip-root select, .fip-root input[type="text"], .fip-root input[type="number"] {
            width: 100%; padding: 8px 10px; font-size: 13px; font-family: inherit;
            color: var(--fip-text); background: var(--fip-bg);
            border: 1px solid #cbd5e1; border-radius: 6px; outline: none;
            transition: border-color .15s, box-shadow .15s;
        }
        .fip-root select:focus, .fip-root input:focus {
            border-color: var(--fip-accent); box-shadow: 0 0 0 3px rgba(29,78,216,.12);
        }
        .fip-root input[type="checkbox"] { accent-color: var(--fip-accent); width: 15px; height: 15px; margin: 0; flex: none; }

        .fip-btn {
            display: inline-flex; align-items: center; justify-content: center; gap: 6px;
            border: 1px solid transparent; border-radius: 6px; cursor: pointer;
            font-family: inherit; font-size: 13px; font-weight: 600; padding: 9px 14px;
            transition: background .15s, border-color .15s, opacity .15s;
        }
        .fip-btn-primary { background: var(--fip-accent); color: #fff; }
        .fip-btn-primary:hover:not(:disabled) { background: #1e40af; }
        .fip-btn-primary:disabled { opacity: .55; cursor: default; }
        .fip-btn-ghost { background: var(--fip-bg); color: var(--fip-text); border-color: #cbd5e1; }
        .fip-btn-ghost:hover { background: var(--fip-surface); }
        .fip-btn-danger { background: var(--fip-bg); color: var(--fip-danger); border-color: #fecaca; }
        .fip-btn-danger:hover { background: #fef2f2; }
        .fip-btn-block { width: 100%; }
        .fip-btn-sm { padding: 5px 9px; font-size: 11.5px; font-weight: 500; }

        #fiton-invoice-helper.is-dragging { transition: none; }
        .fip-panel-head { cursor: grab; }
        .fip-panel-head:active { cursor: grabbing; }
        .fip-detected {
            margin-top: 7px; font-size: 11px; color: var(--fip-accent);
            background: var(--fip-accent-soft); border-radius: 5px; padding: 5px 8px;
        }
        .fip-detected.is-quiet { color: var(--fip-muted); background: var(--fip-surface); }
        .fip-detected.is-warn { color: var(--fip-warn-text); background: var(--fip-warn-bg); border: 1px solid var(--fip-warn-border); }
        .fip-detected { display: flex; align-items: center; gap: 6px; }

        .fip-message {
            margin-top: 10px; padding: 8px 10px; border-radius: 6px; font-size: 11.5px; line-height: 1.45;
        }
        .fip-message.is-ok { background: #f0fdf4; border: 1px solid #bbf7d0; color: #166534; }
        .fip-message.is-error { background: #fef2f2; border: 1px solid #fecaca; color: var(--fip-danger); }
        .fip-message.is-info { background: var(--fip-accent-soft); border: 1px solid #bfdbfe; color: var(--fip-accent); }
        .fip-substatus {
            font-size: 10.5px; color: var(--fip-muted); margin-top: 3px;
            white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        }
        .fip-modes { display: flex; gap: 4px; padding: 3px; background: var(--fip-surface); border: 1px solid var(--fip-border); border-radius: 7px; margin-bottom: 11px; }
        .fip-mode {
            flex: 1; border: none; background: transparent; cursor: pointer; padding: 6px 8px;
            border-radius: 5px; font: inherit; font-size: 12px; font-weight: 600; color: var(--fip-muted);
            transition: background .15s ease, color .15s ease;
        }
        .fip-mode:hover { color: var(--fip-text); }
        .fip-mode.is-active { background: var(--fip-bg); color: var(--fip-accent); box-shadow: 0 1px 2px rgba(15,23,42,.08); }
        /* only one side available: render it as a label, not a choice */
        .fip-modes.is-single { background: transparent; border: none; padding: 0; margin-bottom: 9px; }
        .fip-modes.is-single .fip-mode {
            background: transparent; box-shadow: none; cursor: default; padding: 0;
            text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: .05em;
        }
        #fiton-invoice-helper.is-cost .fip-mode.is-active { color: #a16207; }
        #fiton-invoice-helper.is-cost .fip-progress-bar.is-running { background: #ca8a04; }

        .fip-learn { position: fixed; top: 0; left: 0; right: 0; z-index: 10002; }
        .fip-learn-inner {
            display: flex; align-items: center; gap: 12px; padding: 11px 18px;
            background: var(--fip-accent); color: #fff; font-size: 13px;
            box-shadow: 0 4px 14px rgba(15,23,42,.25);
        }
        .fip-learn-step { font-weight: 700; background: rgba(255,255,255,.2); padding: 2px 8px; border-radius: 99px; font-size: 11px; }
        .fip-learn-text { flex: 1; }
        .fip-learn .fip-btn-ghost { background: rgba(255,255,255,.14); color: #fff; border-color: rgba(255,255,255,.3); }
        body.fip-learning * { cursor: crosshair !important; }
        body.fip-learning input, body.fip-learning select, body.fip-learning button { outline: 1px dashed rgba(29,78,216,.5); }

        .fip-status {
            margin-top: 11px; padding: 9px 10px; border-radius: 6px;
            background: var(--fip-surface); border: 1px solid var(--fip-border);
            font-size: 12px; color: var(--fip-muted);
        }
        .fip-progress-track { height: 4px; background: #e2e8f0; border-radius: 99px; margin-top: 7px; overflow: hidden; }
        .fip-progress-bar {
            height: 100%; width: 0%; border-radius: 99px;
            background: var(--fip-accent);
            transition: width .35s cubic-bezier(.4,0,.2,1), background-color .3s ease;
            position: relative; overflow: hidden;
        }
        .fip-progress-bar.is-running::after {
            content: ''; position: absolute; inset: 0;
            background: linear-gradient(90deg, transparent, rgba(255,255,255,.55), transparent);
            animation: fip-shimmer 1.15s linear infinite;
        }
        .fip-progress-bar.is-done { background: var(--fip-ok); }
        .fip-progress-bar.is-error { background: var(--fip-danger); }
        @keyframes fip-shimmer { from { transform: translateX(-100%); } to { transform: translateX(100%); } }

        /* status dot: pulsing halo while looping */
        .fip-panel-head .fip-dot { position: relative; transition: background-color .25s ease; }
        .fip-panel-head.is-running .fip-dot::after {
            content: ''; position: absolute; inset: -4px; border-radius: 50%;
            border: 1.5px solid var(--fip-accent); opacity: 0;
            animation: fip-halo 1.4s ease-out infinite;
        }
        @keyframes fip-halo {
            0%   { transform: scale(.6); opacity: .8; }
            100% { transform: scale(1.9); opacity: 0; }
        }

        /* line counter ticking over */
        .fip-status-line { display: flex; align-items: baseline; gap: 6px; }
        #fip-status-text { transition: color .2s ease; }
        .fip-tick { display: inline-block; animation: fip-tick-in .3s cubic-bezier(.22,1,.36,1); }
        @keyframes fip-tick-in { from { opacity: 0; transform: translateY(-5px); } to { opacity: 1; transform: none; } }

        /* button working state */
        .fip-spinner {
            width: 13px; height: 13px; border-radius: 50%; flex: none;
            border: 2px solid rgba(255,255,255,.35); border-top-color: #fff;
            animation: fip-spin .7s linear infinite; display: none;
        }
        .fip-btn.is-working .fip-spinner { display: inline-block; }
        @keyframes fip-spin { to { transform: rotate(360deg); } }
        .fip-btn:active:not(:disabled) { transform: translateY(1px); }
        .fip-btn { transition: background .15s, border-color .15s, opacity .15s, transform .08s ease; }

        /* completion flash */
        @keyframes fip-flash {
            0%   { background: #dcfce7; }
            100% { background: var(--fip-surface); }
        }
        .fip-status.is-done { animation: fip-flash 1.1s ease-out; }

        /* waiting-for-form skeleton */
        .fip-waiting { opacity: .55; pointer-events: none; }
        .fip-skeleton {
            height: 34px; border-radius: 6px; margin-top: 11px;
            background: linear-gradient(90deg, #f1f5f9 25%, #e2e8f0 37%, #f1f5f9 63%);
            background-size: 400% 100%; animation: fip-skel 1.3s ease-in-out infinite;
        }
        @keyframes fip-skel { from { background-position: 100% 50%; } to { background-position: 0 50%; } }

        /* modal entrance */
        .fip-ask {
            position: fixed; inset: 0; z-index: 10005; display: flex;
            align-items: center; justify-content: center; padding: 24px;
            background: rgba(15,23,42,.5); backdrop-filter: blur(3px);
            animation: fip-fade .15s ease both;
        }
        .fip-ask-box {
            background: var(--fip-bg); border-radius: 11px; padding: 20px 22px;
            width: 100%; max-width: 430px; box-shadow: 0 20px 50px -12px rgba(15,23,42,.45);
            animation: fip-modal-in .2s cubic-bezier(.22,1,.36,1) both;
        }
        .fip-ask-title { font-size: 14.5px; font-weight: 650; margin-bottom: 7px; letter-spacing: -.01em; }
        .fip-ask-msg { font-size: 13px; color: var(--fip-text); line-height: 1.55; }
        .fip-report-summary {
            display: flex; gap: 16px; flex-wrap: wrap; font-size: 12px; color: var(--fip-muted);
            padding: 10px 0 12px; border-bottom: 1px solid var(--fip-border); margin-bottom: 10px;
        }
        .fip-report-summary b { color: var(--fip-text); font-size: 14px; }
        /* Sideways too: the shipment column makes this table wider than the box. */
        .fip-report-scroll { max-height: 45vh; overflow: auto; }
        .fip-badge { font-size: 10.5px; font-weight: 600; padding: 2px 8px; border-radius: 99px; white-space: nowrap; }
        .fip-badge.is-ok { background: #f0fdf4; color: #166534; }
        .fip-badge.is-warn { background: var(--fip-warn-bg); color: var(--fip-warn-text); }
        .fip-badge.is-bad { background: #fef2f2; color: var(--fip-danger); }
        .fip-reason { color: var(--fip-muted); font-size: 11.5px; }
        .fip-ask-actions { display: flex; justify-content: flex-end; gap: 9px; margin-top: 18px; }
        .fip-btn-danger-solid { background: var(--fip-danger); color: #fff; }
        .fip-btn-danger-solid:hover { background: #991b1b; }

        .fip-overlay { animation: fip-fade .18s ease both; }
        .fip-overlay .fip-modal { animation: fip-modal-in .26s cubic-bezier(.22,1,.36,1) both; }
        @keyframes fip-fade { from { opacity: 0; } to { opacity: 1; } }
        @keyframes fip-modal-in {
            from { opacity: 0; transform: translateY(14px) scale(.98); }
            to   { opacity: 1; transform: none; }
        }
        .fip-foot-total strong { transition: color .2s ease; }
        .fip-check { transition: background .12s ease; }
        .fip-route { animation: fip-row-in .22s ease both; }
        @keyframes fip-row-in { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: none; } }

        @media (prefers-reduced-motion: reduce) {
            .fip-root, .fip-root *, #fiton-invoice-helper, .fip-overlay, .fip-overlay * {
                animation: none !important; transition: none !important;
            }
        }

        /* ---- modal ---- */
        .fip-overlay {
            position: fixed; inset: 0; z-index: 10000; display: flex;
            align-items: center; justify-content: center; padding: 24px;
            background: rgba(15,23,42,.45); backdrop-filter: blur(3px);
        }
        .fip-modal {
            display: flex; flex-direction: column;
            width: 100%; max-width: 720px; max-height: 90vh;
            background: var(--fip-bg); border-radius: 12px;
            box-shadow: 0 24px 60px -12px rgba(15,23,42,.4);
            overflow: hidden;
        }
        .fip-modal-head {
            padding: 16px 22px; border-bottom: 1px solid var(--fip-border); background: var(--fip-bg);
            display: flex; align-items: flex-start; gap: 12px;
        }
        .fip-modal-head h3 { margin: 0; font-size: 16px; font-weight: 650; letter-spacing: -.01em; }
        .fip-modal-head p { margin: 2px 0 0; font-size: 11.5px; color: var(--fip-muted); }
        .fip-modal-close {
            margin-left: auto; border: none; background: none; cursor: pointer;
            color: var(--fip-muted); font-size: 20px; line-height: 1; padding: 2px 6px; border-radius: 5px;
        }
        .fip-modal-close:hover { background: var(--fip-surface); color: var(--fip-text); }
        .fip-modal-body { padding: 18px 22px; overflow-y: auto; background: var(--fip-surface); }
        .fip-modal-foot {
            position: relative;
            padding: 13px 22px; border-top: 1px solid var(--fip-border); background: var(--fip-bg);
            display: flex; align-items: center; gap: 12px;
        }
        .fip-preset-bar { display: flex; align-items: center; gap: 6px; }
        .fip-preset-bar select { width: 150px; margin-top: 0; padding: 6px 8px; font-size: 12px; }
        .fip-foot-total { flex: 1; font-size: 12px; color: var(--fip-muted); }
        .fip-foot-total strong { display: block; font-size: 18px; color: var(--fip-text); font-weight: 650; letter-spacing: -.02em; }

        .fip-card {
            background: var(--fip-bg); border: 1px solid var(--fip-border);
            border-radius: 9px; padding: 14px 15px; margin-bottom: 13px;
        }
        .fip-card-title {
            display: flex; align-items: center; gap: 8px;
            font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em;
            color: var(--fip-muted); margin-bottom: 11px;
        }
        .fip-card-title .fip-count {
            margin-left: auto; text-transform: none; letter-spacing: 0; font-weight: 600;
            font-size: 11px; color: var(--fip-accent); background: var(--fip-accent-soft);
            padding: 2px 7px; border-radius: 99px;
        }
        .fip-tarifflink {
            display: inline-block; margin-top: 6px; font-size: 12px; color: var(--fip-accent);
            text-decoration: none; border-bottom: 1px solid rgba(29,78,216,.3);
        }
        .fip-tarifflink:hover { border-bottom-color: var(--fip-accent); }
        .fip-tarifflink.is-off { color: var(--fip-muted); border-bottom: none; cursor: default; }
        .fip-drop {
            border: 2px dashed #cbd5e1; border-radius: 9px; padding: 22px 16px; text-align: center;
            background: var(--fip-surface); transition: border-color .15s ease, background .15s ease;
        }
        .fip-drop.is-over { border-color: var(--fip-accent); background: var(--fip-accent-soft); }
        .fip-drop-icon { font-size: 22px; margin-bottom: 6px; }
        .fip-drop-link { color: var(--fip-accent); cursor: pointer; text-decoration: underline; }
        .fip-update {
            display: block; font-size: 11.5px; line-height: 1.4; margin-bottom: 9px;
            padding: 8px 10px; border-radius: 7px;
            background: var(--fip-warn-bg); color: var(--fip-warn-text);
            border: 1px solid var(--fip-warn-border);
        }
        .fip-update b { display: block; font-weight: 700; }
        .fip-ver.is-old { color: var(--fip-warn-text); font-weight: 700; }

        .fip-doc {
            border: 1px solid var(--fip-border); border-radius: 8px; padding: 9px 10px;
            margin-top: 8px; background: var(--fip-surface);
        }
        .fip-doc.is-bad { border-color: #fecaca; background: #fef2f2; }
        .fip-doc-head { display: flex; align-items: center; gap: 8px; }
        .fip-doc-name {
            font-size: 12.5px; font-weight: 600; flex: none; max-width: 42%;
            overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }
        .fip-doc-meta { flex: 1; font-size: 11px; color: var(--fip-muted); text-align: right; }
        .fip-doc-del {
            flex: none; border: none; background: none; cursor: pointer; line-height: 1;
            font-size: 17px; color: var(--fip-muted); padding: 0 2px;
        }
        .fip-doc-del:hover { color: var(--fip-danger); }
        .fip-doc-fields {
            display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
            gap: 8px; margin-top: 8px;
        }
        .fip-docgroup td { background: var(--fip-bg); font-size: 11.5px; padding-top: 7px; }
        .fip-docgroup td:last-child { font-variant-numeric: tabular-nums; }

        .fip-details { margin-top: 10px; }
        .fip-details summary { font-size: 12px; color: var(--fip-muted); cursor: pointer; }
        .fip-details[open] summary { margin-bottom: 7px; }
        .fip-textarea {
            width: 100%; min-height: 90px; resize: vertical; font-family: inherit; font-size: 12px;
            padding: 9px 10px; border: 1px solid #cbd5e1; border-radius: 6px; background: var(--fip-bg);
            color: var(--fip-text); line-height: 1.45;
        }
        .fip-textarea:focus { outline: none; border-color: var(--fip-accent); box-shadow: 0 0 0 3px rgba(29,78,216,.12); }
        .fip-lines { padding: 4px 6px; }
        .fip-linerow { display: flex; align-items: baseline; gap: 8px; font-size: 11.5px; padding: 1px 0; }
        .fip-linedesc { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .fip-lineledger {
            font-size: 10px; font-weight: 600; color: var(--fip-accent);
            background: var(--fip-accent-soft); border-radius: 4px; padding: 1px 5px; flex: none;
        }
        .fip-lineledger.is-guess { color: var(--fip-warn-text); background: var(--fip-warn-bg); }
        .fip-lineamt { flex: none; font-variant-numeric: tabular-nums; color: var(--fip-muted); min-width: 62px; text-align: right; }
        .fip-spec-row { cursor: pointer; }
        .fip-spec-row:hover td { background: var(--fip-surface); }
        .fip-spec-row.is-chosen td { background: var(--fip-accent-soft); }
        .fip-subgroup { margin-bottom: 12px; }
        .fip-subgroup:last-child { margin-bottom: 0; }
        .fip-subgroup-title {
            font-size: 11.5px; font-weight: 600; color: var(--fip-text); margin-bottom: 7px;
            padding-bottom: 5px; border-bottom: 1px solid var(--fip-border);
        }
        .fip-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; }
        .fip-field label { display: block; font-size: 11.5px; color: var(--fip-muted); margin-bottom: 4px; font-weight: 500; }
        .fip-hint { font-size: 10.5px; color: var(--fip-muted); margin-top: 4px; }

        .fip-check {
            display: flex; align-items: center; gap: 9px; padding: 6px 8px;
            border-radius: 6px; cursor: pointer; font-size: 12.5px;
        }
        .fip-check:hover { background: var(--fip-surface); }
        .fip-check .fip-price { margin-left: auto; color: var(--fip-muted); font-variant-numeric: tabular-nums; font-size: 12px; }
        .fip-check .fip-tag {
            font-size: 9.5px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em;
            background: var(--fip-accent-soft); color: var(--fip-accent); padding: 1px 6px; border-radius: 4px;
        }
        .fip-checklist { display: flex; flex-direction: column; gap: 1px; }
        .fip-scroll { max-height: 210px; overflow-y: auto; margin: 0 -6px; padding: 0 6px; }

        .fip-toolbar { display: flex; gap: 8px; margin-bottom: 9px; }
        .fip-toolbar input { flex: 1; padding: 6px 9px; font-size: 12px; }

        .fip-route {
            display: flex; align-items: center; gap: 10px; padding: 8px 10px;
            border: 1px solid var(--fip-border); border-radius: 7px; margin-top: 7px; background: var(--fip-surface);
        }
        .fip-route-name { flex: 1.6; font-size: 12px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .fip-route-fld { flex: 1; }
        .fip-route-fld label { display: block; font-size: 10px; color: var(--fip-muted); margin-bottom: 2px; }
        .fip-route-fld input { padding: 5px 7px; font-size: 12px; }

        .fip-banner {
            display: flex; gap: 9px; padding: 10px 12px; border-radius: 7px; margin-bottom: 13px;
            background: var(--fip-warn-bg); border: 1px solid var(--fip-warn-border);
            color: var(--fip-warn-text); font-size: 11.5px; line-height: 1.5;
        }
        .fip-banner b { font-weight: 700; }
        .fip-empty { font-size: 11.5px; color: var(--fip-muted); font-style: italic; padding: 4px 2px; }

        /* ---- preview table ---- */
        .fip-table { width: 100%; border-collapse: collapse; font-size: 12px; background: var(--fip-bg); }
        .fip-table th {
            position: sticky; top: 0; background: var(--fip-bg); z-index: 1;
            text-align: left; font-size: 10.5px; text-transform: uppercase; letter-spacing: .04em;
            color: var(--fip-muted); font-weight: 700; padding: 8px 6px; border-bottom: 1px solid var(--fip-border);
        }
        .fip-table td { padding: 7px 6px; border-bottom: 1px solid #f1f5f9; vertical-align: top; }
        .fip-table td.num, .fip-table th.num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
        .fip-table .fip-ledger { color: var(--fip-muted); font-size: 11px; }
        .fip-table tr.fip-total td {
            font-weight: 700; font-size: 13px; border-top: 2px solid var(--fip-text); border-bottom: none; padding-top: 10px;
        }
        .fip-table tr.fip-credit td { color: var(--fip-ok); }
        .fip-table .fip-rownum { color: #94a3b8; padding-top: 11px; }
        .fip-group-head td {
            background: var(--fip-surface); font-size: 10.5px; font-weight: 700;
            text-transform: uppercase; letter-spacing: .04em; color: var(--fip-muted);
            padding: 6px; border-bottom: 1px solid var(--fip-border);
        }
        .fip-group-head .fip-group-total { color: var(--fip-text); font-size: 12px; text-transform: none; letter-spacing: 0; }
        .fip-cell {
            width: 100%; border: 1px solid transparent; border-radius: 5px;
            padding: 4px 6px; font: inherit; font-size: 12px; color: inherit; background: transparent;
            transition: border-color .15s ease, background .15s ease;
        }
        .fip-cell:hover { border-color: var(--fip-border); background: var(--fip-bg); }
        .fip-cell:focus { border-color: var(--fip-accent); background: var(--fip-bg); outline: none; box-shadow: 0 0 0 3px rgba(29,78,216,.10); }
        .fip-cell-num { text-align: right; font-variant-numeric: tabular-nums; }
        .fip-line-total { padding-top: 11px; font-variant-numeric: tabular-nums; }
        .fip-row-del {
            border: none; background: none; cursor: pointer; color: #cbd5e1;
            font-size: 15px; line-height: 1; padding: 4px 5px; border-radius: 4px;
        }
        .fip-row-del:hover { background: #fef2f2; color: var(--fip-danger); }
        tr.fip-removed { opacity: .4; }
        tr.fip-removed .fip-cell { text-decoration: line-through; }
    `;
    document.head.appendChild(styleElem);

    /* =========================================================================
       PRICING
       ========================================================================= */

    function nvwaAmount(kg) {
        return Math.min(Math.max(round2(kg * NVWA.rate), NVWA.min), NVWA.max);
    }

    function parseDieselSurcharge(input, base, alreadyIncluded) {
        if (!input) return { amount: 0 };
        const clean = String(input).trim();
        const hasCurrency = /€|eur/i.test(clean);
        const absMatch = clean.match(/^(?:€|eur\s*)?\s*([\d.,]+)\s*(?:eur|€)?$/i);
        if (hasCurrency && absMatch) {
            return { amount: round2(parseFloat(absMatch[1].replace(',', '.')) || 0) };
        }
        let pct = null;
        if (clean.endsWith('%')) pct = parseFloat(clean) / 100;
        else if (!isNaN(parseFloat(clean))) { const v = parseFloat(clean); pct = v <= 1 ? v : v / 100; }
        if (pct === null || isNaN(pct)) return { amount: 0 };
        return { amount: round2(base * Math.max(0, pct - (alreadyIncluded || 0))) };
    }

    function buildItemsList(templateType, o) {
        const cfg = CLIENTS[templateType];
        const nl = cfg.lang === 'nl';
        const items = [];
        const ctr = Math.max(1, Math.round(o.containers || 1));   // per-container multiplier

        const G = {
            base:    nl ? 'Basis' : 'Base charges',
            docs:    nl ? 'Documenten' : 'Documents',
            check:   nl ? 'Keurpunt & NVWA' : 'Inspection & NVWA',
            transport: nl ? 'Transport' : 'Transport',
            surch:   nl ? 'Toeslagen' : 'Surcharges',
            extras:  nl ? 'Coldstore & terminal' : 'Coldstore & terminal',
            outlay:  nl ? 'Net net per outlay' : 'Net net as per outlay',
            other:   nl ? 'Overig' : 'Other'
        };

        // raw = keep full precision (used only for the per-kg NVWA rate)
        const push = (ledger, desc, qty, price, group, raw) => items.push({
            ledgerId: ledger.id, ledgerName: ledger.name, desc, qty,
            price: raw ? price : round2(price), group: group || G.other
        });

        // 1. Fixed base lines. Anything marked perCtr scales with the container count.
        cfg.base.forEach(l => push(l.ledger, l.desc, l.qty * (l.perCtr ? ctr : 1), l.price, G.base));

        // 2. GGB / CHED entries. CHED/CVED IS the GGB entry - never booked twice.
        //    Two entries means one line with quantity 2, not two identical lines.
        if (o.ggbEntries > 0) {
            push(LEDGER.ggb, cfg.ggb.desc, o.ggbEntries, cfg.ggb.price, G.check);
            push(LEDGER.vet, cfg.inspectionPoint.desc, o.ggbEntries, cfg.inspectionPoint.price, G.check);
        }

        // 3. Copies of the CHED / CVED
        if (o.copyChedQty > 0) push(LEDGER.docs, cfg.copyChed.desc, o.copyChedQty, cfg.copyChed.price, G.docs);

        // 4. After-hours inspection surcharge
        if (o.includeAfterHours) push(LEDGER.vet, cfg.afterHours.desc, 1.000, cfg.afterHours.price, G.check);

        // 5. Catch certificates / processing statements
        if (cfg.catchCerts) {
            if (o.catchCerts > 0) push(LEDGER.docs, cfg.catchCerts.catchDesc, o.catchCerts, 50.00, G.docs);
            if (o.procStatements > 0) push(LEDGER.docs, cfg.catchCerts.procDesc, o.procStatements, 25.00, G.docs);
        }

        // 6. Optional charges, driven by each client's own options list
        let optionalFuelBase = 0;
        (cfg.options || []).forEach(opt => {
            if (!o.options || !o.options[opt.key]) return;
            const qty = opt.perCtr ? ctr : 1.000;
            const group = opt.ledger === LEDGER.noShow ? G.check
                        : (opt.ledger === LEDGER.transit || opt.ledger === LEDGER.docs) ? G.docs
                        : G.surch;
            push(opt.ledger, opt.desc, qty, opt.price, group);
            if (opt.fuelBase) optionalFuelBase += opt.price * qty;   // terminal surcharge counts towards fuel
        });

        // 7. Peak surcharges (standard rates, identical for every client)
        if (o.includeEct) push(LEDGER.peak, nl ? 'ECT (Terminal) toeslag' : 'ECT (Terminal) Peak Surcharge', ctr, ECT_SURCHARGE, G.surch);
        if (o.includeRwg) push(LEDGER.peak, nl ? 'RWG (Terminal) toeslag' : 'RWG (Terminal) Peak Surcharge', ctr, RWG_SURCHARGE, G.surch);

        // 8. Optional minimum inspection fee
        if (o.includeMinKg) push(LEDGER.nvwa, nl ? 'Minimum KG Keurloon' : 'Minimum KG inspection fee', o.minKgQty, NVWA.min, G.check);

        // 9. Trucking per destination + toll/maut
        let fuelBase = (cfg.fixedFuelBase * ctr) + optionalFuelBase;
        const destTable = DESTINATIONS[templateType] || [];
        (o.destChoices || []).forEach(dest => {
            const d = destTable.find(x => x.id === dest.id);
            if (!d) { log('Unknown destination id, skipped', dest); return; }
            push(LEDGER.trucking, d.desc, ctr, d.price, G.transport);
            if (!d.fuelIncluded) fuelBase += d.price * ctr;
            if (dest.maut > 0) push(LEDGER.toll, `Maut (DE) Rotterdam -> ${d.label}`, 1.000, dest.maut, G.transport);
            if (dest.toll > 0) push(LEDGER.toll, `Toll (NL) Rotterdam -> ${d.label}`, 1.000, dest.toll, G.transport);
        });

        // 10. NVWA - always clamped between the minimum and maximum fee
        if (o.nettKg > 0) {
            const clampedKg = Math.min(Math.max(o.nettKg, NVWA.minKg), NVWA.maxKg);
            const withinBand = o.nettKg >= NVWA.minKg && o.nettKg <= NVWA.maxKg;
            if (cfg.nvwaPerKgLine && withinBand) {
                push(LEDGER.nvwa, cfg.nvwaDesc(o.nettKg), o.nettKg, NVWA.rate, G.check, true);
            } else if (cfg.nvwaPerKgLine) {
                const note = o.nettKg > NVWA.maxKg
                    ? ` (max. tarief ${money(NVWA.max)} bij ${NVWA.maxKg} kg)`
                    : ` (min. tarief ${money(NVWA.min)} bij ${NVWA.minKg} kg)`;
                push(LEDGER.nvwa, cfg.nvwaDesc(o.nettKg) + note, clampedKg, NVWA.rate, G.check, true);
            } else {
                let desc = cfg.nvwaDesc(o.nettKg);
                if (o.nettKg > NVWA.maxKg) desc += nl ? ` (max. ${money(NVWA.max)})` : ` (capped at ${money(NVWA.max)})`;
                else if (o.nettKg < NVWA.minKg) desc += nl ? ` (min. ${money(NVWA.min)})` : ` (minimum ${money(NVWA.min)})`;
                push(LEDGER.nvwa, desc, 1.000, nvwaAmount(o.nettKg), G.check);
            }
        }

        // 11. Coldstore and terminal activities - quantities typed per shipment
        (cfg.extras || []).forEach(ex => {
            const qty = (o.extras && o.extras[ex.key]) || 0;
            if (qty > 0) push(ex.ledger, ex.desc, qty, ex.price, G.extras);
        });

        // 12. Net net as per outlay - typed per shipment, never a fixed tariff
        OUTLAY_ITEMS.forEach(oi => {
            const amount = (o.outlays && o.outlays[oi.key]) || 0;
            if (amount <= 0) return;
            push(oi.ledger, nl ? oi.nl : oi.en, 1.000, amount, G.outlay);
            const line = items[items.length - 1];
            line.isOutlay = true;
            if (oi.vatSeq) line.vatSeq = oi.vatSeq;
        });
        if (o.outlayOtherAmount > 0) {
            push(LEDGER.misc, o.outlayOtherDesc || (nl ? 'Doorbelasting per outlay' : 'Disbursement as per outlay'),
                 1.000, o.outlayOtherAmount, G.outlay);
            items[items.length - 1].isOutlay = true;
        }

        // 13. Gen-Set (per container, separate from any plug-in charge)
        if (o.includeGenset) push(cfg.genset.ledger || LEDGER.misc, cfg.genset.desc, ctr, cfg.genset.price, G.surch);

        // 14. Plug-in charges per calendar day
        if (cfg.plugin && o.pluginDays > 0) push(LEDGER.misc, cfg.plugin.desc, o.pluginDays, cfg.plugin.price, G.other);

        // 15. Chassis rental
        if (cfg.chassis && o.chassisDays > 0) push(LEDGER.misc, cfg.chassis.desc, o.chassisDays, cfg.chassis.price, G.other);

        // 16. Tantieme (credit)
        if (o.tantiemeClient) push(LEDGER.misc, `Tantieme directe levering aan: ${o.tantiemeClient}`, 1.000, -50.00, G.other);

        // 17. Fuel surcharge over the trucking base (excl. rates that already include fuel)
        const diesel = parseDieselSurcharge(o.dieselInput, fuelBase, cfg.dieselIncluded);
        if (diesel.amount > 0) {
            const desc = cfg.dieselIncluded > 0
                ? `DIESELTOESLAG ${o.dieselInput} (incl. ${Math.round(cfg.dieselIncluded * 100)}% in transportprijs, resterend extra)`
                : (nl ? `${o.dieselInput} brandstoftoeslag` : `${o.dieselInput} fuel surcharge`);
            push(LEDGER.fuel, desc, 1.000, diesel.amount, G.transport);
        }

        // 18. Waiting hours
        if (o.waitingHours > 0) push(LEDGER.waiting, cfg.waiting.desc, o.waitingHours, cfg.waiting.price, G.other);

        return items;
    }

    /* =========================================================================
       VALIDATION - non-blocking sanity checks shown before booking
       ========================================================================= */
    function validate(templateType, o, items) {
        const warnings = [];
        const cfg = CLIENTS[templateType];
        const destTable = DESTINATIONS[templateType] || [];
        const exp = expiredRates();

        if (exp.transport) warnings.push(`Transporttarieven waren geldig t/m ${VALIDITY.transport} (kilometertoeslag) — controleer of de trucking rates nog kloppen.`);
        if (exp.general) warnings.push(`De offertetarieven waren geldig t/m ${VALIDITY.general}.`);

        (o.destChoices || []).forEach(dest => {
            const d = destTable.find(x => x.id === dest.id);
            if (!d) return;
            if (dest.maut > 0 && !d.foreign) warnings.push(`Maut (DE) ingevuld voor ${d.label}, maar dat is geen Duitse bestemming.`);
            if (dest.maut === 0 && dest.toll === 0 && d.foreign) warnings.push(`Geen Maut/Tol ingevuld voor buitenlandse bestemming ${d.label}.`);
        });

        (o.destChoices || []).forEach(dest => {
            const d = destTable.find(x => x.id === dest.id);
            if (!d || !d.requires) return;
            d.requires.forEach(key => {
                if (o.options && o.options[key]) return;
                const opt = (cfg.options || []).find(x => x.key === key);
                warnings.push(`${d.label} is exclusief toeslagen — ${opt ? opt.desc : key} staat niet aangevinkt.`);
            });
        });

        if (o.ggbEntries === 0) warnings.push('Geen GGB / CHED entries — er wordt geen keurpunt en geen CHED in rekening gebracht.');
        if (o.copyChedQty > o.ggbEntries && o.ggbEntries > 0) warnings.push('Meer kopie-CHED regels dan GGB entries.');
        if (o.nettKg === 0) warnings.push('Netto gewicht is 0 — er wordt geen NVWA keurloon geboekt.');
        if (o.nettKg > NVWA.maxKg) warnings.push(`Netto gewicht boven ${NVWA.maxKg} kg — NVWA is afgetopt op ${money(NVWA.max)}.`);
        if (!o.dieselInput) warnings.push('Geen dieseltoeslag ingevuld.');
        if (cfg.dieselIncluded > 0 && o.dieselInput && String(o.dieselInput).endsWith('%')) {
            const pct = parseFloat(o.dieselInput);
            if (pct <= cfg.dieselIncluded * 100) warnings.push(`Dieseltoeslag ${o.dieselInput} ligt op of onder de ${Math.round(cfg.dieselIncluded * 100)}% die al in het tarief zit — er wordt niets extra doorbelast.`);
        }
        const outlayLines = items.filter(i => i.isOutlay);
        if (outlayLines.length) {
            warnings.push(`${outlayLines.length} regel(s) net net per outlay — controleer de bedragen tegen de leveranciersfactuur.`);
        }
        const negatives = items.filter(i => i.price < 0 && !/tantieme/i.test(i.desc));
        if (negatives.length) warnings.push('Er staan onverwachte negatieve bedragen in de regels.');

        return warnings;
    }

    /* =========================================================================
       PRESETS
       ========================================================================= */
    const presetKey = t => `fiton_presets_${t}`;

    function loadPresets(t) {
        try {
            const raw = JSON.parse(localStorage.getItem(presetKey(t)) || 'null');
            if (Array.isArray(raw)) return raw;
            if (raw && typeof raw === 'object') return [{ name: 'Standaard', opts: raw }];  // migrate the old single default
        } catch (e) { log('Presets unreadable'); }
        return [];
    }
    function savePresets(t, list) {
        try { localStorage.setItem(presetKey(t), JSON.stringify(list)); }
        catch (e) { log('Preset save failed'); }
    }
    function upsertPreset(t, name, opts) {
        const list = loadPresets(t).filter(p => p.name !== name);
        list.push({ name, opts });
        savePresets(t, list);
        return list;
    }
    function deletePreset(t, name) {
        const list = loadPresets(t).filter(p => p.name !== name);
        savePresets(t, list);
        return list;
    }

    /* =========================================================================
       CONFIG MODAL
       ========================================================================= */

    /* Modals resize from the bottom-right corner; the size is remembered per
       modal so you only have to drag it once. */
    function enableModalResize(overlay, key) {
        const modal = overlay.querySelector('.fip-modal');
        if (!modal) return;

        const MIN_W = 380, MIN_H = 300;
        const maxW = () => Math.min(window.innerWidth - 32, window.innerWidth * 0.96);
        const maxH = () => Math.min(window.innerHeight - 32, window.innerHeight * 0.92);
        const clampW = w => Math.max(MIN_W, Math.min(maxW(), w));
        const clampH = h => Math.max(MIN_H, Math.min(maxH(), h));

        function applySize(w, h) {
            modal.style.width = clampW(w) + 'px';
            modal.style.height = clampH(h) + 'px';
            modal.style.maxWidth = 'none';      // an explicit size wins over the caps
            modal.style.maxHeight = 'none';
        }

        // restore the size this dialog was last dragged to
        try {
            const saved = JSON.parse(localStorage.getItem(key) || 'null');
            if (saved && saved.w && saved.h) applySize(saved.w, saved.h);
        } catch (e) { log('Stored modal size unreadable'); }

        const grip = document.createElement('div');
        grip.className = 'fip-modal-grip';
        grip.title = 'Sleep om te vergroten · dubbelklik om te herstellen';
        modal.appendChild(grip);

        let drag = null;

        grip.addEventListener('pointerdown', e => {
            e.preventDefault();
            e.stopPropagation();
            const r = modal.getBoundingClientRect();
            drag = { x: e.clientX, y: e.clientY, w: r.width, h: r.height };
            modal.classList.add('is-resizing');
            try { grip.setPointerCapture(e.pointerId); } catch (err) {}
        });

        grip.addEventListener('pointermove', e => {
            if (!drag) return;
            // The dialog is centred, so it grows from both edges: a 1px pointer
            // move changes the corner by half a pixel. Doubling the delta keeps
            // the grip exactly under the cursor.
            applySize(drag.w + (e.clientX - drag.x) * 2, drag.h + (e.clientY - drag.y) * 2);
        });

        function endDrag(e) {
            if (!drag) return;
            drag = null;
            modal.classList.remove('is-resizing');
            try { grip.releasePointerCapture(e.pointerId); } catch (err) {}
            const r = modal.getBoundingClientRect();
            localStorage.setItem(key, JSON.stringify({ w: Math.round(r.width), h: Math.round(r.height) }));
        }
        grip.addEventListener('pointerup', endDrag);
        grip.addEventListener('pointercancel', endDrag);

        // double-click the grip to go back to the default size
        grip.addEventListener('dblclick', e => {
            e.stopPropagation();
            modal.style.width = '';
            modal.style.height = '';
            modal.style.maxWidth = '';
            modal.style.maxHeight = '';
            localStorage.removeItem(key);
        });

        // keep a restored size inside the window if it got smaller since
        const onWindowResize = () => {
            if (!modal.style.width) return;
            applySize(parseFloat(modal.style.width), parseFloat(modal.style.height));
        };
        window.addEventListener('resize', onWindowResize);
        overlay.addEventListener('fip-close', () => window.removeEventListener('resize', onWindowResize));
    }

    function showConfigModal(templateType, callback) {
        if (document.querySelector('.fip-overlay')) return;
        const cfg = CLIENTS[templateType];
        if (!cfg) return;
        const nl = cfg.lang === 'nl';
        const t = (nlText, enText) => (nl ? nlText : enText);
        const presets = loadPresets(templateType);
        const preset = (presets[0] && presets[0].opts) || {};
        const exp = expiredRates();

        const destList = (DESTINATIONS[templateType] || []).map(d => {
            const checked = preset.destIds ? preset.destIds.includes(d.id) : !!d.checked;
            return `
            <label class="fip-check" data-search="${esc(d.label.toLowerCase())}">
                <input type="checkbox" name="modal-dest" value="${d.id}" data-name="${esc(d.label)}" ${checked ? 'checked' : ''}>
                <span>${esc(d.label)}</span>
                ${d.note ? `<span class="fip-tag">${esc(d.note)}</span>` : ''}
                <span class="fip-price">${money(d.price)}</span>
            </label>`;
        }).join('');

        const pv = (key, fallback) => (preset[key] !== undefined ? preset[key] : fallback);
        const ck = (key, fallback) => (pv(key, fallback) ? 'checked' : '');

        const optionalDocs = (cfg.options && cfg.options.length) ? `
            <div class="fip-card">
                <div class="fip-card-title">${t('Optionele documenten en toeslagen', 'Optional documents &amp; surcharges')}</div>
                <div class="fip-checklist">
                    ${cfg.options.map(opt => `
                    <label class="fip-check">
                        <input type="checkbox" class="fip-opt" data-key="${opt.key}" ${(pv('options', {})[opt.key]) ? 'checked' : ''}>
                        <span>${esc(opt.desc)}</span>
                        <span class="fip-price">${money(opt.price)}</span>
                    </label>`).join('')}
                </div>
            </div>` : '';

        const overlay = document.createElement('div');
        overlay.className = 'fip-overlay fip-root';
        overlay.innerHTML = `
        <div class="fip-modal" role="dialog" aria-modal="true">
            <div class="fip-modal-head">
                <div>
                    <h3>${esc(cfg.name)}</h3>
                    <p>${esc(cfg.subtitle)} · ${t('alle bedragen in', 'all amounts in')} ${CURRENCY_CODE}</p>
                </div>
                <button class="fip-modal-close" id="modal-cancel" title="${t('Sluiten', 'Close')} (Esc)">&times;</button>
            </div>

            <div class="fip-modal-body">
                ${exp.transport ? `<div class="fip-banner"><span>⚠</span><div><b>${t('Let op: tariefgeldigheid verlopen.', 'Note: rate validity expired.')}</b> ${t(`Transporttarieven waren geldig t/m ${VALIDITY.transport}.`, `Transport rates were valid until ${VALIDITY.transport}.`)}</div></div>` : ''}

                <div class="fip-card">
                    <div class="fip-card-title">${t('Zending', 'Shipment')}</div>
                    <div class="fip-grid">
                        <div class="fip-field">
                            <label>${t('Aantal containers', 'Number of containers')}</label>
                            <input type="number" id="modal-containers" min="1" step="1" value="${pv('containers', 1)}">
                            <div class="fip-hint">${t('Vermenigvuldigt alle per-container regels', 'Multiplies every per-container line')}</div>
                        </div>
                    </div>
                </div>

                <div class="fip-card">
                    <div class="fip-card-title">${t('Bestemmingen', 'Destinations')} <span class="fip-count" id="dest-count">0</span></div>
                    <div class="fip-toolbar">
                        <input type="text" id="dest-filter" placeholder="${t('Zoek bestemming…', 'Filter destinations…')}">
                        <button type="button" class="fip-btn fip-btn-ghost fip-btn-sm" id="dest-clear">${t('Wis', 'Clear')}</button>
                    </div>
                    <div class="fip-scroll"><div class="fip-checklist" id="dest-list">${destList}</div></div>
                </div>

                <div class="fip-card">
                    <div class="fip-card-title">${t('Toll &amp; Maut per zending', 'Toll &amp; Maut per shipment')}</div>
                    <div id="per-shipment-toll-container"></div>
                </div>

                <div class="fip-card">
                    <div class="fip-card-title">${t('Documentatie', 'Documentation')}</div>
                    <div class="fip-grid">
                        <div class="fip-field">
                            <label>GGB / CHED entries</label>
                            <input type="number" id="modal-ggb-entries" min="0" step="1" value="${pv('ggbEntries', 1)}">
                            <div class="fip-hint">${money(cfg.ggb.price)} + ${money(cfg.inspectionPoint.price)} ${t('keurpunt', 'inspection point')}</div>
                        </div>
                        <div class="fip-field">
                            <label>${esc(cfg.copyChed.desc)}</label>
                            <input type="number" id="modal-copy-ched" min="0" step="1" value="${pv('copyChedQty', cfg.copyChed.defaultQty)}">
                            <div class="fip-hint">${money(cfg.copyChed.price)} ${t('per stuk', 'each')}</div>
                        </div>
                        ${cfg.catchCerts ? `
                        <div class="fip-field">
                            <label>${t('Vangstcertificaten', 'Catch certificates')}</label>
                            <input type="number" id="modal-catch-certs" min="0" step="1" value="${pv('catchCerts', 1)}">
                            <div class="fip-hint">${money(50)} ${t('per stuk', 'each')}</div>
                        </div>
                        <div class="fip-field">
                            <label>${t('Verwerkingsverklaringen', 'Processing statements')}</label>
                            <input type="number" id="modal-proc-statements" min="0" step="1" value="${pv('procStatements', 1)}">
                            <div class="fip-hint">${money(25)} ${t('per stuk', 'each')}</div>
                        </div>` : ''}
                    </div>
                </div>

                ${optionalDocs}


                ${(cfg.extras && cfg.extras.length) ? `
                <div class="fip-card">
                    <div class="fip-card-title">${t('Coldstore & terminal', 'Coldstore & terminal')} <span class="fip-count" id="extras-count">0</span></div>
                    <div class="fip-hint" style="margin:-4px 0 10px;">${t('Laat leeg wat niet van toepassing is.', 'Leave blank what does not apply.')}</div>
                    ${[...new Set(cfg.extras.map(x => x.group))].map(group => `
                        <div class="fip-subgroup">
                            <div class="fip-subgroup-title">${esc(group)}</div>
                            <div class="fip-grid">
                                ${cfg.extras.filter(x => x.group === group).map(x => `
                                <div class="fip-field">
                                    <label>${esc(x.desc)}</label>
                                    <input type="number" class="fip-extra" data-key="${x.key}" min="0" step="0.01"
                                           placeholder="0" value="${(pv('extras', {})[x.key]) || ''}">
                                    <div class="fip-hint">${money(x.price)} / ${esc(x.unit)}</div>
                                </div>`).join('')}
                            </div>
                        </div>`).join('')}
                </div>` : ''}

                <div class="fip-card">
                    <div class="fip-card-title">${t('Net net per outlay', 'Net net as per outlay')} <span class="fip-count" id="outlay-count">0</span></div>
                    <div class="fip-hint" style="margin:-4px 0 10px;">${t(
                        'Geen tarief in de offerte — vul het werkelijke bedrag van de leveranciersfactuur in. Leeg = niet doorbelasten.',
                        'No tariff in the offer — enter the actual amount from the supplier invoice. Blank = not charged.')}</div>
                    <div class="fip-grid">
                        ${OUTLAY_ITEMS.map(oi => `
                        <div class="fip-field">
                            <label>${esc(nl ? oi.nl : oi.en)}</label>
                            <input type="number" class="outlay-input" id="outlay-${oi.key}" data-key="${oi.key}" min="0" step="0.01" placeholder="0,00" value="${pv('outlays', {})[oi.key] || ''}">
                        </div>`).join('')}
                        <div class="fip-field">
                            <label>${t('Overig — omschrijving', 'Other — description')}</label>
                            <input type="text" id="outlay-other-desc" value="${esc(pv('outlayOtherDesc', ''))}" placeholder="${t('bijv. weegkosten', 'e.g. weighing costs')}">
                        </div>
                        <div class="fip-field">
                            <label>${t('Overig — bedrag', 'Other — amount')}</label>
                            <input type="number" id="outlay-other-amount" min="0" step="0.01" placeholder="0,00" value="${pv('outlayOtherAmount', '') || ''}">
                        </div>
                    </div>
                </div>

                <div class="fip-card">
                    <div class="fip-card-title">${t('Toeslagen', 'Surcharges')}</div>
                    <div class="fip-checklist">
                        <label class="fip-check"><input type="checkbox" id="modal-genset" ${ck('includeGenset', cfg.genset.defaultChecked)}><span>${esc(cfg.genset.desc)}</span><span class="fip-price">${money(cfg.genset.price)}</span></label>
                        <label class="fip-check"><input type="checkbox" id="modal-ect" ${ck('includeEct', templateType === 'kuhneheitz')}><span>ECT (Terminal) peak surcharge</span><span class="fip-price">${money(ECT_SURCHARGE)}</span></label>
                        <label class="fip-check"><input type="checkbox" id="modal-rwg" ${ck('includeRwg', templateType === 'vbfood' || templateType === 'kuhneheitz')}><span>RWG (Terminal) peak surcharge</span><span class="fip-price">${money(RWG_SURCHARGE)}</span></label>
                        <label class="fip-check"><input type="checkbox" id="modal-afterhours" ${ck('includeAfterHours', false)}><span>${esc(cfg.afterHours.desc)}</span><span class="fip-price">${money(cfg.afterHours.price)}</span></label>
                        <label class="fip-check"><input type="checkbox" id="modal-min-kg-keurloon" ${ck('includeMinKg', false)}><span>${t('Minimum KG keurloon', 'Minimum KG inspection fee')}</span><span class="fip-price">${money(NVWA.min)}</span></label>
                    </div>
                    <div id="modal-min-kg-container" style="display:none; margin-top:8px; max-width:180px;">
                        <div class="fip-field">
                            <label>${t('Aantal', 'Quantity')}</label>
                            <input type="number" id="modal-min-kg-qty" min="1" step="1" value="${pv('minKgQty', 1)}">
                        </div>
                    </div>
                </div>

                <div class="fip-card">
                    <div class="fip-card-title">${t('Gewicht, dagen en uren', 'Weight, days and hours')}</div>
                    <div class="fip-grid">
                        <div class="fip-field">
                            <label>${t('Netto gewicht (kg)', 'Nett weight (kg)')}</label>
                            <input type="number" id="modal-nett" min="0" step="1" value="${pv('nettKg', 6000)}">
                            <div class="fip-hint">${NVWA.rate}/kg · min ${money(NVWA.min)} · max ${money(NVWA.max)} (${NVWA.maxKg} kg)</div>
                        </div>
                        ${cfg.chassis ? `
                        <div class="fip-field">
                            <label>${t('Chassishuur (dagen)', 'Chassis rental (days)')}</label>
                            <input type="number" id="modal-chassis-days" min="0" step="1" value="${pv('chassisDays', 0)}">
                            <div class="fip-hint">${money(cfg.chassis.price)} ${t('per dag', 'per day')}</div>
                        </div>` : ''}
                        ${cfg.plugin ? `
                        <div class="fip-field">
                            <label>${esc(cfg.plugin.label)}</label>
                            <input type="number" id="modal-plugin-days" min="0" step="1" value="${pv('pluginDays', 0)}">
                            <div class="fip-hint">${money(cfg.plugin.price)} ${t('per dag', 'per day')}</div>
                        </div>` : ''}
                        <div class="fip-field">
                            <label>${t('Wachturen', 'Waiting hours')}</label>
                            <input type="number" id="modal-waiting" min="0" step="0.5" value="${pv('waitingHours', 0)}">
                            <div class="fip-hint">${money(cfg.waiting.price)} ${t('per uur', 'per hour')}</div>
                        </div>
                        <div class="fip-field">
                            <label>${t('Dieseltoeslag', 'Diesel surcharge')}</label>
                            <input type="text" id="modal-diesel" value="${esc(pv('dieselInput', cfg.dieselDefault))}">
                            <div class="fip-hint">${cfg.dieselIncluded > 0
                                ? `${Math.round(cfg.dieselIncluded * 100)}% ${t('zit al in het tarief; alleen het meerdere wordt doorbelast', 'is already in the rate; only the excess is charged')}`
                                : t('percentage (21%) of vast bedrag (€45)', 'percentage (21%) or fixed amount (€45)')}</div>
                        </div>
                        ${cfg.tantieme ? `
                        <div class="fip-field">
                            <label>Tantieme (−${money(50)})</label>
                            <select id="modal-tantieme">
                                <option value="">${t('Geen', 'None')}</option>
                                ${cfg.tantieme.map(x => `<option value="${esc(x)}" ${pv('tantiemeClient', '') === x ? 'selected' : ''}>${esc(x)}</option>`).join('')}
                            </select>
                        </div>` : ''}
                    </div>
                </div>
            </div>

            <div class="fip-modal-foot">
                <div class="fip-preset-bar">
                    <select id="modal-preset-select" title="${t('Opgeslagen instellingen', 'Saved presets')}">
                        <option value="">${t('Presets…', 'Presets…')}</option>
                        ${presets.map(pr => `<option value="${esc(pr.name)}">${esc(pr.name)}</option>`).join('')}
                    </select>
                    <button type="button" class="fip-btn fip-btn-ghost fip-btn-sm" id="modal-preset-save">${t('Bewaar…', 'Save…')}</button>
                    <button type="button" class="fip-btn fip-btn-ghost fip-btn-sm" id="modal-preset-delete" title="${t('Verwijder preset', 'Delete preset')}">&times;</button>
                </div>
                <div class="fip-foot-total">
                    <span id="foot-lines">0 ${t('regels', 'lines')}</span>
                    <strong id="foot-total">${money(0)}</strong>
                </div>
                <button type="button" class="fip-btn fip-btn-primary" id="modal-submit">${t('Controleer regels', 'Review lines')}</button>
            </div>
        </div>`;

        document.body.appendChild(overlay);
        enableModalResize(overlay, 'fiton_modal_size_config');

        const $ = id => document.getElementById(id);
        const numVal = (id, fb = 0) => { const el = $(id); if (!el) return fb; const v = parseFloat(el.value); return isNaN(v) ? fb : v; };
        const boolVal = id => { const el = $(id); return el ? el.checked : false; };

        function collectOpts() {
            const destChoices = [];
            document.querySelectorAll('.fip-route').forEach(row => {
                destChoices.push({
                    id: row.getAttribute('data-val'),
                    name: row.getAttribute('data-name'),
                    maut: parseFloat(row.querySelector('.route-maut').value) || 0,
                    toll: parseFloat(row.querySelector('.route-toll').value) || 0
                });
            });
            const selectedOptions = {};
            document.querySelectorAll('.fip-opt').forEach(cb => {
                if (cb.checked) selectedOptions[cb.getAttribute('data-key')] = true;
            });

            const extras = {};
            document.querySelectorAll('.fip-extra').forEach(inp => {
                const v = parseFloat(inp.value);
                if (!isNaN(v) && v > 0) extras[inp.getAttribute('data-key')] = v;
            });

            const outlays = {};
            document.querySelectorAll('.outlay-input').forEach(inp => {
                const v = parseFloat(inp.value);
                if (!isNaN(v) && v > 0) outlays[inp.getAttribute('data-key')] = round2(v);
            });
            return {
                destChoices,
                destIds: destChoices.map(d => d.id),
                outlays,
                outlayOtherDesc: ($('outlay-other-desc') || {}).value || '',
                outlayOtherAmount: Math.max(0, numVal('outlay-other-amount', 0)),
                ggbEntries:     Math.max(0, Math.round(numVal('modal-ggb-entries', 0))),
                copyChedQty:    Math.max(0, Math.round(numVal('modal-copy-ched', 0))),
                catchCerts:     Math.max(0, Math.round(numVal('modal-catch-certs', 0))),
                procStatements: Math.max(0, Math.round(numVal('modal-proc-statements', 0))),
                includeGenset:  boolVal('modal-genset'),
                includeEct:     boolVal('modal-ect'),
                includeRwg:     boolVal('modal-rwg'),
                includeAfterHours: boolVal('modal-afterhours'),
                includeMinKg:   boolVal('modal-min-kg-keurloon'),
                minKgQty:       numVal('modal-min-kg-qty', 1) || 1,
                containers: Math.max(1, Math.round(numVal('modal-containers', 1))),
                options: selectedOptions,
                extras,
                nettKg:      Math.max(0, numVal('modal-nett', 0)),
                chassisDays: Math.max(0, Math.round(numVal('modal-chassis-days', 0))),
                pluginDays:  Math.max(0, Math.round(numVal('modal-plugin-days', 0))),
                dieselInput: ($('modal-diesel') || {}).value || '',
                waitingHours: Math.max(0, numVal('modal-waiting', 0)),
                tantiemeClient: ($('modal-tantieme') || {}).value || ''
            };
        }

        let lastTotal = 0;
        function refreshTotals() {
            const items = buildItemsList(templateType, collectOpts());
            const total = items.reduce((s, i) => s + i.qty * i.price, 0);
            animateNumber($('foot-total'), lastTotal, total, money);
            lastTotal = total;
            $('foot-lines').textContent = `${items.length} ${t('regels', 'lines')}`;
            const n = document.querySelectorAll('input[name="modal-dest"]:checked').length;
            $('dest-count').textContent = n;
            const extrasEl = $('extras-count');
            if (extrasEl) {
                extrasEl.textContent = Array.from(document.querySelectorAll('.fip-extra'))
                    .filter(i => parseFloat(i.value) > 0).length;
            }
            const outlayEl = $('outlay-count');
            if (outlayEl) {
                const filled = Array.from(document.querySelectorAll('.outlay-input')).filter(i => parseFloat(i.value) > 0).length
                    + (numVal('outlay-other-amount', 0) > 0 ? 1 : 0);
                outlayEl.textContent = filled;
            }
            $('modal-submit').disabled = n === 0;
        }

        function rebuildRoutes() {
            const container = $('per-shipment-toll-container');
            const checked = Array.from(document.querySelectorAll('input[name="modal-dest"]:checked'));
            if (!checked.length) {
                container.innerHTML = `<div class="fip-empty">${t('Selecteer eerst een bestemming.', 'Select a destination first.')}</div>`;
                return;
            }
            const existing = {};
            document.querySelectorAll('.fip-route').forEach(r => {
                existing[r.getAttribute('data-val')] = {
                    maut: r.querySelector('.route-maut').value,
                    toll: r.querySelector('.route-toll').value
                };
            });
            container.innerHTML = checked.map((cb, i) => {
                const id = cb.value, name = cb.getAttribute('data-name');
                const prev = existing[id] || { maut: '0.00', toll: '0.00' };
                return `
                <div class="fip-route" data-val="${id}" data-name="${esc(name)}">
                    <div class="fip-route-name" title="${esc(name)}">${i + 1}. ${esc(name)}</div>
                    <div class="fip-route-fld"><label>Maut (DE) ${CURRENCY_SYMBOL}</label><input type="number" class="route-maut" step="0.01" min="0" value="${prev.maut}"></div>
                    <div class="fip-route-fld"><label>Tol (NL) ${CURRENCY_SYMBOL}</label><input type="number" class="route-toll" step="0.01" min="0" value="${prev.toll}"></div>
                </div>`;
            }).join('');
            container.querySelectorAll('input').forEach(inp => inp.addEventListener('input', refreshTotals));
        }

        overlay.addEventListener('input', e => {
            if (e.target.id === 'dest-filter') {
                const q = e.target.value.toLowerCase();
                document.querySelectorAll('#dest-list .fip-check').forEach(l => {
                    l.style.display = l.getAttribute('data-search').includes(q) ? '' : 'none';
                });
                return;
            }
            if (!e.target.closest('.fip-route')) refreshTotals();
        });
        // Some destinations are quoted excluding surcharges - tick what they need.
        function applyRequiredOptions() {
            const table = DESTINATIONS[templateType] || [];
            document.querySelectorAll('input[name="modal-dest"]:checked').forEach(cb => {
                const d = table.find(x => x.id === cb.value);
                if (!d || !d.requires) return;
                d.requires.forEach(key => {
                    const opt = document.querySelector(`.fip-opt[data-key="${key}"]`);
                    if (opt && !opt.checked) opt.checked = true;
                });
            });
        }

        overlay.addEventListener('change', e => {
            if (e.target.name === 'modal-dest') { applyRequiredOptions(); rebuildRoutes(); }
            if (e.target.id === 'modal-min-kg-keurloon') {
                $('modal-min-kg-container').style.display = e.target.checked ? 'block' : 'none';
            }
            refreshTotals();
        });

        $('dest-clear').addEventListener('click', () => {
            document.querySelectorAll('input[name="modal-dest"]').forEach(c => { c.checked = false; });
            $('dest-filter').value = '';
            document.querySelectorAll('#dest-list .fip-check').forEach(l => { l.style.display = ''; });
            rebuildRoutes(); refreshTotals();
        });

        const close = () => {
            overlay.dispatchEvent(new Event('fip-close'));
            if (overlay.parentNode) document.body.removeChild(overlay);
            document.removeEventListener('keydown', onKey);
        };
        function onKey(e) { if (e.key === 'Escape') close(); }
        document.addEventListener('keydown', onKey);
        $('modal-cancel').addEventListener('click', close);
        overlay.addEventListener('mousedown', e => { if (e.target === overlay) close(); });

        function applyPresetOpts(opts) {
            if (!opts) return;
            const setNum = (id, v) => { const el = $(id); if (el && v !== undefined) el.value = v; };
            setNum('modal-containers', opts.containers);
            setNum('modal-ggb-entries', opts.ggbEntries);
            setNum('modal-copy-ched', opts.copyChedQty);
            setNum('modal-catch-certs', opts.catchCerts);
            setNum('modal-proc-statements', opts.procStatements);
            setNum('modal-nett', opts.nettKg);
            setNum('modal-chassis-days', opts.chassisDays);
            setNum('modal-plugin-days', opts.pluginDays);
            setNum('modal-waiting', opts.waitingHours);
            setNum('modal-diesel', opts.dieselInput);
            if ($('modal-tantieme')) $('modal-tantieme').value = opts.tantiemeClient || '';

            [['modal-genset','includeGenset'], ['modal-ect','includeEct'], ['modal-rwg','includeRwg'],
             ['modal-afterhours','includeAfterHours'], ['modal-min-kg-keurloon','includeMinKg']]
                .forEach(([id, key]) => { const el = $(id); if (el) el.checked = !!opts[key]; });

            document.querySelectorAll('.fip-opt').forEach(cb => {
                cb.checked = !!(opts.options && opts.options[cb.getAttribute('data-key')]);
            });
            document.querySelectorAll('.fip-extra').forEach(inp => {
                inp.value = (opts.extras && opts.extras[inp.getAttribute('data-key')]) || '';
            });
            document.querySelectorAll('.outlay-input').forEach(inp => {
                inp.value = (opts.outlays && opts.outlays[inp.getAttribute('data-key')]) || '';
            });
            document.querySelectorAll('input[name="modal-dest"]').forEach(cb => {
                cb.checked = !!(opts.destIds && opts.destIds.includes(cb.value));
            });
            $('modal-min-kg-container').style.display = $('modal-min-kg-keurloon').checked ? 'block' : 'none';
            applyRequiredOptions();
            rebuildRoutes();
            refreshTotals();
        }

        $('modal-preset-select').addEventListener('change', e => {
            const chosen = loadPresets(templateType).find(pr => pr.name === e.target.value);
            if (chosen) applyPresetOpts(chosen.opts);
        });

        $('modal-preset-save').addEventListener('click', () => {
            const sel = $('modal-preset-select');
            const suggested = sel.value || t('Standaard', 'Default');
            const name = (prompt(t('Naam voor deze instellingen:', 'Name for these settings:'), suggested) || '').trim();
            if (!name) return;
            const list = upsertPreset(templateType, name, collectOpts());
            sel.innerHTML = `<option value="">${t('Presets…', 'Presets…')}</option>`
                + list.map(pr => `<option value="${esc(pr.name)}">${esc(pr.name)}</option>`).join('');
            sel.value = name;
        });

        $('modal-preset-delete').addEventListener('click', () => {
            const sel = $('modal-preset-select');
            if (!sel.value) return;
            const list = deletePreset(templateType, sel.value);
            sel.innerHTML = `<option value="">${t('Presets…', 'Presets…')}</option>`
                + list.map(pr => `<option value="${esc(pr.name)}">${esc(pr.name)}</option>`).join('');
        });

        $('modal-submit').addEventListener('click', () => {
            const opts = collectOpts();
            if (!opts.destChoices.length) return;
            close();
            callback(opts);
        });

        if ($('modal-min-kg-keurloon').checked) $('modal-min-kg-container').style.display = 'block';
        overlay.addEventListener('keydown', e => {
            if (e.key === 'Enter' && e.target.tagName === 'INPUT' && e.target.type !== 'checkbox') {
                e.preventDefault();
                $('modal-submit').click();
            }
        });

        applyRequiredOptions();
        rebuildRoutes();
        refreshTotals();
        const firstField = $('modal-containers');
        if (firstField) { firstField.focus(); firstField.select(); }
    }

    /* =========================================================================
       WORKLIST - one specification, many containers
       -------------------------------------------------------------------------
       A consolidated invoice covers containers spread over many shipments, so
       booking it means: look the container up in Forwarding > Search, open its
       shipment, open the cost form, book that container's lines, go back, next.
       The worklist survives every page load in localStorage, so the run
       continues across all that navigation.
       ========================================================================= */
    const SEARCH_MAP = {
        containerField: 'P4999_CONTAINER_NR',
        bookingField: 'P4999_BOOKING_NO',
        searchBtn: 'set_btn',
        breadcrumb: 'Search'
    };
    const WORKLIST_KEY = 'fiton_worklist';
    const REPORT_KEY = 'fiton_last_report';
    const REPORT_DOC_KEY = 'fiton_report_document';   // chrome.storage.local: the PDF for the dashboard
    const MAX_REPORT_DOC_BYTES = 4 * 1024 * 1024;     // per invoice, as before
    const MAX_REPORT_DOC_TOTAL = 32 * 1024 * 1024;   // for a stack of them together

    /* How long to give FitOn to return a search result before deciding a
       container does not exist. The result grid loads after the page does, so
       counting attempts was wrong: three ticks passed in well under a second
       and every container looked missing. This waits on the clock instead. */
    const SEARCH_WAIT_MS = 12000;      // no result yet, keep waiting
    const SEARCH_RETRY_MS = 6000;      // press Search once more after this
    const NODATA_WAIT_MS = 2500;       // "no data found" shown: confirm briefly first

    const loadWorklist = () => {
        try { return JSON.parse(localStorage.getItem(WORKLIST_KEY) || 'null'); }
        catch (e) { return null; }
    };
    const saveWorklist = w => localStorage.setItem(WORKLIST_KEY, JSON.stringify(w));
    const clearWorklist = () => localStorage.removeItem(WORKLIST_KEY);

    /* The Search page's "Shipment id" field, found by its label so the APEX
       item name does not have to be known in advance. */
    function findFieldByLabel(re) {
        for (const lab of document.querySelectorAll('label[for]')) {
            if (!re.test((lab.textContent || '').replace(/\s+/g, ' ').trim())) continue;
            const field = document.getElementById(lab.getAttribute('for'));
            if (field && /^(input|textarea|select)$/i.test(field.tagName)) return field;
        }
        return null;
    }
    const shipmentIdField = () => findFieldByLabel(/^shipment\s*id\b/i);

    /* A Search field for a unit other than a container, by its label. Not every
       FitOn search page has one for each kind; without it the unit is reported
       as not found, with the number to look up by hand. */
    const UNIT_SEARCH_LABELS = {
        awb: /\b([mh]?awb|air\s*waybill)\b/i,
        bl: /\b([hm]?b\/?l|bill\s*of\s*lading)\b/i,
        trailer: /\b(trailer|oplegger)\b/i,
        plate: /\b(kenteken|licen[cs]e\s*plate|truck)\b/i,
        wagon: /\bwag(on|en)\b/i,
        cmr: /\bcmr\b/i
    };
    const unitSearchField = kind => (UNIT_SEARCH_LABELS[kind] ? findFieldByLabel(UNIT_SEARCH_LABELS[kind]) : null);

    function onSearchPage() {
        return !!document.getElementById(SEARCH_MAP.containerField);
    }
    /* Pages a worklist passes through on its way to the cost form: those with
       the Costs region, and those where Financials has to be opened first
       (SETTINGS.pages, see DEFAULT_PAGES). */
    function onShipmentPage() {
        const page = apexPageId();
        return !!page && (pageList('costs').includes(page) || pageList('financials').includes(page));
    }

    /* The number of the shipment a cost is being booked on, as FitOn shows it
       on the shipment page: P606_BOOKING_NO_DISPLAY on a sea or air shipment,
       P3701_BOOKING_NO_DISPLAY on a road one. An invoice names a container or a
       B/L and never this number, so unless it is read here while we are on the
       page, the end report cannot say which dossier a line ended up on. Other
       page numbers carry the same field under their own prefix, so those are
       tried too rather than guessed at. */
    const BOOKING_NO_IDS = ['P606_BOOKING_NO_DISPLAY', 'P3701_BOOKING_NO_DISPLAY'];

    function shipmentNoOnPage() {
        const value = el => (el && (el.textContent || '').trim()) || '';
        for (const id of BOOKING_NO_IDS) {
            const v = value(document.getElementById(id));
            if (isShipmentId(v)) return v;
        }
        for (const el of document.querySelectorAll('[id$="_BOOKING_NO_DISPLAY"]')) {
            const v = value(el);
            if (isShipmentId(v)) return v;
        }
        return '';
    }

    /* Only on a Financials page itself, so a sea shipment that has not finished
       drawing its Costs region is never sent somewhere else. */
    function findFinancialsButton() {
        if (!pageList('financials').includes(apexPageId())) return null;
        return Array.from(document.querySelectorAll('a.t-Button, button'))
                .find(b => /^financials$/i.test((b.innerText || b.textContent || '').trim()))
            || pageList('costs').map(p => document.querySelector(`a[href*=":${p}:"]`)).find(Boolean)
            || null;
    }

    /* The search result row links to the shipment and carries its booking seq:
       f?p=10050:606:<session>:::RP:P606_BOOKING_SEQ,P606_RETURN_PAGE:162917,4999&cs=...
       We follow that link rather than building a URL, because APEX checksums
       links and a hand-made one would be rejected. */
    function findShipmentLink(container) {
        // letters and digits only: a waybill shows as 176-12345675 or 17612345675
        const wanted = String(container || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

        // The pencil in the result row opens the shipment. Match the row on the
        // container number first so we can never open the wrong shipment.
        for (const pencil of document.querySelectorAll('img.apex-edit-pencil')) {
            const link = pencil.closest('a');
            if (!link) continue;
            const row = pencil.closest('tr');
            const text = ((row && row.innerText) || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
            if (wanted && !text.includes(wanted)) continue;
            const seq = /P\d+_BOOKING_SEQ[^:]*:(\d+)/.exec(link.getAttribute('href') || '');
            return { link, seq: seq ? seq[1] : null };
        }
        return null;
    }

    /* The shipment page has a Costs region and a Revenues region, each with its
       own Create button. They are told apart by data-otel-label, so Create can
       never be pressed on the wrong region. */
    const REGION_CREATE = { cost: 'CREATE_COSTS', revenue: 'CREATE_REVENUES' };

    function findRegionCreateButton(kind) {
        const label = REGION_CREATE[kind] || REGION_CREATE.cost;
        const byLabel = document.querySelector(`[data-otel-label="${label}"]`);
        if (byLabel) return byLabel;

        // Fallback: the Create button inside the region titled Costs.
        const wanted = kind === 'revenue' ? /revenue|omzet/i : /^costs?$|kosten/i;
        for (const region of document.querySelectorAll('.t-Region')) {
            const title = region.querySelector('.t-Region-title');
            if (!title || !wanted.test((title.textContent || '').trim())) continue;
            const btn = Array.from(region.querySelectorAll('button, a.t-Button'))
                .find(b => /^create$/i.test((b.innerText || b.textContent || '').trim()));
            if (btn) return btn;
        }
        return document.querySelector('a[href*="P673_BOOKING_SEQ"], a[href*=":673:"]');
    }

    /* A run touches many shipments across many page loads, so it has to say
       plainly afterwards what was booked and what was not, with the reason. */
    function loadLastReport() {
        try { return JSON.parse(localStorage.getItem(REPORT_KEY) || 'null'); }
        catch (e) { return null; }
    }

    function refreshReportButton() {
        const btn = document.getElementById('report-btn');
        if (!btn) return;
        const rep = loadLastReport();
        if (!rep || !rep.worklist) { btn.style.display = 'none'; return; }
        const when = new Date(rep.at).toLocaleString('nl-NL', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
        btn.textContent = `Laatste rapport (${when})`;
        btn.style.display = 'block';
    }

    function showWorklistReport(w) {
        if (document.querySelector('.fip-ask')) return;

        const LABEL = {
            done:      { text: 'Geboekt',        cls: 'ok' },
            duplicate: { text: 'Overgeslagen',   cls: 'warn' },
            notfound:  { text: 'Niet gevonden',  cls: 'bad' },
            failed:    { text: 'Mislukt',        cls: 'bad' },
            pending:   { text: 'Niet verwerkt',  cls: 'warn' },
            booking:   { text: 'Onbekend',       cls: 'warn' }
        };
        const count = st => w.items.filter(i => i.status === st).length;
        const bookedSum = w.items.filter(i => i.status === 'done').reduce((a, i) => a + i.total, 0);
        const lineCount = i => i.bookedLines || (w.combine ? 1 : (i.lines || []).length) || '';
        const chargeNames = i => [...new Set((i.lines || []).map(l => l.desc).filter(Boolean))];

        /* Every column filled whatever the transport: a road invoice has no
           container, a rail one no shipment id - so each row shows what it does
           have, and what was on the invoice for it. */
        const invoices = worklistInvoices(w);
        const many = invoices.length > 1;
        const rows = w.items.map(i => {
            const l = LABEL[i.status] || LABEL.pending;
            const facts = transportFacts(i);
            const names = chargeNames(i);
            const inv = itemInvoice(w, i);
            return `<tr>
                ${many ? `<td><b>${esc(inv.invoiceNo || '—')}</b>${inv.creditorName ? `<div class="fip-ledger">${esc(inv.creditorName)}</div>` : ''}</td>` : ''}
                <td><b>${esc(transportName(i) || '—')}</b>${facts.length ? `<div class="fip-ledger">${esc(facts.join(' · '))}</div>` : ''}</td>
                <td>${i.shipmentNo ? `<b>${esc(i.shipmentNo)}</b>` : '<span class="fip-ledger">—</span>'}</td>
                <td class="fip-reason">${names.length ? esc(names.slice(0, 3).join(', ')) + (names.length > 3 ? ` +${names.length - 3}` : '') : '—'}</td>
                <td class="num">${lineCount(i)}</td>
                <td class="num">${money(i.total)}</td>
                <td><span class="fip-badge is-${l.cls}">${l.text}</span></td>
                <td class="fip-reason">${esc(i.reason || (i.status === 'done' ? '' : '—'))}</td>
            </tr>`;
        }).join('');
        const head = many
            ? invoices.map(i => [i.invoiceNo || '?', i.creditorName].filter(Boolean).join(' — ')).join(' · ')
            : [w.creditor || w.creditorName, w.amount != null ? `factuurtotaal ${money(w.amount)}` : '']
                .filter(Boolean).join(' · ');

        const overlay = document.createElement('div');
        overlay.className = 'fip-ask fip-root';
        overlay.innerHTML = `
            <div class="fip-ask-box" style="max-width:880px;">
                <div class="fip-ask-title">Eindrapport — ${many ? `${invoices.length} facturen` : `factuur ${esc((invoices[0] && invoices[0].invoiceNo) || w.invoiceNo || '')}`}</div>
                ${head ? `<div class="fip-hint" style="margin:-4px 0 8px;">${esc(head)}</div>` : ''}
                <div class="fip-report-summary">
                    <span><b>${count('done')}</b> geboekt (${money(bookedSum)})</span>
                    <span><b>${count('duplicate')}</b> overgeslagen</span>
                    <span><b>${count('notfound') + count('failed')}</b> niet gelukt</span>
                    <span><b>${w.items.length}</b> totaal${many ? ` uit <b>${invoices.length}</b> facturen` : ''}</span>
                </div>
                <div class="fip-report-scroll">
                    <table class="fip-table">
                        <thead><tr>${many ? '<th>Factuur</th>' : ''}<th>Zending</th><th>Shipment</th><th>Kosten</th><th class="num">Regels</th><th class="num">Bedrag</th><th>Resultaat</th><th>Reden</th></tr></thead>
                        <tbody>${rows}</tbody>
                    </table>
                </div>
                <div class="fip-ask-actions">
                    <button type="button" class="fip-btn fip-btn-ghost" data-act="copy">Rapport kopiëren</button>
                    <button type="button" class="fip-btn fip-btn-primary" data-act="close">Sluiten</button>
                </div>
            </div>`;
        document.body.appendChild(overlay);

        const close = () => { if (overlay.parentNode) document.body.removeChild(overlay); };
        overlay.addEventListener('click', e => {
            const act = (e.target.closest('[data-act]') || {}).dataset;
            if (act && act.act === 'close') close();
            if (act && act.act === 'copy') {
                const unitOf = i => i.container ? 'Container' : i.unit && UNIT_KINDS[i.unit.kind] ? UNIT_KINDS[i.unit.kind].label : '';
                const tsv = [(many ? 'Factuur\tCrediteur\t' : '')
                        + 'Zending\tShipment\tEenheid\tSoort vervoer\tReferentie\tKosten\tRegels\tBedrag\tResultaat\tReden']
                    .concat(w.items.map(i => {
                        const inv = itemInvoice(w, i);
                        return (many ? [inv.invoiceNo, inv.creditorName] : []).concat([
                            transportName(i), i.shipmentNo || '', unitOf(i), MODALITY[modalityOf(i, i.modality)] || '',
                            i.ref || '', chargeNames(i).join(', '), lineCount(i),
                            i.total.toFixed(2).replace('.', ','),
                            (LABEL[i.status] || LABEL.pending).text, i.reason || '']).join('\t');
                    }))
                    .join('\n');
                navigator.clipboard.writeText(tsv).then(() => {
                    const b = overlay.querySelector('[data-act="copy"]');
                    b.textContent = 'Gekopieerd ✓';
                    setTimeout(() => { b.textContent = 'Rapport kopiëren'; }, 1600);
                }).catch(() => {});
            }
            if (e.target === overlay) close();
        });
    }

    /* Which invoice a line came from. Several invoices can be read in at once,
       and then each line carries its own number and creditor; a worklist saved
       by an older version has them only at the top, so that is the fallback. */
    function itemInvoice(w, item) {
        const own = item || {};
        const has = key => own[key] !== undefined && own[key] !== null;
        return {
            invoiceNo:    String((has('invoiceNo')    ? own.invoiceNo    : w.invoiceNo) || '').trim(),
            creditorSeq:  String((has('creditorSeq')  ? own.creditorSeq  : w.creditorSeq) || '').trim(),
            creditorName: String((has('creditorName') ? own.creditorName : (w.creditorName || w.creditor)) || '').trim()
        };
    }

    /* The distinct invoices in a worklist, in the order they were read in.
       `w.docs` holds what was read per document — the totals and whether they
       added up — and is the source when it is there; a worklist from before
       9.20 has only the lines, so the invoices are derived from those. */
    const invoiceKey = (w, item) => item.docId || itemInvoice(w, item).invoiceNo || '';

    function worklistInvoices(w) {
        const used = new Set((w.items || []).map(i => invoiceKey(w, i)));
        if (Array.isArray(w.docs) && w.docs.length) {
            const known = w.docs.filter(d => used.has(d.docId || d.invoiceNo || ''));
            if (known.length) return known.map(d => Object.assign({}, d));
        }
        const seen = new Map();
        (w.items || []).forEach(item => {
            const key = invoiceKey(w, item);
            if (!seen.has(key)) {
                seen.set(key, Object.assign({
                    docId: item.docId || '', docName: item.docName || w.fileName || ''
                }, itemInvoice(w, item)));
            }
        });
        return [...seen.values()];
    }

    /* Is this container's cost already on the shipment? The description we write
       carries the invoice number and the container, so finding both in the costs
       list means it has been booked before. With descriptions set to "alleen
       kostensoort" there is nothing unique to match on, and we say so. */
    function alreadyBooked(item, w) {
        const text = (document.body && document.body.innerText) || '';
        if (w.descMode === 'name') return { dup: false, blind: true };
        const invoice = itemInvoice(w, item).invoiceNo;
        // Found by shipment id or reference: the page IS that shipment, so only
        // the invoice number decides.
        const unitValue = item.container || (item.unit && item.unit.value);
        const hasContainer = unitValue ? text.includes(unitValue) : true;
        const hasInvoice = invoice ? text.includes(invoice) : false;
        if (invoice) return { dup: hasContainer && hasInvoice, blind: false };
        return { dup: false, blind: true };
    }

    /* Are these costs already on the shipment? Asked on the shipment page,
       before Create, against the rows of its Costs region. The invoice number
       in a row settles it. Without one - costs typed in by hand, description
       left empty - the amounts give it away: the invoice total on one row, or
       every charge of the invoice already there. A lone amount only counts on a
       row of the same creditor; one figure by itself is too common to go on.
       Returns the reason to skip, or ''. */
    const moneyIn = text => [...String(text).matchAll(/-?\d[\d.,]*[.,]\d{2}(?!\d)/g)]
        .map(m => round2(parseAmount(m[0]))).filter(v => !isNaN(v) && v !== 0);
    const creditorKey = s => normalise(s).replace(/[^a-z0-9]+/g, ' ').trim();

    function matchExistingCosts(rowTexts, item, w) {
        const rows = rowTexts.map(text => ({ text: String(text).replace(/\s+/g, ' ').trim(), amounts: moneyIn(text) }))
            .filter(r => r.amounts.length);
        if (!rows.length) return '';
        const quote = r => `"${r.text.slice(0, 90)}"`;

        const ctx = itemInvoice(w, item);
        const invoice = ctx.invoiceNo;
        if (invoice.length >= 4) {
            const hit = rows.find(r => r.text.includes(invoice));
            if (hit) return `Factuur ${invoice} staat al op deze zending: ${quote(hit)}`;
        }

        const lines = (item.lines || []).filter(l => l.amount);
        const total = round2(item.total || 0);
        const creditor = creditorKey(ctx.creditorName);
        const fromCreditor = r => !!creditor && creditorKey(r.text).includes(creditor);
        const has = (r, v) => r.amounts.some(a => Math.abs(a - v) < 0.005);
        const several = lines.length >= 2;

        const asOne = total ? rows.find(r => has(r, total) && (several || fromCreditor(r))) : null;
        if (asOne) return `Mogelijk al geboekt: er staat al een kostenregel van ${money(total)} op deze zending — ${quote(asOne)}`;

        if (lines.length && lines.every(l => rows.some(r => has(r, l.amount) && (several || fromCreditor(r))))) {
            return `Mogelijk al geboekt: ${several ? `alle ${lines.length} bedragen` : `het bedrag ${money(lines[0].amount)}`} van deze factuur staan al op deze zending`;
        }
        return '';
    }

    /* The rows of the Costs region on a shipment or Financials page, as text. */
    function costRegionRows() {
        const texts = [];
        document.querySelectorAll('.t-Region').forEach(region => {
            const title = region.querySelector('.t-Region-title');
            if (!title || !/^(costs?|kosten)\b/i.test((title.textContent || '').trim())) return;
            region.querySelectorAll('tbody tr').forEach(tr => texts.push(tr.innerText || tr.textContent || ''));
        });
        return texts;
    }

    function skipWorklistItem(w, item, reason, who) {
        item.status = 'duplicate';
        item.reason = reason;
        w.index++; w.attempts = 0; w.awaitSearch = true;
        saveWorklist(w);
        setSubStatus(`${who} · al geboekt, overgeslagen`);
        setTimeout(() => { if (w.searchUrl) location.href = w.searchUrl; else runWorklist(); }, 800);
    }

    async function runWorklist() {
        const w = loadWorklist();
        if (!w || !w.running) return;
        if (localStorage.getItem('fiton_automation_queue')) return;   // a booking run is busy

        // Waiting to return to the search page before touching the next container.
        if (w.awaitSearch) {
            if (!onSearchPage()) { setSubStatus('terug naar zoekpagina…'); return; }
            w.awaitSearch = false;
            saveWorklist(w);
        }

        const item = w.items[w.index];
        if (!item) {
            const booked = w.items.filter(i => i.status === 'done').length;
            const clean = booked === w.items.length;
            clearWorklist();
            setStatus(`Klaar — ${booked}/${w.items.length} zendingen geboekt`, clean ? 'done' : 'error', 100);
            setSubStatus('');
            const invoices = worklistInvoices(w);
            panelMessage(invoices.length > 1
                ? `${invoices.length} facturen: ${booked} van de ${w.items.length} zendingen geboekt.`
                : `Factuur ${invoices[0] ? invoices[0].invoiceNo : (w.invoiceNo || '')}: ${booked} van de ${w.items.length} zendingen geboekt.`,
                clean ? 'ok' : 'error');
            try { localStorage.setItem(REPORT_KEY, JSON.stringify({ at: Date.now(), worklist: w })); } catch (e) {}
            reportWorklist(w, booked, clean);
            showWorklistReport(w);
            refreshReportButton();
            return;
        }

        const pct = (w.index / w.items.length) * 100;
        setStatus(`Container ${w.index + 1} van ${w.items.length}`, 'running', pct);
        setSubStatus(`${transportName(item) || '?'} · ${money(item.total)}`);

        /* STEP 1 - Search: look the shipment up. Forwarding > Search is used on
           the container number or the B/L, so those come first; the rest is what
           is left to try when an invoice names neither - a trucker invoice often
           carries only the dossier number. */
        const searchBy = item.container ? 'container'
                       : item.unit && item.unit.kind === 'bl' ? 'unit'
                       : isShipmentId(item.ref) ? 'shipment'
                       : item.ref ? 'ref'
                       : item.unit ? 'unit' : null;       // waybill, trailer, wagon...
        const searchValue = searchBy === 'container' ? item.container
                          : searchBy === 'unit' ? item.unit.value : item.ref;
        const who = transportName(item) || '?';
        if (!searchBy) {
            item.status = 'notfound';
            item.reason = 'Geen container, eenheid of referentie op deze regel';
            w.index++; saveWorklist(w);
            setTimeout(runWorklist, 300);
            return;
        }

        if (onSearchPage()) {
            const hit = findShipmentLink(searchValue);
            if (hit && hit.link) {
                log(`Opening shipment for ${who}`);
                setSubStatus(`${who} · zending openen…`);
                if (hit.seq) { item.bookingSeq = hit.seq; saveWorklist(w); }
                hit.link.click();
                return;
            }

            const fields = {
                container: document.getElementById(SEARCH_MAP.containerField),
                ref: document.getElementById(SEARCH_MAP.bookingField),
                shipment: shipmentIdField(),
                unit: item.unit ? unitSearchField(item.unit.kind) : null
            };
            const field = fields[searchBy];
            if (!field) {
                if (searchBy !== 'shipment' && searchBy !== 'unit') return;
                item.status = 'notfound';
                item.reason = searchBy === 'unit'
                    ? `Geen zoekveld voor ${UNIT_KINDS[item.unit.kind].label} op de zoekpagina — zoek ${item.unit.value} handmatig`
                    : 'Zoekveld "Shipment id" niet gevonden op de zoekpagina';
                w.index++; saveWorklist(w);
                setTimeout(runWorklist, 300);
                return;
            }

            const typed = (field.value || '').toUpperCase();
            const wanted = String(searchValue).toUpperCase();

            if (typed !== wanted) {
                setSubStatus(`${wanted} opzoeken…`);
                // only one criterion at a time, or the search narrows to nothing
                Object.entries(fields).forEach(([kind, other]) => {
                    if (kind !== searchBy && other && other !== field && other.value) setNativeValue(other, '');
                });
                setNativeValue(field, searchValue);
                w.attempts = 0;
                w.searchedAt = Date.now();
                saveWorklist(w);
                const btn = document.getElementById(SEARCH_MAP.searchBtn) || findButtonByText(/^search$/i);
                if (btn) btn.click();
                return;
            }

            // The container is in the box. Wait for the grid rather than counting
            // ticks - it loads after the page and takes a moment.
            const elapsed = Date.now() - (w.searchedAt || 0);
            const pageText = (document.body && document.body.innerText) || '';
            const noData = /no data found|geen gegevens gevonden/i.test(pageText);
            const seconds = Math.max(0, Math.round((SEARCH_WAIT_MS - elapsed) / 1000));

            if (!noData && elapsed < SEARCH_WAIT_MS) {
                setSubStatus(`${wanted} · wachten op resultaat (${seconds}s)`);
                // One extra press halfway, in case the first click was swallowed
                // while the page was still settling.
                if (elapsed > SEARCH_RETRY_MS && !(w.attempts > 0)) {
                    w.attempts = 1;
                    w.searchedAt = Date.now() - SEARCH_RETRY_MS;
                    saveWorklist(w);
                    const btn = document.getElementById(SEARCH_MAP.searchBtn) || findButtonByText(/^search$/i);
                    if (btn) { log(`Re-running search for ${who}`); btn.click(); }
                }
                return;
            }
            if (noData && elapsed < NODATA_WAIT_MS) {
                setSubStatus(`${who} · resultaat controleren…`);
                return;
            }

            log(`No shipment found for ${who} after ${Math.round(elapsed / 1000)}s - skipping`);
            item.status = 'notfound';
            item.reason = noData
                ? `FitOn meldt "no data found" voor ${searchBy === 'container' ? 'dit containernummer'
                    : searchBy === 'shipment' ? 'dit shipment id'
                    : searchBy === 'unit' ? `${UNIT_KINDS[item.unit.kind].label} ${item.unit.value}` : 'deze referentie'}`
                : `Geen zoekresultaat binnen ${Math.round(SEARCH_WAIT_MS / 1000)} seconden`;
            w.index++; w.attempts = 0; w.searchedAt = 0;
            saveWorklist(w);
            setNativeValue(field, '');
            setTimeout(runWorklist, 500);
            return;
        }

        /* STEP 2 - Shipment: press Create in the Costs region. A road shipment
           has no Costs region on its own page, so open Financials first. */
        if (onShipmentPage()) {
            if (!item.shipmentNo) {
                const no = shipmentNoOnPage();
                if (no) { item.shipmentNo = no; saveWorklist(w); log(`${who} is shipment ${no}`); }
            }
            // Before anything is created: are these costs on the shipment already?
            if (!w.ignoreExisting && findRegionCreateButton('cost')) {
                if (document.readyState !== 'complete') return;          // let the Costs rows render
                const existing = matchExistingCosts(costRegionRows(), item, w);
                if (existing) {
                    log(`${who}: ${existing} - skipping`);
                    skipWorklistItem(w, item, existing, who);
                    return;
                }
            }
            const createCost = findRegionCreateButton('cost');
            if (createCost) {
                setSubStatus(`${who} · kostenregel openen…`);
                createCost.click();
                return;
            }
            const financials = findFinancialsButton();
            if (financials) {
                if (!item.modality) { item.modality = 'road'; saveWorklist(w); }   // a road shipment page
                log(`Opening Financials for ${who}`);
                setSubStatus(`${who} · financials openen…`);
                financials.click();
                return;
            }
            panelMessage('De knop "Create" in het blok Kosten is niet gevonden. Open de kostenregel handmatig; daarna gaat het vanzelf verder.', 'info');
            return;
        }

        /* STEP 3 - Cost form: book this container's lines. */
        if (MODE === 'cost' && el('ledger')) {
            // Never book the same specification onto the same shipment twice.
            const ctx = itemInvoice(w, item);
            const dup = alreadyBooked(item, w);
            if (dup.dup && !w.ignoreExisting) {
                log(`${who} already carries invoice ${ctx.invoiceNo} - skipping`);
                skipWorklistItem(w, item, `Factuur ${ctx.invoiceNo} staat al op deze zending`, who);
                return;
            }
            if (dup.blind) item.reason = 'Dubbelcontrole niet mogelijk (omschrijving zonder factuurnummer)';

            const items = buildSpecItems(item, {
                invoiceNo: ctx.invoiceNo, creditorSeq: ctx.creditorSeq, creditorName: ctx.creditorName,
                descMode: w.descMode, combine: w.combine
            });
            setSubStatus(`${who} · ${items.length} regels boeken…`);
            item.status = 'booking';
            item.bookedLines = items.length;
            if (!item.modality && mapKey('cost') === 'costRoad') item.modality = 'road';
            const worklistIndex = w.index;
            w.index++; w.attempts = 0;
            saveWorklist(w);
            localStorage.setItem('fiton_automation_queue', JSON.stringify({
                running: true, client: '', mode: 'cost', shipmentKey: shipmentKey(),
                fromWorklist: true, worklistIndex, container: item.container,
                currentIndex: 0, waitingForCreateNext: false, createNextRetries: 0,
                createRetries: 0, saveRetries: 0, rowsBefore: null, rowsAtStart: null,
                items
            }));
            processQueue();
        }
    }

    /* When a worklist booking finishes, mark that container done and move on. */
    function worklistLineFinished(state, ok) {
        const w = loadWorklist();
        if (!w || !state.fromWorklist) return false;
        // By position: a road shipment has no container, so matching on it would
        // mark the first ref-only line every time.
        const done = Number.isInteger(state.worklistIndex) ? w.items[state.worklistIndex]
                   : w.items.find(i => i.container === state.container);
        if (done) {
            done.status = ok ? 'done' : 'failed';
            if (!ok) done.reason = state.failReason || 'Boeken afgebroken — controleer de zending';
        }
        // Block any further booking until we are back on the search page, or the
        // next container's lines would land on the shipment still open here.
        w.awaitSearch = true;
        saveWorklist(w);
        // Back to the search page for the next container.
        setTimeout(() => {
            if (w.index < w.items.length && w.searchUrl) {
                setSubStatus('terug naar zoekpagina…');
                location.href = w.searchUrl;
            } else if (w.searchUrl) {
                location.href = w.searchUrl;   // final summary is shown there
            } else {
                runWorklist();
            }
        }, 1000);
        return true;
    }

    /* =========================================================================
       IN-PAGE DIALOGS
       -------------------------------------------------------------------------
       The browser's own confirm()/alert() freeze the page, look nothing like the
       rest of the tool, and cannot be styled or dismissed with Escape in a
       predictable way. Everything the extension asks now goes through these.
       Own class name so the "is a modal already open?" guards do not trip on it.
       ========================================================================= */
    function fipAsk(opts) {
        return new Promise(resolve => {
            const o = Object.assign({
                title: '', message: '', okLabel: 'Ja', cancelLabel: 'Nee',
                tone: 'default', showCancel: true
            }, opts || {});

            const overlay = document.createElement('div');
            overlay.className = 'fip-ask fip-root';
            overlay.innerHTML = `
                <div class="fip-ask-box" role="alertdialog" aria-modal="true">
                    ${o.title ? `<div class="fip-ask-title">${esc(o.title)}</div>` : ''}
                    <div class="fip-ask-msg">${String(o.message).split('\n').map(line => esc(line)).join('<br>')}</div>
                    <div class="fip-ask-actions">
                        ${o.showCancel ? `<button type="button" class="fip-btn fip-btn-ghost" data-answer="no">${esc(o.cancelLabel)}</button>` : ''}
                        <button type="button" class="fip-btn ${o.tone === 'danger' ? 'fip-btn-danger-solid' : 'fip-btn-primary'}" data-answer="yes">${esc(o.okLabel)}</button>
                    </div>
                </div>`;
            document.body.appendChild(overlay);

            const done = answer => {
                document.removeEventListener('keydown', onKey, true);
                if (overlay.parentNode) document.body.removeChild(overlay);
                resolve(answer);
            };
            function onKey(e) {
                if (e.key === 'Escape') { e.stopPropagation(); done(false); }
                if (e.key === 'Enter') { e.stopPropagation(); done(true); }
            }
            document.addEventListener('keydown', onKey, true);
            overlay.addEventListener('click', e => {
                const btn = e.target.closest('[data-answer]');
                if (btn) done(btn.getAttribute('data-answer') === 'yes');
                else if (e.target === overlay) done(false);
            });

            const okBtn = overlay.querySelector('[data-answer="yes"]');
            if (okBtn) okBtn.focus();
        });
    }

    function fipTell(message, title) {
        return fipAsk({ title: title || '', message, okLabel: 'Oké', showCancel: false });
    }

    /* =========================================================================
       CREDITORS
       -------------------------------------------------------------------------
       The ones that actually send invoices we book. The full list lives in FitOn
       and can be pasted in via Instellingen > Crediteuren importeren, which
       overrides and extends this set - so a new creditor never needs a new
       version of the extension.
       ========================================================================= */
    const BUILTIN_CREDITORS = [
        // carriers
        { seq: '66205', code: 'HAPAROT', name: 'Hapag-Lloyd Rotterdam' },
        { seq: '66208', code: 'MEDIROT', name: 'Mediterranean Shipping Company (Nederland) BV' },
        { seq: '66204', code: 'MAERCOP', name: 'Maersk A/S' },
        { seq: '66203', code: 'CMACRHO', name: 'CMA CGM Holland BV' },
        { seq: '66471', code: 'OOCLROT', name: 'OOCL Netherlands' },
        { seq: '71415', code: 'OOCLANT', name: 'OOCL Benelux NV' },
        { seq: '66548', code: 'YANGROT', name: 'Yang Ming (Netherlands) BV' },
        { seq: '66547', code: 'EVERROT', name: 'Evergreen Line Netherlands Branch' },
        { seq: '66378', code: 'ONEOROT', name: 'ONE Ocean Network Express Netherlands BV' },
        { seq: '66210', code: 'COSCROT', name: 'Cosco Shipping Lines (Netherlands)' },
        { seq: '66549', code: 'ZIMIROT', name: 'ZIM Integrated Shipping Services' },
        { seq: '68454', code: 'HMMSROT', name: 'HMM Shipping BV' },
        { seq: '70345', code: 'KLINANT', name: 'K Line Belgium NV' },
        { seq: '69696', code: 'GRIMROT', name: 'Grimaldi Netherlands BV' },
        { seq: '69693', code: 'ATLAGOT', name: 'Atlantic Container Line AB' },
        { seq: '69675', code: 'WECLROT', name: 'W.E.C. Lines BV' },
        { seq: '69703', code: 'SEATRHO', name: 'Seatrade Rotterdam B.V.' },
        { seq: '70605', code: 'BGFRPOO', name: 'B.G. Freight Line B.V.' },
        { seq: '81990', code: 'SAMSWAA', name: 'Samskip Multimodal B.V.' },
        { seq: '69697', code: 'MACSROT', name: 'MACS Benelux BV' },
        { seq: '71650', code: 'NIRIBAR', name: 'Nirint Shipping B.V.' },
        { seq: '70302', code: 'GEESRHO', name: 'Geest Line Benelux' },

        // coldstores, terminals and handling
        { seq: '71587', code: 'LINEMAA', name: 'Lineage Rotterdam Maasvlakte B.V.' },
        { seq: '69737', code: 'AMERROT', name: 'Americold Maasvlakte B.V.' },
        { seq: '70396', code: 'THERMROT', name: 'Thermotraffic Holland B.V.' },
        { seq: '74230', code: 'RHENMAA', name: 'Rhenus Logistics B.V.' },
        { seq: '69637', code: 'RHENROT', name: 'Rhenus Air & Ocean B.V.' },
        { seq: '69670', code: 'TMATAMS', name: 'TMA Terminals BV' },
        { seq: '70291', code: 'STEIROT', name: 'Steinweg Handelsveem BV' },
        { seq: '70285', code: 'KATOANT', name: 'Katoen Natie Terminals NV' },
        { seq: '83642', code: 'AETNVER', name: 'Antwerp Euroterminal N.V.' },
        { seq: '70368', code: 'MARKBER', name: 'H Essers Container Terminal B.V.' },
        { seq: '83462', code: 'VRIESHE', name: 'Vrieskade bv' },
        { seq: '83637', code: 'NEDCKER', name: 'Nedcool Kerkdriel' },
        { seq: '64142', code: 'MTCWROT', name: 'MTC Warehousing B.V' },

        // authorities and inspection
        { seq: '70374', code: 'NEDEUTR', name: 'Nederlandse Voedsel- en Warenautoriteit' },
        { seq: '70310', code: 'KWALZOE', name: 'Kwaliteits-Controle-Bureau (KCB)' },
        { seq: '66202', code: 'BELAAPE', name: 'Belastingdienst - Douane' },
        { seq: '72138', code: 'GASMROT', name: 'Gasmeetstation Nederland B.V.' },
        { seq: '71147', code: 'FUMIENS', name: 'Fumico Bio & QPS Services BV' },
        { seq: '83643', code: 'VIVOZOE', name: 'Vereniging van Importeurs van Visproducten' },

        // trucking
        { seq: '76076', code: 'LEMMMAA', name: 'Lemm Int. Transport BV' },
        { seq: '70517', code: 'MONSBAR', name: 'Monsma Bevrachtingen B.V.', email: 'vragen@monsma.nl' },
        { seq: '71188', code: 'BASARHO', name: 'Basamro Transport B.V.' },
        { seq: '69583', code: 'BRAAALB', name: 'Braanker Transport BV' },
        { seq: '71165', code: 'KOTRYER', name: 'Kotra Urk B.V.' },
        { seq: '66184', code: 'FARMZEV', name: 'Farm Trans Fresh & Frozen B.V.' },
        { seq: '66768', code: 'DFDSNIJ', name: 'DFDS Logistics Nijmegen BV' }
    ];

    let CREDITORS = BUILTIN_CREDITORS.slice();

    function loadCreditors() {
        return new Promise(resolve => {
            if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return resolve();
            chrome.storage.local.get(['creditors'], d => {
                if (d && Array.isArray(d.creditors) && d.creditors.length) {
                    // imported list wins, built-ins fill any gap
                    const bySeq = {};
                    BUILTIN_CREDITORS.forEach(c => { bySeq[c.seq] = c; });
                    d.creditors.forEach(c => { if (c && c.seq) bySeq[c.seq] = c; });
                    CREDITORS = Object.values(bySeq);
                    log(`Creditors loaded: ${CREDITORS.length}`);
                }
                resolve();
            });
        });
    }

    const normalise = t => String(t || '').toLowerCase()
        .replace(/[.,''`]/g, '').replace(/\b(b\.?v|n\.?v|gmbh|ltd|limited|inc|s\.?a|a\/s|as|sa|srl|pte|plc)\b/g, '')
        .replace(/\s+/g, ' ').trim();

    /* Every invoice we receive carries our own name and VAT number as the
       addressee, and the FitOn list contains our own companies. Matched against
       that, every invoice was "from" Cory Brothers. So our own entries never
       take part in recognising the sender; pick them by hand for the rare
       intercompany invoice. */
    const OWN_IDS = ['NL005173097B01'];
    const isOwnCompany = c => /^cory brothers\b/i.test(String(c.name || '').trim())
        || ['vat', 'iban'].some(k => OWN_IDS.includes(String(c[k] || '').replace(/[\s.]/g, '').toUpperCase()));

    /* The FitOn export often has a city or the company name in the VAT column
       ("BARENDRECHT", "CMA CGM HOLLAND BV"). Those are on half the invoices in
       the country, so only a value shaped like a VAT number or an IBAN - a
       country code followed mostly by digits - counts as an identifier. */
    const looksLikeTaxOrBankId = v => /^[A-Z]{2}[0-9A-Z]{8,32}$/.test(v) && (v.match(/\d/g) || []).length >= 8;

    /* A shared mailbox provider says nothing about who sent the invoice. */
    const GENERIC_MAIL = /^(gmail|googlemail|hotmail|outlook|live|yahoo|icloud|msn|ziggo|kpnmail|planet|home|mailtobasecone)\./i;
    const mailDomains = mail => String(mail || '').split(/[;,\s]+/)
        .map(m => (m.split('@')[1] || '').trim().toLowerCase())
        .filter(d => d.length > 4 && d.includes('.') && !GENERIC_MAIL.test(d));

    /* Who sent this invoice? Longest creditor name that appears in the text wins,
       so "Rhenus Logistics" beats a stray mention of "Rhenus". */
    function detectCreditor(text) {
        const raw = String(text || '');

        /* The creditor's own master data identifies the sender far better than
           any pattern I could write: a VAT number, an IBAN or an e-mail domain
           on the invoice matches exactly one creditor. Import the full list from
           FitOn (Instellingen) and this works for every supplier, including ones
           whose name only appears in a logo. */
        const flat = raw.replace(/[\s.]/g, '').toUpperCase();
        const candidates = CREDITORS.filter(c => !isOwnCompany(c));
        for (const c of candidates) {
            for (const key of ['vat', 'iban', 'bank']) {
                const v = (c[key] || '').replace(/[\s.]/g, '').toUpperCase();
                if (looksLikeTaxOrBankId(v) && flat.includes(v)) return c;
            }
            for (const domain of mailDomains(c.email)) {
                if (raw.toLowerCase().includes(domain)) return c;
            }
        }

        const hay = normalise(raw);

        /* Where a name stands counts as much as how long it is. The sender is in
           the letterhead or the footer, next to its KvK, VAT number and IBAN.
           Other companies turn up in the activity lines as the place goods were
           collected or delivered - "03-8-2026 Lossen BOTLEK - MTC Warehousing
           B.V." - and a longer name there must never beat the sender's own
           ("MTC Transport B.V."). */
        const lines = raw.split(/\r?\n/);
        const normLines = lines.map(normalise);
        const DATED = /^\s*\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}\b/;
        const bodyStart = (i => (i < 0 ? lines.length : i))(lines.findIndex(l =>
            (DATED.test(l) && /[A-Za-z]{3}/.test(l)) || /^\s*(omschrijving|description|beschreibung|d[ée]signation|specificatie)\b/i.test(l)));
        const SENDER_IDS = /\b(kvk|k\.v\.k|btw|vat|iban|bic|swift|tel|telefoon|phone|e-?mail|www|handelsregister|chamber of commerce|ust-?id)\b/i;
        const placeBonus = needle => {
            let bonus = 0;
            normLines.forEach((l, i) => {
                if (!l.includes(needle)) return;
                let b = 0;
                if (i < bodyStart) b += 40;
                if (lines.slice(Math.max(0, i - 1), i + 7).some(x => SENDER_IDS.test(x))) b += 60;
                if (DATED.test(lines[i])) b -= 40;
                bonus = Math.max(bonus, b);
            });
            return bonus;
        };

        let best = null, bestScore = 0;
        for (const c of candidates) {
            const needle = normalise(c.name);
            if (needle.length < 5) continue;

            let score = 0;
            if (hay.includes(needle)) {
                score = needle.length * 2 + placeBonus(needle);   // full name present
            } else {
                // Or every distinctive word of the name, in any order:
                // "LEMM Internationaal Transport BV" still matches "Lemm Int. Transport BV".
                const words = needle.split(' ').filter(w => w.length >= 4);
                const asWord = w => new RegExp(`(^|[^a-z0-9])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`, 'i').test(hay);
                // Whole words only. Substring matching turns "Tetracyclines" into
                // a hit for "W.E.C. Lines".
                if (words.length >= 2 && words.every(asWord)) score = words.join('').length;
            }
            if (score > bestScore) { best = c; bestScore = score; }
        }
        if (best) return best;

        for (const c of candidates) {
            if (c.code && new RegExp(`\\b${c.code}\\b`, 'i').test(raw)) return c;
        }
        return null;
    }


    /* =========================================================================
       CREDITORS FROM FITON
       -------------------------------------------------------------------------
       The creditor field on a cost line (Operations > Import > FCL > Shipment >
       Cost) opens a popup with every creditor, 20 at a time behind "Show More".
       "Crediteuren verversen" opens that popup, presses Show More until nothing
       is left, reads each row by its column heading and stores the lot. It
       only ever clicks the popup button, Show More and the close button - never
       a row, so the cost line itself is not touched.
       ========================================================================= */
    const shown = e => !!(e && (e.offsetWidth || e.offsetHeight || e.getClientRects().length));
    // Through F(), so a road cost line (P3708) finds its own creditor field.
    const creditorFieldId = () => {
        const previous = MODE;
        MODE = 'cost';
        const id = F().creditor;
        MODE = previous;
        return id || 'P673_CREDITOR_RELATION_SEQ';
    };

    function creditorPopup() {
        const all = [...document.querySelectorAll('.ui-dialog, .a-PopupLOV-dialog')]
            .filter(d => shown(d) && d.querySelector('table'));
        return all[all.length - 1] || null;
    }
    /* Each creditor row carries its seq as data-id (the same thing the manual
       console script read). Fall back to any body row if that ever changes. */
    const popupRows = dlg => {
        const withId = [...dlg.querySelectorAll('tr[data-id]')].filter(tr => tr.querySelector('td'));
        return withId.length ? withId : [...dlg.querySelectorAll('tbody tr')].filter(tr => tr.querySelector('td') && !tr.querySelector('th'));
    };
    const popupShowMore = dlg => {
        const btn = dlg.querySelector('.a-GV-loadMoreButton, .a-GV-loadMore button');
        return btn && shown(btn) && !btn.disabled ? btn : null;
    };
    const isSelectorCell = c => /selHeader|rowSelector|a-GV-selector/.test(c.className || '');

    /* Column heading -> field. First match wins, so "Search name" is a code
       and "Relation seq" is the id before "name" gets a chance at either. */
    const CREDITOR_COLUMNS = [
        ['seq',     /^(seq|id|relation\s*seq|relatie\s*seq|relation\s*id|nr\.?|number|nummer)$/i],
        ['code',    /code|zoeknaam|search\s*name|short\s*name|afkorting/i],
        ['email',   /mail/i],
        ['iban',    /iban/i],
        ['bank',    /bank|account|rekening/i],
        ['vat',     /\bvat\b|btw|tax/i],
        ['country', /country|land/i],
        ['city',    /city|plaats|place|town|stad/i],
        ['name',    /name|naam|relation|relatie|creditor|crediteur|company|bedrijf|omschrijving/i]
    ];

    function mapCreditorColumns(headers) {
        const map = {}, used = new Set();
        headers.forEach((h, i) => {
            const hit = CREDITOR_COLUMNS.find(([key, re]) => !used.has(key) && re.test(h));
            if (hit) { map[hit[0]] = i; used.add(hit[0]); }
        });
        return map;
    }

    const cellText = c => (c.innerText || c.textContent || '').replace(/\s+/g, ' ').trim().replace(/^-$/, '');
    const dataCells = tr => [...tr.children].filter(c => c.tagName === 'TD' && !isSelectorCell(c));

    /* The APEX grid draws its heading twice - a visible header table and a
       hidden copy that sizes the columns - so the dialog holds 20 headings for
       10 columns. Take one heading row, the one as wide as a data row. */
    function popupHeaders(dlg, width) {
        const byRow = new Map();
        [...dlg.querySelectorAll('th')].filter(th => !isSelectorCell(th)).forEach(th => {
            const key = th.parentElement || 'all';
            if (!byRow.has(key)) byRow.set(key, []);
            byRow.get(key).push(cellText(th));
        });
        const groups = [...byRow.values()];
        const exact = groups.find(g => g.length === width);
        if (exact) return exact;
        const flat = groups.flat();
        return width && flat.length % width === 0 ? flat.slice(0, width) : flat;
    }

    function readCreditorPopup(dlg) {
        const rows = popupRows(dlg);
        const width = rows.length ? dataCells(rows[0]).length : 0;
        const headers = popupHeaders(dlg, width);
        const map = mapCreditorColumns(headers);
        const sample = rows.slice(0, 3).map(tr => ({
            attrs: ['data-return', 'data-value', 'data-id'].map(a => `${a}=${tr.getAttribute(a) || ''}`).join(' '),
            cells: dataCells(tr).map(cellText)
        }));

        const list = [];
        let misaligned = 0;
        rows.forEach(tr => {
            const cells = dataCells(tr).map(cellText);
            if (headers.length && cells.length !== headers.length) { misaligned++; return; }
            const get = key => (map[key] !== undefined ? cells[map[key]] || '' : '');
            /* The popup returns the creditor seq when a row is picked; the grid
               keeps it on the row. A visible seq column wins if there is one. */
            const seq = [get('seq'), tr.getAttribute('data-return'), tr.getAttribute('data-value'), tr.getAttribute('data-id')]
                .map(v => String(v || '').trim()).find(v => /^\d{3,}$/.test(v));
            const name = get('name') || cells.find(c => /[A-Za-z]{3}/.test(c)) || '';
            if (!seq || !name) return;
            list.push({ seq, code: get('code'), name, city: get('city'), country: get('country'),
                        vat: get('vat'), iban: get('iban'), bank: get('bank'), email: get('email') });
        });
        return { headers, map, list, misaligned, sample };
    }

    /* A seq read from the wrong attribute would be a row number, and booking on
       it would put the cost on some random creditor. The built-in creditors
       have known seqs, so those must come back unchanged before anything is
       stored. */
    function checkCreditorSeqs(list) {
        let ok = 0; const bad = [];
        BUILTIN_CREDITORS.forEach(b => {
            const same = list.filter(c => (c.code && c.code.toUpperCase() === b.code) || normalise(c.name) === normalise(b.name));
            if (!same.length) return;
            if (same.some(c => c.seq === b.seq)) ok++;
            else bad.push(`${b.name}: gelezen ${same[0].seq}, verwacht ${b.seq}`);
        });
        return { ok, bad };
    }

    async function saveCreditorList(fresh, extraMeta) {
        const stored = await new Promise(res => chrome.storage.local.get(['creditors'], d =>
            res(d && Array.isArray(d.creditors) ? d.creditors : [])));
        const bySeq = {};
        stored.forEach(c => { if (c && c.seq) bySeq[c.seq] = c; });
        let added = 0, updated = 0;
        fresh.forEach(c => {
            const old = bySeq[c.seq];
            // an empty cell never wipes what an earlier import already knew
            const clean = {};
            Object.entries(c).forEach(([k, v]) => { if (v !== '' && v != null) clean[k] = v; });
            if (!old) added++;
            else if (Object.keys(clean).some(k => String(old[k] || '') !== String(clean[k]))) updated++;
            bySeq[c.seq] = Object.assign({}, old || {}, clean);
        });
        const list = Object.values(bySeq);
        const meta = Object.assign({ at: Date.now(), read: fresh.length, added, updated, total: list.length }, extraMeta || {});
        await new Promise(res => chrome.storage.local.set({ creditors: list, creditorsMeta: meta }, res));

        const merged = {};
        BUILTIN_CREDITORS.forEach(c => { merged[c.seq] = c; });
        list.forEach(c => { merged[c.seq] = c; });
        CREDITORS = Object.values(merged);
        return meta;
    }

    const width0 = read => (read.sample[0] ? read.sample[0].cells.length : 0);

    async function refreshCreditorsFromFitOn(onProgress) {
        const progress = onProgress || (() => {});
        const input = document.getElementById(creditorFieldId());
        if (!input) throw new Error('Geen crediteurveld op deze pagina. Open een kostenregel (Shipment > Cost) en probeer het daar.');
        const before = input.value;

        if (creditorPopup()) throw new Error('Er staat al een venster open. Sluit dat eerst.');
        const opener = document.getElementById(input.id + '_lov_btn')
            || (input.parentElement && input.parentElement.querySelector('button'))
            || input;
        progress('crediteurvenster openen…');
        opener.click();

        let dlg = null;
        const opened = await waitFor(() => { dlg = creditorPopup(); return dlg && popupRows(dlg).length; }, 10000, 200);
        if (!opened) throw new Error('Het crediteurvenster ging niet open of bleef leeg.');

        let partial = false;
        for (let round = 0; round < 400; round++) {
            const more = popupShowMore(dlg);
            if (!more) break;
            const count = popupRows(dlg).length;
            progress(`${count} crediteuren geladen…`);
            more.click();
            const grew = await waitFor(() => popupRows(dlg).length > count || !popupShowMore(dlg), 15000, 250);
            if (!grew) { partial = true; break; }
            await sleep(150);          // let the button settle before looking again
        }
        if (popupShowMore(dlg)) partial = true;

        progress('crediteuren uitlezen…');
        const read = readCreditorPopup(dlg);

        const closeBtn = (dlg.closest('.ui-dialog') || dlg).querySelector('.ui-dialog-titlebar-close');
        if (closeBtn) closeBtn.click();
        else dlg.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, which: 27, bubbles: true }));
        await waitFor(() => !creditorPopup(), 3000, 100);
        if (input.value !== before) log('WARNING: creditor field changed while reading the list', { before, after: input.value });

        const check = checkCreditorSeqs(read.list);
        const result = { headers: read.headers, map: read.map, rows: read.list.length, misaligned: read.misaligned,
                         sample: read.sample, check, partial, changedField: input.value !== before };
        if (!read.list.length) {
            result.error = read.misaligned
                ? `Geen crediteuren kunnen lezen: ${read.misaligned} rijen hadden een ander aantal cellen (${width0(read)}) dan kolomkoppen (${read.headers.length}).`
                : 'Geen crediteuren kunnen lezen (geen seq of naam per rij gevonden).';
            return result;
        }
        if (!check.ok || check.bad.length > check.ok) {
            result.error = 'De gelezen nummers kloppen niet met de bekende crediteuren, dus er is niets opgeslagen.';
            return result;
        }
        result.meta = await saveCreditorList(read.list, { partial, columns: read.headers });
        log('Creditors refreshed from FitOn', result.meta);
        return result;
    }

    async function runCreditorRefresh() {
        setStatus('Crediteuren verversen', 'running', 10);
        try {
            const r = await refreshCreditorsFromFitOn(t => setSubStatus(t));
            setSubStatus('');
            if (r.error) {
                setStatus('Crediteuren niet ververst', 'error', 100);
                log('Creditor refresh refused', r);
                await fipTell(`${r.error}\n\nKolommen: ${r.headers.join(' | ') || '(geen)'}\n`
                    + (r.check.bad.length ? `\nAfwijkend: ${r.check.bad.slice(0, 5).join('; ')}\n` : '')
                    + `\nDraai fiton.refreshCreditors() in de console en stuur de uitvoer door.`, 'Crediteuren verversen');
                return;
            }
            const m = r.meta;
            setStatus(`${m.total} crediteuren opgeslagen`, 'done', 100);
            await fipTell(`${m.read} crediteuren gelezen uit FitOn: ${m.added} nieuw, ${m.updated} bijgewerkt. `
                + `Er zijn er nu ${m.total} opgeslagen in deze browser.`
                + (r.partial ? '\n\nLet op: "Show More" bleef hangen, dus mogelijk is niet alles gelezen. Probeer het nog een keer.' : '')
                + (r.misaligned ? `\n\n${r.misaligned} rij(en) overgeslagen omdat de kolommen niet klopten.` : '')
                + (r.check.bad.length ? `\n\nAfwijkend van de ingebouwde lijst: ${r.check.bad.join('; ')}` : ''),
                'Crediteuren verversen');
        } catch (e) {
            setStatus('Crediteuren niet ververst', 'error', 100);
            setSubStatus('');
            await fipTell(e.message, 'Crediteuren verversen');
        }
    }


    /* APEX puts the submitted page values in p_json:
         {"salt":"…","pageItems":{"itemsToSubmit":[{"n":"P673_PRICE","v":"230"}],
          "protected":"…"},"id":"…","request":"CREATE"}
       Unpacked, it shows plainly which field held which value - and which of
       the remaining fields are only there to protect the submission. */
    function apexItemsIn(value) {
        let data;
        try { data = JSON.parse(value); } catch (e) { return null; }
        const items = data && data.pageItems && data.pageItems.itemsToSubmit;
        if (!Array.isArray(items)) return null;
        const rows = items.map(it => ({ item: it.n, waarde: String(it.v === null || it.v === undefined ? '' : it.v).slice(0, 120) }));
        ['salt', 'id'].forEach(k => { if (data[k]) rows.push({ item: `(${k})`, waarde: String(data[k]).slice(0, 60) + '…' }); });
        if (data.pageItems.protected) rows.push({ item: '(protected)', waarde: String(data.pageItems.protected).slice(0, 60) + '…' });
        if (data.request) rows.push({ item: '(request)', waarde: data.request });
        return rows;
    }

    /* What the last invoice was about, so the report that goes to the dashboard
       says more than "8 lines booked". Kept in memory only. */
    let REPORT_CONTEXT = null;

    function bytesToBase64(buffer) {
        const bytes = new Uint8Array(buffer);
        let binary = '';
        for (let i = 0; i < bytes.length; i += 0x8000) {
            binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        }
        return btoa(binary);
    }

    /* Send the outcome of a run to the shared dashboard, if one is set up. The
       service worker does the sending and keeps anything it could not deliver,
       so a dashboard that is down never costs a report - and never holds up the
       person at the screen either. */
    /* The FitOn user signed in, as the navigation bar shows it ("AVANLENT"). */
    function fitonUser() {
        const icon = document.querySelector('.t-Button--navBar .fa-user');
        const button = icon && icon.closest('.t-Button');
        const label = button && button.querySelector('.t-Button-label');
        return label ? label.textContent.trim() : '';
    }

    // Reports go out when either the Supabase project or an own server is set.
    const DASHBOARD_KEYS = ['supabaseUrl', 'supabaseKey', 'dashboardUrl', 'dashboardSendDocument'];
    const dashboardConfigured = cfg => !!((String(cfg.supabaseUrl || '').trim() && String(cfg.supabaseKey || '').trim())
        || String(cfg.dashboardUrl || '').trim());

    async function reportRun(done, state, tone, message) {
        try {
            const cfg = await new Promise(res => chrome.storage.sync.get(
                DASHBOARD_KEYS, d => res(d || {})));
            if (!dashboardConfigured(cfg)) return;

            const ctx = REPORT_CONTEXT || {};
            const items = (state.items || []).map(i => ({
                desc: i.desc, ledger: i.ledger, ledgerName: i.ledgerName || (LEDGER[i.ledgerKey] || {}).name || '',
                qty: i.qty, price: i.price,
                amount: (Number(i.qty) || 0) * (Number(i.price) || 0)
            }));

            const report = {
                at: done.at, outcome: tone, message, user: fitonUser(),
                invoiceNo: ctx.invoiceNo || '', creditor: ctx.creditor || '', creditorSeq: ctx.creditorSeq || '',
                shipment: state.shipmentRef || '', container: state.container || '',
                lines: done.lines, booked: done.booked, amount: ctx.amount,
                avgMs: done.avgMs, lineTimes: done.lineTimes, items,
                client: state.client || '', mode: state.mode || '',
                version: chrome.runtime.getManifest().version,
                machine: navigator.userAgent.replace(/^.*\((.*?)\).*$/, '$1').slice(0, 60)
            };
            if (cfg.dashboardSendDocument && ctx.document) report.document = ctx.document;

            const res = await chrome.runtime.sendMessage({ type: 'sendReport', report });
            if (res && res.queued) log(`Report queued (${res.queued} waiting): ${res.error || ''}`);
        } catch (e) {
            log('Report not sent', String(e.message || e));   // never block the run over this
        }
    }

    /* A run from an invoice books one container per page load, and every page
       load starts this script over, so REPORT_CONTEXT and the PDF are long gone
       by the last container. The worklist carries what the report needs and the
       PDFs wait in extension storage. One report goes out per invoice, also when
       several were read in at once: the dashboard is searched by invoice number,
       so a row that covered three of them would be findable under none. */
    async function reportWorklist(w, booked, clean) {
        try {
            const cfg = await new Promise(res => chrome.storage.sync.get(
                DASHBOARD_KEYS, d => res(d || {})));
            const stored = await chrome.storage.local.get([REPORT_DOC_KEY]);
            await chrome.storage.local.remove(REPORT_DOC_KEY);
            if (!dashboardConfigured(cfg)) return;

            /* An array since 9.20; a single document before that. */
            const kept = stored[REPORT_DOC_KEY];
            const documents = Array.isArray(kept) ? kept : (kept ? [kept] : []);
            const documentFor = group => {
                const hit = documents.find(d => d && (d.docId || '') === group.docId);
                return hit || (documents.length === 1 && !documents[0].docId ? documents[0] : null);
            };

            const invoices = worklistInvoices(w);
            const groups = invoices.map(inv => Object.assign({}, inv, {
                items: w.items.filter(i => invoiceKey(w, i) === (inv.docId || inv.invoiceNo || ''))
            })).filter(g => g.items.length);

            for (const group of groups) {
                const items = group.items;
                const groupBooked = items.filter(i => i.status === 'done').length;
                const groupClean = groupBooked === items.length;
                const report = {
                    at: Date.now(), outcome: groupClean ? 'done' : 'error',
                    user: w.user || fitonUser(),          // who read the invoice in
                    message: `${groupBooked} van de ${items.length} zendingen geboekt`,
                    invoiceNo: group.invoiceNo || '', creditor: group.creditorName || '',
                    creditorSeq: group.creditorSeq || '',
                    // the dossier it was actually booked on, or the invoice's own
                    // reference while that is all we have
                    shipment: [...new Set(items.map(i => i.shipmentNo || i.ref).filter(Boolean))].join(', ').slice(0, 200),
                    container: [...new Set(items.map(i => i.container || (i.unit && i.unit.value)).filter(Boolean))].join(', ').slice(0, 200),
                    lines: items.length, booked: groupBooked,
                    amount: group.amount != null ? group.amount
                          : groups.length === 1 && w.amount != null ? w.amount
                          : round2(items.reduce((a, i) => a + (Number(i.total) || 0), 0)),
                    items: items.map(i => ({
                        desc: [transportName(i) || '?', transportFacts(i).join(' · ')].filter(Boolean).join(' — ')
                            + (i.status === 'done' ? '' : ` (${i.reason || i.status})`),
                        ledger: '', ledgerName: '', qty: 1, price: i.total, amount: i.total
                    })),
                    // The whole picture per transport, for the dashboard's detail view.
                    transports: items.map(i => ({
                        name: transportName(i), facts: transportFacts(i), status: i.status, reason: i.reason || '',
                        shipmentNo: i.shipmentNo || '',
                        total: i.total, bookedLines: i.bookedLines || null,
                        lines: (i.lines || []).map(l => {
                            const led = ledgerForSpecLine(l.desc, l);
                            return { desc: l.desc, qty: l.qty, price: l.unitPrice, amount: l.amount, ledger: led.id, ledgerName: led.name };
                        })
                    })),
                    bookedAmount: round2(items.filter(i => i.status === 'done').reduce((a, i) => a + (Number(i.total) || 0), 0)),
                    fileName: group.docName || w.fileName || '',
                    confidence: group.confidence || (groups.length === 1 ? (w.confidence || '') : ''),
                    statedTotal: group.statedTotal != null ? group.statedTotal
                               : (groups.length === 1 && w.statedTotal != null ? w.statedTotal : null),
                    descMode: w.descMode || '', combine: !!w.combine, ignoreExisting: !!w.ignoreExisting,
                    startedAt: w.startedAt || null, durationMs: w.startedAt ? Date.now() - w.startedAt : null,
                    // Only meaningful when more than one invoice went in at once.
                    batchInvoices: groups.length > 1 ? groups.length : null,
                    mode: 'cost',
                    version: chrome.runtime.getManifest().version,
                    machine: navigator.userAgent.replace(/^.*\((.*?)\).*$/, '$1').slice(0, 60)
                };
                const doc = documentFor(group);
                if (cfg.dashboardSendDocument && doc && doc.base64) report.document = { name: doc.name, base64: doc.base64 };

                const res = await chrome.runtime.sendMessage({ type: 'sendReport', report });
                if (res && res.queued) log(`Report queued (${res.queued} waiting): ${res.error || ''}`);
            }
        } catch (e) {
            log('Report not sent', String(e.message || e));
        }
    }

    /* =========================================================================
       SENDER MARKERS
       -------------------------------------------------------------------------
       Some documents never write their own name: a service specification carries
       our name (we are the addressee), a logo, and nothing else. Recognising the
       sender there means remembering something that stays the same from one of
       their documents to the next. Three such things, in order of how much they
       prove: the bytes of the logo, our account number with them, and the fixed
       part of their invoice numbering.

       Nothing is guessed here. A marker is only ever learned from a creditor
       that was picked by hand, and if the same marker later turns up on a
       document booked on someone else, it is dropped rather than believed.
       ========================================================================= */
    let CREDITOR_MARKS = {};

    function loadCreditorMarks() {
        return new Promise(resolve => {
            if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return resolve();
            chrome.storage.local.get(['creditorMarks'], d => {
                if (d && d.creditorMarks) CREDITOR_MARKS = d.creditorMarks;
                resolve();
            });
        });
    }

    function documentMarks(text, imageHashes) {
        const marks = [];
        (imageHashes || []).forEach(h => marks.push('img:' + h));

        /* Our customer number with this supplier. Their VAT or invoice number
           changes per document; a customer number does not. */
        // deliberately not "account no": that is the supplier's own bank account,
        // which says nothing about which of their documents this is
        const cust = /\b(?:klant\s*nr\.?|klantnummer|debiteurennummer|debiteur\s*nr\.?|deb\.?\s*nr\.?|customer(?:\s*(?:code|no\.?|number))?)\s*:?\s*(\d{4,12})\b/gi;
        for (const m of String(text).matchAll(cust)) marks.push('cust:' + m[1]);

        /* The fixed part of their invoice numbering: 070PSI2603830 -> 070PSI.
           Only when it holds letters, so a plain number is never a marker. */
        const inv = /\b(?:factuur\s*nr\.?|factuurnummer|invoice\s*(?:no\.?|number)|rechnungsnr\.?)\s*:?\s*([0-9]{0,4}[A-Za-z]{2,6})[0-9]{4,}\b/gi;
        for (const m of String(text).matchAll(inv)) marks.push('inv:' + m[1].toUpperCase());

        return [...new Set(marks)];
    }

    /* A logo outranks a customer number, which outranks a numbering prefix. */
    const MARK_RANK = { img: 3, cust: 2, inv: 1 };
    const MARK_LABEL = { img: 'het logo', cust: 'het klantnummer', inv: 'het factuurnummer' };

    function creditorByMarks(marks) {
        let best = null;
        (marks || []).forEach(mark => {
            const hit = CREDITOR_MARKS[mark];
            if (!hit || hit.conflicting) return;
            const rank = MARK_RANK[mark.split(':')[0]] || 0;
            if (!best || rank > best.rank) best = { rank, mark, seq: hit.seq, name: hit.name };
        });
        if (!best) return null;
        const known = CREDITORS.find(c => c.seq === best.seq);
        return Object.assign({ seq: best.seq, name: best.name }, known || {},
                             { viaMark: best.mark, viaKind: best.mark.split(':')[0] });
    }

    function learnCreditorMarks(marks, seq, name) {
        if (!seq || !(marks || []).length) return;
        let changed = false;
        marks.forEach(mark => {
            const old = CREDITOR_MARKS[mark];
            if (old && old.seq !== seq) {
                /* The same marker pointing at two creditors proves nothing - a
                   shared template image, say. Kept, but never trusted again. */
                if (!old.conflicting) { CREDITOR_MARKS[mark] = Object.assign({}, old, { conflicting: true }); changed = true; }
                return;
            }
            if (!old) { CREDITOR_MARKS[mark] = { seq, name: name || '', at: Date.now() }; changed = true; }
        });
        if (!changed) return;
        try { chrome.storage.local.set({ creditorMarks: CREDITOR_MARKS }); } catch (e) {}
        log('Sender markers learned', { seq, name, marks });
    }

    /* =========================================================================
       PDF TEXT EXTRACTION
       -------------------------------------------------------------------------
       These specifications are text PDFs, so the text can be read exactly - no
       OCR, and no bundled library: Chrome's own DecompressionStream handles the
       FlateDecode streams. Each shown string is collected with the position it
       was drawn at, then grouped by line so table rows come back intact.
       If a PDF turns out to be a scan, no text is found and the dialog asks for
       a paste instead rather than guessing.
       ========================================================================= */
    async function inflate(bytes) {
        if (!bytes || bytes.length < 3) return null;

        /* Order matters. Some PDF writers emit a zlib header that declares an
           8 KB window while the data actually uses 32 KB back-references.
           Chrome's DecompressionStream honours that declaration and refuses the
           stream ("invalid distance too far back"); zlib in other tools quietly
           allows it, which is why such a PDF opens fine everywhere else.
           Skipping the 2-byte header and inflating as raw deflate sidesteps the
           declaration entirely, so that is the fallback. */
        const attempts = [
            [bytes, 'deflate'],
            [bytes.subarray(2), 'deflate-raw'],
            [bytes, 'deflate-raw']
        ];

        /* Chrome also refuses a stream with anything after its end ("Junk found
           after end of compressed data"), where other readers ignore it. Some
           writers leave exactly that: CMA CGM invoices are ASCII85-wrapped and
           the ASCII85 carries 1-3 padding zeros after the zlib data, so every
           /ToUnicode table and page 2 failed and the text came out as glyph
           numbers. So when a strategy fails, retry it with the tail trimmed a
           byte at a time; only the exact length inflates cleanly, a shorter one
           is rejected as truncated. Eight bytes covers padding plus the 4-byte
           checksum that deflate-raw sees as junk. */
        const run = async (data, format) => {
            try {
                const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream(format));
                const out = new Uint8Array(await new Response(stream).arrayBuffer());
                return out.length ? out : null;
            } catch (e) { return null; }
        };

        for (const [data, format] of attempts) {
            for (let cut = 0; cut <= 8 && data.length - cut > 2; cut++) {
                const out = await run(cut ? data.subarray(0, data.length - cut) : data, format);
                if (out) return out;
            }
        }
        return null;
    }

    const latin1 = bytes => {
        let out = '';
        for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
        return out;
    };

    function indexOfBytes(haystack, needle, from) {
        const n = [...needle].map(c => c.charCodeAt(0));
        outer: for (let i = from; i <= haystack.length - n.length; i++) {
            for (let j = 0; j < n.length; j++) if (haystack[i + j] !== n[j]) continue outer;
            return i;
        }
        return -1;
    }

    const unescapePdf = t => t.replace(/\\(\d{1,3})/g, (m, o) => String.fromCharCode(parseInt(o, 8)))
                             .replace(/\\([()\\])/g, '$1');

    /* Decodes <00480065> style strings. With an Identity-H font these are glyph
       numbers, two bytes each, and only the font's own table says which letter
       each one is. Without a table we fall back to reading them as plain bytes,
       which is right for the fonts that use single-byte codes. */
    function decodeHexString(hex, glyphs) {
        const clean = hex.replace(/[^0-9A-Fa-f]/g, '');
        let out = '';
        if (glyphs && glyphs.size) {
            for (let i = 0; i + 3 < clean.length + 1; i += 4) {
                const code = parseInt(clean.substr(i, 4), 16);
                if (isNaN(code)) continue;
                out += glyphs.has(code) ? glyphs.get(code) : '';
            }
            if (out.trim()) return out;
        }
        for (let i = 0; i + 1 < clean.length + 1; i += 2) {
            const code = parseInt(clean.substr(i, 2), 16);
            if (!isNaN(code) && code >= 32) out += String.fromCharCode(code);
        }
        return out;
    }

    function pdfFragments(content, fontTables) {
        let glyphs = null;                       // table of the font in use
        const frags = [];
        let x = 0, y = 0, lineX = 0, lineY = 0, leading = 0;
        /* Td moves in text space, so it has to go through the scale of the last
           Tm. Maersk writes "6 0 0 6 58 431 Tm" and then "9.9 0 Td": that is
           59 points to the right, not 9.9. Ignoring the scale squeezed every
           row together, so an amount landed on another row than its charge. */
        let ma = 1, mb = 0, mc = 0, md = 1;
        const move = (tx, ty) => { lineX += tx * ma + ty * mc; lineY += tx * mb + ty * md; x = lineX; y = lineY; };
        const tok = /(\/[A-Za-z0-9#+.-]+)\s+[-\d.]+\s+Tf|\[((?:[^\]\\]|\\.)*)\]\s*TJ|\(((?:[^)\\]|\\.)*)\)\s*Tj|<([0-9A-Fa-f\s]+)>\s*Tj|BT|ET|([-\d.]+)\s+([-\d.]+)\s+Td|([-\d.]+)\s+([-\d.]+)\s+TD|([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+Tm|T\*|([-\d.]+)\s+TL/g;
        let m;
        while ((m = tok.exec(content))) {
            const op = m[0];
            if (m[1] !== undefined) {                       // /F1 9 Tf - font switch
                glyphs = fontTables && fontTables.get ? (fontTables.get(m[1]) || null) : null;
            }
            else if (op === 'BT') { x = y = lineX = lineY = 0; ma = md = 1; mb = mc = 0; }
            else if (m[5] !== undefined) { move(parseFloat(m[5]), parseFloat(m[6])); }
            else if (m[7] !== undefined) { leading = -parseFloat(m[8]); move(parseFloat(m[7]), parseFloat(m[8])); }
            else if (m[9] !== undefined) {
                ma = parseFloat(m[9]); mb = parseFloat(m[10]); mc = parseFloat(m[11]); md = parseFloat(m[12]);
                lineX = parseFloat(m[13]); lineY = parseFloat(m[14]); x = lineX; y = lineY;
            }
            else if (op === 'T*') { move(0, -leading); }
            else if (m[15] !== undefined) { leading = parseFloat(m[15]); }
            else if (m[2] !== undefined) {                  // [ ... ] TJ
                let text = '';
                for (const part of m[2].matchAll(/\(((?:[^)\\]|\\.)*)\)|<([0-9A-Fa-f\s]+)>|(-?\d+(?:\.\d+)?)/g)) {
                    if (part[1] !== undefined) text += unescapePdf(part[1]);
                    else if (part[2] !== undefined) text += decodeHexString(part[2], glyphs);
                    else if (parseFloat(part[3]) < -100) text += ' ';   // wide kern = column gap
                }
                if (text.trim()) frags.push({ x, y, text });
            }
            else if (m[3] !== undefined) {                  // ( ... ) Tj
                const text = unescapePdf(m[3]);
                if (text.trim()) frags.push({ x, y, text });
            }
            else if (m[4] !== undefined) {                  // < ... > Tj
                const text = decodeHexString(m[4], glyphs);
                if (text.trim()) frags.push({ x, y, text });
            }
        }
        return frags;
    }

    function fragmentsToLines(frags) {
        const rows = new Map();
        frags.forEach(f => {
            const key = Math.round(f.y * 2) / 2;
            if (!rows.has(key)) rows.set(key, []);
            rows.get(key).push(f);
        });
        return [...rows.entries()]
            .sort((a, b) => b[0] - a[0])
            .map(([, list]) => list.sort((a, b) => a.x - b.x).map(f => f.text).join(' ').replace(/\s+/g, ' ').trim())
            .filter(Boolean);
    }

    /* Rows with the x-position of every fragment kept intact. Columns can only
       be found if we know where things sit on the page, so the structural parser
       works from this rather than from flattened text. */
    /* Walks every stream in the file once. Encrypted streams are decrypted
       first, then anything that turns out to be a /ToUnicode table is collected,
       and only after that are the content streams turned into text - because a
       glyph number means nothing until its table has been read. */
    let lastPdfDiagnosis = null;

    let lastImageHashes = [];

    async function sha256Hex(bytes) {
        try {
            const digest = await crypto.subtle.digest('SHA-256', bytes);
            return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
        } catch (e) { return null; }
    }

    async function pdfStreams(arrayBuffer) {
        const bytes = new Uint8Array(arrayBuffer);
        const whole = latin1(bytes);

        const diag = {
            bytes: bytes.length,
            decompressionStream: (typeof DecompressionStream !== 'undefined'),
            cryptoHelpers: (typeof FitonPdf !== 'undefined'),
            streamsFound: 0, decrypted: 0, inflated: 0, withText: 0, images: 0,
            encrypted: false, note: ''
        };
        const imageHashes = [];
        lastPdfDiagnosis = diag;

        if (!diag.decompressionStream) {
            diag.note = 'Deze browser kent DecompressionStream niet — bijwerken is nodig.';
            return { streams: [], whole, diag, imageHashes };
        }

        if (!diag.cryptoHelpers) diag.note = 'pdf-crypto.js is niet geladen — versleutelde PDF\'s kunnen niet gelezen worden.';
        const enc = (typeof FitonPdf !== 'undefined') ? FitonPdf.readEncryption(whole) : null;
        let baseKey = null;
        if (enc) {
            diag.encrypted = true;
            baseKey = FitonPdf.fileKey(enc);
            log(`PDF is encrypted (V${enc.v}/R${enc.r}, ${enc.cfm}) - decrypting with an empty password`);
        }

        const out = [];
        let pos = 0;
        while (true) {
            const s = indexOfBytes(bytes, 'stream', pos);
            if (s === -1) break;
            let start = s + 6;
            if (bytes[start] === 0x0d) start++;
            if (bytes[start] === 0x0a) start++;

            /* Where a stream ends can be said two ways: the /Length in its
               dictionary, or the next "endstream". Neither is reliable on its
               own - binary data can contain the word endstream, and /Length is
               sometimes an indirect reference - so every plausible boundary is
               tried until one of them inflates. Guessing only one way is why a
               file could yield nine blocks and not a single readable one. */
            /* Only this object's own dictionary, and never part of an indirect
               reference: without the (?!\d) guard, "/Length 14 0 R" backtracks
               and is read as a length of 1. */
            const dictWindow = whole.slice(Math.max(0, s - 600), s);
            const ownHeads = [...dictWindow.matchAll(/\d+\s+\d+\s+obj\b/g)];
            const dictText = ownHeads.length ? dictWindow.slice(ownHeads[ownHeads.length - 1].index) : dictWindow;
            const lengthMatch = /\/Length\s+(\d+)(?!\d|\s+\d+\s+R)/.exec(dictText);
            const endAt = indexOfBytes(bytes, 'endstream', start);

            const candidates = [];
            if (lengthMatch) candidates.push(start + parseInt(lengthMatch[1], 10));
            if (endAt !== -1) {
                let trimmed = endAt;
                while (trimmed > start && (bytes[trimmed - 1] === 0x0a || bytes[trimmed - 1] === 0x0d)) trimmed--;
                candidates.push(trimmed, endAt);
            }
            if (!candidates.length) break;

            pos = Math.max(...candidates) + 9;
            diag.streamsFound++;

            const window = whole.slice(Math.max(0, s - 3000), s);
            const headerList = [...window.matchAll(/(\d+)\s+(\d+)\s+obj/g)];
            const head = headerList[headerList.length - 1];
            const objNumber = head ? parseInt(head[1], 10) : 0;
            const genNumber = head ? parseInt(head[2], 10) : 0;

            /* A logo is an embedded image, and the same supplier's template
               embeds the same bytes every time. Hashing it gives a marker that
               identifies the sender of a document that never spells its own name
               out - a service specification with nothing but a logo at the top. */
            const isImage = /\/Subtype\s*\/Image/.test(dictText);

            let data = null, usedObj = objNumber;
            for (const end of candidates) {
                if (end <= start || end > bytes.length) continue;
                let chunk = bytes.slice(start, end);

                if (enc && baseKey) {
                    const plain = await FitonPdf.decryptStream(chunk, enc, baseKey, objNumber, genNumber);
                    if (!plain) continue;
                    chunk = plain;
                    diag.decrypted++;
                }

                if (isImage) {
                    // hash the stored bytes: a JPEG never inflates, and inflating
                    // is pointless anyway - identical images give identical bytes
                    const sha = await sha256Hex(chunk);
                    if (sha) { imageHashes.push(sha); diag.images++; }
                    break;
                }

                data = await inflate(chunk);
                if (data) break;

                /* The stream may be wrapped in ASCII85 or ASCII-hex before it was
                   compressed; undo that and try again. */
                if (typeof FitonPdf !== 'undefined') {
                    if (FitonPdf.looksAscii85(chunk)) {
                        const unwrapped = FitonPdf.ascii85Decode(chunk);
                        data = await inflate(unwrapped);
                        if (data) break;
                        if (/\bBT\b[\s\S]*\bTf\b/.test(latin1(unwrapped))) { data = unwrapped; break; }
                    }
                    const dictBefore = whole.slice(Math.max(0, s - 400), s);
                    if (/ASCIIHexDecode/.test(dictBefore)) {
                        const unwrapped = FitonPdf.asciiHexDecode(chunk);
                        data = await inflate(unwrapped);
                        if (data) break;
                    }
                }

                /* Or stored as-is. Require real text operators, not just the
                   letters "Tj" appearing somewhere in binary noise. */
                const asText = latin1(chunk);
                if (/\bBT\b[\s\S]{0,4000}\bTf\b/.test(asText) || /beginbfchar/.test(asText)) {
                    data = chunk;
                    break;
                }
            }

            if (data) {
                diag.inflated++;
                const content = latin1(data);
                if (/\bTJ\b|\bTj\b/.test(content)) diag.withText++;
                out.push({ obj: usedObj, content });
            }
        }
        log('PDF read', diag);
        return { streams: out, whole, diag, imageHashes };
    }

    async function pdfToRows(arrayBuffer) {
        const { streams, whole, imageHashes } = await pdfStreams(arrayBuffer);
        lastImageHashes = imageHashes || [];

        /* Each font carries its own glyph table, and two fonts in one document
           number their glyphs differently. Merging the tables turns half the
           text into nonsense, so every table is kept against the font that owns
           it: font resource -> /ToUnicode object -> table. */
        const cmapByObject = new Map();
        streams.forEach(({ obj, content }) => {
            if (/beginbfchar|beginbfrange/.test(content)) cmapByObject.set(obj, FitonPdf.parseCMap(content));
        });

        const fontToCmap = new Map();            // resource name (F1) -> table
        if (cmapByObject.size) {
            const fontObjToCmap = new Map();
            for (const m of whole.matchAll(/\/ToUnicode\s+(\d+)\s+\d+\s+R/g)) {
                const table = cmapByObject.get(parseInt(m[1], 10));
                if (!table) continue;
                // the font this table belongs to is the object it is written in,
                // so look back for the nearest object header
                const before = whole.slice(Math.max(0, m.index - 2500), m.index);
                const heads = [...before.matchAll(/(\d+)\s+\d+\s+obj/g)];
                if (heads.length) fontObjToCmap.set(parseInt(heads[heads.length - 1][1], 10), table);
            }
            for (const res of whole.matchAll(/\/Font\s*<<([^>]*)>>/g)) {
                for (const pair of res[1].matchAll(/\/([A-Za-z0-9#+.-]+)\s+(\d+)\s+\d+\s+R/g)) {
                    const table = fontObjToCmap.get(parseInt(pair[2], 10));
                    if (table) fontToCmap.set('/' + pair[1], table);
                }
            }
            log(`Glyph tables: ${cmapByObject.size} found, ${fontToCmap.size} linked to a font`);
        }

        const allTables = [...cmapByObject.values()];

        const readability = frags => frags.reduce((n, f) => n + (f.text.match(/[A-Za-z]/g) || []).length, 0);

        const rows = [];
        streams.forEach(({ content }) => {
            if (!/\bTJ\b|\bTj\b/.test(content)) return;

            let frags = pdfFragments(content, fontToCmap);

            /* Linking fonts to their tables relies on the resource dictionary
               being written in a way we can follow, which is not always so. If
               the result reads like nonsense, try each table on its own and keep
               whichever produces the most actual letters - the right table is
               the one that yields words. */
            if (allTables.length && readability(frags) < 20) {
                allTables.forEach(table => {
                    const attempt = pdfFragments(content, { get: () => table });
                    if (readability(attempt) > readability(frags)) frags = attempt;
                });
            }
            const byLine = new Map();
            frags.forEach(f => {
                const key = Math.round(f.y * 2) / 2;
                if (!byLine.has(key)) byLine.set(key, []);
                byLine.get(key).push(f);
            });
            [...byLine.entries()].sort((a, b) => b[0] - a[0]).forEach(([y, list]) => {
                const cells = list.sort((a, b) => a.x - b.x)
                    .map(f => ({ x: f.x, text: f.text.trim() }))
                    .filter(c => c.text);
                if (cells.length) rows.push({ y, cells, raw: cells.map(c => c.text).join(' ').replace(/\s+/g, ' ').trim() });
            });
        });
        return rows;
    }

    /* Pasted text has no coordinates, so approximate them with the character
       offset - good enough to tell a description column from an amount column. */
    function rowsFromText(text) {
        return String(text || '').split(/\r?\n/).map(line => {
            // One cell per word, positioned by character offset. Grouping words
            // into phrases here would hide the column structure the parser needs.
            const cells = [];
            const re = /\S+/g;
            let m;
            while ((m = re.exec(line))) cells.push({ x: m.index, text: m[0] });
            return { y: 0, cells, raw: line.trim() };
        }).filter(r => r.raw);
    }

    async function pdfToText(arrayBuffer) {
        const bytes = new Uint8Array(arrayBuffer);
        const lines = [];
        let pos = 0;
        while (true) {
            const s = indexOfBytes(bytes, 'stream', pos);
            if (s === -1) break;
            let start = s + 6;
            if (bytes[start] === 0x0d) start++;
            if (bytes[start] === 0x0a) start++;
            const e = indexOfBytes(bytes, 'endstream', start);
            if (e === -1) break;
            const chunk = bytes.slice(start, e);
            pos = e + 9;

            const data = await inflate(chunk);
            if (!data) continue;
            const content = latin1(data);
            if (!/\bTJ\b|\bTj\b/.test(content)) continue;
            lines.push(...fragmentsToLines(pdfFragments(content)));
        }
        return lines.join('\n');
    }

    /* Returns the rows with their positions, because the column layout is what
       the parser reads. Plain text files fall back to an approximation. */
    async function readDroppedFile(file) {
        if (/\.pdf$/i.test(file.name) || file.type === 'application/pdf') {
            const buffer = await file.arrayBuffer();
            const rows = await pdfToRows(buffer);
            if (!rows.length) {
                const d = lastPdfDiagnosis || {};
                const detail = d.note ? d.note
                    : `${d.streamsFound || 0} blokken in het bestand, ${d.inflated || 0} uitgepakt, `
                      + `${d.withText || 0} met tekst${d.encrypted ? ', versleuteld' : ''}.`;
                const scanned = (d.images || 0) > 0 && !(d.withText || 0);
                throw new Error(scanned
                    ? 'Deze PDF bevat alleen afbeeldingen en geen tekst — waarschijnlijk een scan. '
                      + 'De extensie leest geen tekst uit afbeeldingen. Vraag de leverancier om een digitale PDF, '
                      + 'of plak de regels hieronder.'
                    : 'Geen leesbare tekst gevonden. ' + detail
                      + ' Kopieer de tekst uit de PDF en plak hem hieronder.');
            }
            return { rows, text: rows.map(r => r.raw).join('\n'), imageHashes: lastImageHashes.slice(), bytes: buffer };
        }
        const text = await file.text();
        return { rows: rowsFromText(text), text };
    }

    /* =========================================================================
       SERVICE SPECIFICATION IMPORT (Lineage and similar)
       -------------------------------------------------------------------------
       A consolidated invoice covers many containers and gives no per-container
       total, so the split has to be done by hand. Paste the text of the PDF and
       this splits it per transport, totals each container, and books the one
       that belongs to the shipment you have open.

       The PDF has a real text layer, so no OCR is involved: select all in the
       PDF viewer, copy, paste.
       ========================================================================= */
    const SPEC_HEAD = /^Transport\s+(\S+):\s*(\S+)\s+Ref\.:\s*(\S+?)(?:\s*-\s*(\S+))?\s+Container:\s*(\S+)/;
    const SPEC_LINE = /^(.+?)\s+([\d.]+,\d+)\s+(\S+)\s+([\d.]+,\d+)\s+(\d+)\s+([\d.]+,\d+)$/;

    const nlNum = str => parseFloat(String(str).replace(/\./g, '').replace(',', '.'));

    /* Which ledger a charge line belongs to, whatever supplier it came from.
       First match wins, so the specific rules sit above the general ones.
       Anything unmatched lands on Miscellaneous and is flagged in the preview,
       where the ledger can be corrected before booking. */
    const SPEC_LEDGER_RULES = [
        // inspection and authorities
        { re: /checkpoint|keurpunt|inspection point|gebruik keurpunt/i,        led: () => LEDGER.vet },
        { re: /veterinar|vet check|nvwa|voedsel.?en.?waren/i,                  led: () => LEDGER.nvwa },
        { re: /^lab\b|laborator|salmonella|chloramphenicol|chlooramphenicol|nitrofuran|tetracyclin|screening/i, led: () => LEDGER.nvwa },
        { re: /\bkcb\b|kwaliteits.?controle/i,                                led: () => LEDGER.kcb },
        { re: /gas ?measurement|gasmeting|gasmeet/i,                           led: () => LEDGER.gasMeasurement },
        { re: /fumigat/i,                                                      led: () => LEDGER.fumigation },
        { re: /customs inspection|x-?ray|scan(ning)? ?fee|physical inspection/i, led: () => LEDGER.customsInsp },
        { re: /customs fine|boete/i,                                           led: () => LEDGER.customsFine },
        { re: /no ?show/i,                                                     led: () => LEDGER.noShow },

        // documents
        { re: /transit document|\bt1\b|closure of transit|afmelden t1/i,       led: () => LEDGER.transit },
        { re: /\bt2l\b/i,                                                      led: () => LEDGER.t2l },
        { re: /import (customs )?(clearance|declaration|entry)|invoeraangifte|aangifte ten invoer/i, led: () => LEDGER.importDoc },
        { re: /export (document|declaration)|uitvoeraangifte|aangifte ten uitvoer/i, led: () => LEDGER.exportDoc },
        { re: /certificate of origin|eur-?1/i,                                 led: () => LEDGER.certOrigin },
        { re: /fiscal represent|fiscaal vertegenw/i,                           led: () => LEDGER.fiscalRep },
        { re: /doc(umentation)? ?fee|i\/b doc|doc fee|documentatie|ched|cved|ggb|seal|zegel|printing|documents to driver|delivery order|bill of lading fee|telex release/i, led: () => LEDGER.docs },

        // carrier and terminal charges
        { re: /terminal handling|(^|\b)thc\b|dthc|dest trml|terminal handling service/i, led: () => LEDGER.thc },
        { re: /isps|ispc|ship and port facility/i,                             led: () => LEDGER.isps },
        { re: /security (charge|fee)|terminal security|port security/i,        led: () => LEDGER.terminalSecDest },
        { re: /admin(istration)? fee|import handling fee|import service charge/i, led: () => LEDGER.adminFeeDest },
        { re: /equipment (maintenance|mainten|management)|container management/i, led: () => LEDGER.equipMaintenance },
        { re: /container (inspection|survey)|inspection (&|and) survey|equipment inspection/i, led: () => LEDGER.containerInspect },
        { re: /carrier haulage|haulage fee/i,                                  led: () => LEDGER.trucking },
        { re: /container protect/i,                                            led: () => LEDGER.containerProtect },
        { re: /congestion/i,                                                   led: () => LEDGER.congestion },
        { re: /(delta|ect|rwg|euromax|maasvlakte)[ -]?(toeslag|surcharge|peak)/i, led: () => LEDGER.peak },
        { re: /voormeld|pre-?announc|aanmeldkosten/i,                          led: () => LEDGER.docs },
        { re: /climate fee/i,                                                  led: () => LEDGER.terminalClimate },
        { re: /emergency (fuel|bunker)/i,                                      led: () => LEDGER.emergencyFuel },
        { re: /terminal (&|and) transfer|import terminal/i,                    led: () => LEDGER.importTerminal },
        { re: /container handling|shunt|afzetten|opzetten|off chassis|on chassis/i, led: () => LEDGER.containerHandling },
        { re: /plug.?in|reefer power|genset|gen-?set|special equipment/i,      led: () => LEDGER.specialEquip },
        { re: /vgm\b|verified gross/i,                                         led: () => LEDGER.vgm },
        { re: /lashing|securing/i,                                             led: () => LEDGER.lashing },
        { re: /imo (surcharge|declaration)|dangerous goods|dgd\b/i,            led: () => LEDGER.imo },

        // money out of pocket
        { re: /demurrage/i,                                                    led: () => LEDGER.demurrage },
        { re: /detention/i,                                                    led: () => LEDGER.detention },
        { re: /warehouse (in|out)|in.?en.?uitslag|in and outtake|outtake/i,    led: () => LEDGER.warehouseInOut },
        { re: /crossdock|overladen/i,                                          led: () => LEDGER.crossdock },
        { re: /storage|opslag|warehouse storage/i,                             led: () => LEDGER.storage },
        { re: /duty|invoerrecht|douanerecht/i,                                 led: () => LEDGER.duty },
        { re: /\bvat\b|\bbtw\b(?!-)/i,                                         led: () => LEDGER.vat },
        { re: /anti.?dumping/i,                                                led: () => LEDGER.antiDumping },

        // transport
        { re: /\btol\b|toll|maut|tolheffing/i,                                  led: () => LEDGER.toll },
        { re: /fuel|brandstof|diesel|bunker/i,                                 led: () => LEDGER.fuel },
        { re: /waiting|wachtuur|wachturen|standing time/i,                     led: () => LEDGER.waiting },
        { re: /extra stop|multishop|tweede lossing/i,                          led: () => LEDGER.extraStop },
        { re: /chassis|trailer huur/i,                                         led: () => LEDGER.misc },
        { re: /trucking|transport|voorrijkosten|drayage|haulage|cartage/i,     led: () => LEDGER.trucking },
        { re: /ocean freight|seafreight|zeevracht/i,                           led: () => LEDGER.oceanFreight },
        { re: /barge|barging|binnenvaart/i,                                    led: () => LEDGER.barging },
        { re: /airfreight|luchtvracht/i,                                       led: () => LEDGER.airfreight },

        // fallbacks
        { re: /surcharge|toeslag|late notification/i,                          led: () => LEDGER.extraCosts },
        { re: /handling/i,                                                     led: () => LEDGER.handling },
        { re: /courier|postage|porto/i,                                        led: () => LEDGER.postage },
        { re: /commission|commissie/i,                                         led: () => LEDGER.commission },
        { re: /insurance|verzekering/i,                                        led: () => LEDGER.insurance }
    ];

    function ledgerForSpecLine(desc, line) {
        const hit = SPEC_LEDGER_RULES.find(r => r.re.test(desc));
        if (hit) return hit.led();
        if (line && line.isTransportRow) return LEDGER.trucking;   // the row with the container
        return LEDGER.misc;
    }
    const ledgerIsGuess = desc => !SPEC_LEDGER_RULES.some(r => r.re.test(desc));

    /* =========================================================================
       STRUCTURAL INVOICE READING
       -------------------------------------------------------------------------
       No templates and no per-supplier rules. The invoice is read the way a
       person reads it:

         1. find the column the amounts sit in (the money column)
         2. every row with a value in that column is a charge; what stands left
            of it is the description
         3. rows without an amount that carry a container or reference number
            start a new group, so a specification per container splits itself
         4. the total is found by arithmetic, not by the word "total": a value
            that equals the sum of the charges above it IS the total
         5. the charges are then checked against that total

       Step 4 is what makes this work in any language, and step 5 is what stops
       a misread invoice from ever being booked.
       ========================================================================= */

    /* A credit note writes every amount negative, and some layouts bracket them
       instead: (335,00). Both have to be read as money, or a credit note looks
       like a document without any charges at all. */
    /* Thousands are grouped with a dot, a comma or a space depending on the
       country the invoice was printed in - 1.600,00 and 1,600.00 are the same
       amount. Allowing only one of them made every four-figure line invisible,
       which is how a demurrage invoice ended up showing the day rate instead of
       the amount. parseAmount() decides afterwards which separator was decimal. */
    const MONEY_TOKEN = /(?:^|[^\d.,\-(])(\(?-?\d{1,3}(?:[.,]\d{3})+[.,]\d{2}\)?|\(?-?\d+[.,]\d{2}\)?)(?![\d.,])/g;

    function moneyCellsOf(row) {
        const out = [];
        row.cells.forEach(cell => {
            const re = new RegExp(MONEY_TOKEN.source, 'g');
            let m;
            while ((m = re.exec(cell.text))) {
                const v = parseAmount(m[1]);
                if (!isNaN(v) && v !== 0) out.push({ x: cell.x, value: v, text: m[1] });
            }
        });
        return out;
    }

    /* Which x position do the amounts line up on? The rightmost money value of
       each row votes; the position with the most votes wins. */
    function findMoneyColumn(rows) {
        const votes = new Map();
        rows.forEach(row => {
            const money = moneyCellsOf(row);
            if (!money.length) return;
            const last = money[money.length - 1];
            const bucket = Math.round(last.x / 12) * 12;
            votes.set(bucket, (votes.get(bucket) || 0) + 1);
        });
        let best = null, bestCount = 0;
        votes.forEach((count, bucket) => { if (count > bestCount) { best = bucket; bestCount = count; } });
        return { x: best, count: bestCount };
    }

    // CGMU 803082/7, OERU-422507-2 and OERU4225072 are all one way of writing a box
    /* The owner code can come out of a PDF with spaces in it: MSC prints
       SZLU9491905 and the text layer hands us "SZ LU 9491905", which then does
       not read as a container at all - so nothing is looked up and the shipment
       is never found. The letters are allowed to be spaced apart here and the
       spaces are dropped before the number is checked. */
    const CONTAINER_ANY = /\b([A-Z](?:[ ]?[A-Z]){3})[- ]?(\d{6,7})[- \/]?(\d?)\b/;
    /* ISO 6346: the fourth letter is the equipment category - U, J or Z. That
       keeps an invoice number such as NLIC0126788 (four letters, seven digits)
       from being taken for a container and opening a group of its own. */
    const isContainerNo = c => /^[A-Z]{3}[UJZ]\d{7}$/.test(c);
    const REF_ANY = /\b(\d{9,11})\b/;

    /* What a charge is about. A container is only one kind of unit: a road
       invoice names a trailer or a licence plate, a rail invoice a wagon, an air
       invoice its waybill, a sea invoice sometimes only its B/L. A container's
       format proves itself; every other unit needs its label in front of it, so
       a phone or order number is never taken for one. */
    const UNIT_KINDS = {
        container: { label: 'Container', modality: '' },   // travels by ship, truck and train alike
        awb:       { label: 'AWB',       modality: 'air' },
        wagon:     { label: 'Wagon',     modality: 'rail' },
        trailer:   { label: 'Trailer',   modality: 'road' },
        plate:     { label: 'Kenteken',  modality: 'road' },
        cmr:       { label: 'CMR',       modality: 'road' },
        bl:        { label: 'B/L',       modality: 'sea' }
    };
    const UNIT_NO = '\\s*(?:n[or]\\.?|nummer|number|nr\\.?)?\\s*[:#]?\\s*';
    const upperWithDigit = v => v === v.toUpperCase() && /\d/.test(v);
    const LABELLED_UNITS = [
        { kind: 'awb', re: new RegExp('\\b(?:[mh]?awb|air\\s*waybill|luchtvrachtbrief)' + UNIT_NO + '(\\d{3}[- ]?\\d{4}[- ]?\\d{4})\\b', 'i'),
          norm: v => v.replace(/\D/g, '').replace(/^(\d{3})(\d{8})$/, '$1-$2') },
        { kind: 'wagon', re: new RegExp('\\b(?:wagon|wagen|waggon|wagonnummer|wagennummer)' + UNIT_NO + '(\\d{2} ?\\d{2} ?\\d{4} ?\\d{3}[- ]?\\d)\\b', 'i'),
          norm: v => v.replace(/\D/g, '') },
        { kind: 'trailer', re: new RegExp('\\b(?:trailer|oplegger|auflieger)' + UNIT_NO + '([A-Z0-9]{1,4}(?:-[A-Z0-9]{1,4}){0,3})\\b', 'i'),
          ok: v => upperWithDigit(v) && v.replace(/-/g, '').length >= 3 },
        { kind: 'plate', re: new RegExp('\\b(?:kenteken|licen[cs]e\\s*plate|kennzeichen|plaque|truck\\s*(?:no|nr))' + UNIT_NO + '([A-Z0-9]{1,3}(?:-[A-Z0-9]{1,4}){1,3}|[A-Z0-9]{5,8})\\b', 'i'),
          ok: v => upperWithDigit(v) && /[A-Z]/.test(v) },
        { kind: 'cmr', re: new RegExp('\\bCMR' + UNIT_NO + '([A-Z0-9][A-Z0-9-]{3,})\\b', 'i'), ok: v => /\d/.test(v) },
        { kind: 'bl', re: new RegExp('\\b(?:B\\/L|bill\\s*of\\s*lading|cognossement|[HM]BL)' + UNIT_NO + '([A-Z]{2,4}\\d{6,}[A-Z0-9]*)\\b', 'i'),
          ok: v => v === v.toUpperCase() }
    ];

    /* The first unit named in a piece of text: { kind, value, text } or null.
       text is what stands on the page, so it can be cut out of a description. */
    function unitIn(text) {
        const s = String(text || '');
        const cm = CONTAINER_ANY.exec(s);
        if (cm) {
            const c = (cm[1] + cm[2] + (cm[3] || '')).replace(/\s+/g, '').toUpperCase();
            if (isContainerNo(c)) return { kind: 'container', value: c, text: cm[0] };
        }
        for (const u of LABELLED_UNITS) {
            const m = u.re.exec(s);
            if (!m || !(u.ok ? u.ok(m[1]) : /\d/.test(m[1]))) continue;
            return { kind: u.kind, value: (u.norm ? u.norm(m[1]) : m[1]).toUpperCase(), text: m[0] };
        }
        return null;
    }

    /* Units and column leftovers, in the languages these invoices come in. This
       is a vocabulary, not a supplier template - it says nothing about who sent
       the document. */
    const UNIT_WORD = /^(ton|kg|kgs|cbm|inspection|inspectie|document|doc|seal|zegel|container|ctr|cnt|piece|pieces|stuk|stuks|uur|uren|hour|hours|dag|dagen|day|days|unit|uni|pallet|pallets|hc|bl|bil|fix|bx|week|maand|month|sticker|st|x|à|a|per|eur|€|%)$/i;

    const MONTHS = 'jan|feb|mar|mrt|apr|may|mei|jun|jul|aug|sep|oct|okt|nov|dec';
    const DATE_IN_TEXT = new RegExp(
        '\\b\\d{1,2}[-/. ]\\s?(?:' + MONTHS + ')[a-z]*\\.?[-/. ]\\s?\\d{2,4}\\b'      // 10. Sep. 2026, 06-SEP-26
      + '|\\b(?:' + MONTHS + ')[a-z]*\\.? \\d{1,2},? \\d{4}\\b'                       // Sep 11, 2026
      + '|\\b\\d{1,2}[-/.]\\d{1,2}[-/.]\\d{2,4}\\b', 'i');                          // 10-09-2026

    const DATE_CELL = new RegExp('^(?:' + DATE_IN_TEXT.source + ')$', 'i');

    function cleanDescription(text, container) {
        let t = String(text || '')
            .replace(new RegExp(MONEY_TOKEN.source, 'g'), ' ')
            .replace(/\(\s*%?\s*\)/g, ' ')                  // "( 13,00 %)" once the figure is gone
            .replace(/\s{2,}/g, ' ')
            .trim();

        /* A charge row runs on into its period and the rate columns:
           "Demurrage Fee 10. Sep. 2026 10. Sep. 2026 1 DAY EUR DK VAT 0%".
           The name of the charge is what stands before the first date. Only cut
           when a real word precedes it (a row that starts with its dates, like
           CMA CGM, is left alone and gets its heading instead), and only when
           currency or VAT columns follow - so "Opslag 01-09-2026 t/m 07-09-2026"
           keeps its period. */
        const firstDate = DATE_IN_TEXT.exec(t);
        if (firstDate && /[A-Za-z]{3}/.test(t.slice(0, firstDate.index))) {
            const after = t.slice(firstDate.index);
            if (/\b(EUR|USD|GBP|DKK|SEK|NOK|CHF|PLN|JPY|CNY|VAT|BTW|TVA|MWST)\b|\d\s?%/i.test(after)) t = t.slice(0, firstDate.index);
        }

        // the unit as it stands on the page: "Kenteken OV-12-AB", "MAWB 176-12345675"
        if (container) t = t.replace(new RegExp(container.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'), 'gi'), ' ');
        t = t.replace(/\b[A-Z]{4}[- ]?\d{6,7}[- \/]?\d?\b/g, ' ');     // any other container
        t = t.replace(/\s{2,}/g, ' ').trim();

        let tokens = t.split(/\s+/).filter(Boolean);

        // leading noise: dates, our own reference numbers, row numbers
        while (tokens.length && (/^\d{1,4}([-/.]\w+)?$/.test(tokens[0]) || /^\d{5,}$/.test(tokens[0]))) tokens.shift();

        /* Trailing noise is the quantity, unit, currency and VAT columns. Strip
           them, but never two numbers in a row on their own: in "LAB salmonella
           MM 57  2,000 inspection 0" the 57 is part of the name, while in
           "Carrier Haulage Fee 1 USD 0,895365 USD" every trailing token is a
           column. The difference is what stands next to the number. */
        const isNum = t => /^[\d.,]+$/.test(t);
        const isCur = t => /^(eur|usd|gbp|dkk|chf|sek|nok|pln|€|\$)$/i.test(t);
        const last = () => tokens[tokens.length - 1];

        let previous = null;
        for (let i = 0; i < 6 && tokens.length > 1; i++) {
            const t = last();
            if (isCur(t)) { tokens.pop(); previous = 'currency'; continue; }
            // the "x" of "1,00 x 82,50" once its figures are gone: "Keuren x"
            if (/^(x|×|\*|à|@)$/i.test(t)) { tokens.pop(); previous = 'unit'; continue; }
            if (UNIT_WORD.test(t) && tokens.length > 2 && isNum(tokens[tokens.length - 2])) {
                tokens.pop(); previous = 'unit'; continue;
            }
            if (isNum(t) && (previous === null || previous === 'currency' || previous === 'unit')) {
                tokens.pop(); previous = 'number'; continue;
            }
            break;
        }

        return tokens.join(' ')
            .replace(/^[\s.,:;/-]+/, '')
            .replace(/\s*\([^)]*$/, '')          // dangling "(1 à" from a split cell
            .replace(/[\s.,:;(–-]+$/, '')
            .trim();
    }

    const CURRENCY_RE = /\b(EUR|USD|GBP|DKK|SEK|NOK|CHF|PLN|JPY|CNY)\b/g;

    /* An invoice is in one currency; a tax-reporting appendix may restate it in
       another. Rows written only in that other currency are not charges we book,
       so they are left out - otherwise a Danish tax annex doubles the invoice. */
    function dominantCurrency(rows) {
        const count = new Map();
        rows.forEach(row => {
            if (!moneyCellsOf(row).length) return;
            const seen = new Set((row.raw.match(CURRENCY_RE) || []).map(c => c.toUpperCase()));
            seen.forEach(c => count.set(c, (count.get(c) || 0) + 1));
        });
        /* On a tie, the currency named in the headings wins - "Netto bedrag
           (EUR)", "Invoice Currency(EUR)" - rather than whichever table happens
           to come first in the file. */
        const named = new Map();
        rows.forEach(row => {
            if (moneyCellsOf(row).length) return;
            (row.raw.match(CURRENCY_RE) || []).forEach(c => named.set(c.toUpperCase(), (named.get(c.toUpperCase()) || 0) + 1));
        });
        let best = null, bestCount = 0;
        count.forEach((n, c) => {
            if (n > bestCount || (n === bestCount && (named.get(c) || 0) > (named.get(best) || 0))) { best = c; bestCount = n; }
        });
        return bestCount >= 2 ? best : null;
    }

    /* Some PDFs draw the amount column as its own text block, so a charge ends
       up split over two rows: the wording on one, the figures just below it. A
       row without any words is never a charge of its own, so it belongs to the
       row above. */
    function mergeOrphanAmountRows(rows) {
        /* "42.00 EUR 294.00" is still just figures: a currency code on its own
           does not make a row a line of text. */
        const hasWords = r => /[A-Za-z]{3}/.test(r.raw.replace(CURRENCY_RE, ''));
        const merged = [];

        rows.forEach(row => {
            if (hasWords(row) || !moneyCellsOf(row).length) {
                merged.push({ y: row.y, cells: row.cells.slice(), raw: row.raw });
                return;
            }

            /* Walk back over any wordless rows in between - a lone footnote
               marker often sits between the wording and its amounts - and attach
               to the nearest line of text just above, but only if it is close
               enough on the page to belong to the same line. */
            let target = null;
            for (let i = merged.length - 1; i >= 0 && merged.length - i <= 4; i--) {
                if (!hasWords(merged[i])) continue;
                if (Math.abs(merged[i].y - row.y) <= 20) target = merged[i];
                break;
            }

            if (!target) {
                merged.push({ y: row.y, cells: row.cells.slice(), raw: row.raw });
                return;
            }
            target.cells = target.cells.concat(row.cells).sort((a, b) => a.x - b.x);
            target.raw = target.cells.map(c => c.text).join(' ');
        });

        return merged;
    }

    function structuredParse(allRows) {
        const rows = mergeOrphanAmountRows(allRows);
        const mainCurrency = dominantCurrency(rows);
        const col = findMoneyColumn(rows);
        const tolerance = 60;

        /* A PDF has real columns, so the amounts line up and the column is worth
           trusting. Text copied out of a PDF loses that alignment - the amount
           can even come first. When the column gets few votes, fall back to
           "the last amount on the row" instead of throwing the row away. */
        const useColumn = col.x !== null && col.count >= 3;
        const groups = [];
        const labelledTotals = [];
        const skippedVat = [];
        let current = null;

        /* Some carriers put the name of the charge above its block and the
           table row holds only dates, codes and figures:
               (C) Terminal full storage at destination
               Container Number: SEGU9505570 ...
               02-SEP-26  08-SEP-26  C2  7  Calendar  42.00  EUR  294.00
           The row is still read as a charge exactly as before; only when its own
           description has no real word in it is the heading used instead. */
        const MONTH_DATE = /^\d{1,2}[-/. ]?(jan|feb|mar|apr|may|mei|jun|jul|aug|sep|oct|okt|nov|dec)[a-z]*[-/. ]?\d{0,4}$/i;
        const TABLE_WORD = /^(calendar|kalender|type|tax|btw|vat|rate|from|to|date)$/i;
        const isWeakDesc = d => !String(d).split(/\s+/).some(t =>
            /[a-z]{3,}/i.test(t) && !MONTH_DATE.test(t) && !UNIT_WORD.test(t)
            && !TABLE_WORD.test(t) && !new RegExp('^' + CURRENCY_RE.source + '$', 'i').test(t));
        const headingOf = row => {
            if (!row || moneyCellsOf(row).length || /:/.test(row.raw)) return '';
            const t = row.raw.replace(/^\([A-Z]\)\s*/, '').trim();
            return (t.match(/[A-Za-z]{3,}/g) || []).length >= 2 ? t : '';
        };

        /* A label and its amount are one line on the page, but they can reach us
           as two rows: MSC writes "Total excl. VAT" and the 600,00 beside it with
           baselines half a point apart, and rows are grouped on the baseline. The
           label then ends up in a row with no amount, and its amount in a row with
           no label - which is read as a charge, so the invoice totals three times
           what it says. Before booking, look at what else is on this line.
           Only a hair of difference counts: lines sit further apart than this. */
        const SAME_LINE_Y = 2.5;
        const sameLineRows = i => {
            const out = [];
            for (let j = Math.max(0, i - 3); j <= Math.min(rows.length - 1, i + 3); j++) {
                if (j !== i && Math.abs(rows[j].y - rows[i].y) <= SAME_LINE_Y) out.push(rows[j]);
            }
            return out;
        };
        const totalLabelBeside = i => sameLineRows(i).some(r =>
            !moneyCellsOf(r).length && TOTAL_DESC.test(r.raw.trim()));

        /* "600,00 EUR @ 0 % VAT   EUR 0,00" states what the VAT was worked out
           over. The 600,00 is the basis, not a charge of its own. */
        const VAT_RATE_ROW = /@\s*\d+(?:[.,]\d+)?\s*%\s*(?:vat|btw|tva|mwst|ust|iva|moms|tax)\b/i;

        const newGroup = (unit, ref, heading) => {
            current = { container: unit && unit.kind === 'container' ? unit.value : '', unit: unit || null,
                        ref: ref || '', heading: heading || '', lines: [], containers: [] };
            groups.push(current);
            return current;
        };

        rows.forEach((row, rowIndex) => {
            /* The amount is the rightmost money on the row. Voting on a column
               sounds cleverer but goes wrong the moment a document holds two
               tables with different layouts (a charge table and a tax
               specification): the vote then lands on the wrong column and every
               line shows the day rate instead of what is owed. */
            const money = moneyCellsOf(row);

            if (mainCurrency) {
                const currencies = new Set((row.raw.match(CURRENCY_RE) || []).map(c => c.toUpperCase()));
                if (currencies.size && !currencies.has(mainCurrency)) return;   // foreign-currency annex
            }

            const inColumn = money.slice(-1);

            // What the row is about: a container, trailer, wagon, waybill...
            const unit = unitIn(row.raw);
            const strip = unit ? unit.text : '';

            // A row that names a unit but carries no amount introduces a new group.
            if (!inColumn.length) {
                if (unit) {
                    const rest = row.raw.replace(unit.text, '');
                    const rm = new RegExp(SHIPMENT_ID_RE.source).exec(rest) || REF_ANY.exec(rest);
                    newGroup(unit, rm ? rm[1] : '', headingOf(rows[rowIndex - 1]));
                }
                return;
            }

            const amount = inColumn[inColumn.length - 1].value;
            const amountX = inColumn[inColumn.length - 1].x;
            if (!amount) return;                    // zero says nothing; negative is a credit

            // Description: the text to the left of the amount, minus pure numbers.
            /* The description is the wordy part of the row. In a PDF it sits to
               the left of the amount; in text copied out of a PDF the amount often
               comes first ("53,50 0 Delta-toeslag"). So look at both sides and
               take whichever actually reads like words. */
            const left = row.cells.filter(c => c.x < amountX - 1);
            const right = row.cells.filter(c => c.x > amountX + 1);

            const leadingCells = cells => {
                const out = [];
                for (const c of cells) {
                    const t = c.text.trim();
                    // a cell that is only a date is a date column, like a number
                    if (/^[\d.,]+$/.test(t) || UNIT_WORD.test(t) || DATE_CELL.test(t)) { if (out.length) break; else continue; }
                    out.push(t);
                }
                return out;
            };

            const letters = t => (String(t).match(/[a-z]/gi) || []).length;
            const candidates = [
                cleanDescription(leadingCells(left).join(' '), strip),
                cleanDescription(leadingCells(right).join(' '), strip),
                cleanDescription(left.map(c => c.text).join(' '), strip),
                cleanDescription(right.map(c => c.text).join(' '), strip)
            ];
            let desc = candidates.reduce((best, c) => (letters(c) > letters(best) ? c : best), '');

            /* A heading above the figures could serve as the description when the
               row itself says only "EUR" or a date. Tried, and reverted: it also
               let footer and total rows through as charges, and a wrong total is
               worse than a thin description. The description can be edited in the
               review screen; the amount has to be right. */
            if (desc.length < 3) return;

            /* A total that equals the only charge cannot be told apart by
               arithmetic: 230 + 230 + 230 has no line that is the sum of the
               others. So a row whose description starts with a total word is
               never booked; its amount is kept to check the charges against. */
            if (TOTAL_DESC.test(desc)) { labelledTotals.push(round2(amount)); return; }

            /* The same total, with its label in a row of its own: the amount is
               that label's, not of whatever text happened to land beside it. */
            if (totalLabelBeside(rowIndex)) { labelledTotals.push(round2(amount)); return; }

            // A row stating a VAT rate is the tax specification, never a charge.
            if (VAT_RATE_ROW.test(row.raw)) return;

            /* We book everything at 0% VAT, so a VAT line on the invoice is never
               a cost for us. It is remembered, so the charges can still be checked
               against a total that includes it, and shown as skipped. */
            if (VAT_DESC.test(desc)) {
                // "VAT applied as indicated on charges ... Total Excluding Tax" is a total
                if (/\b(?:totaal|total|totale)\b/i.test(desc)) labelledTotals.push(round2(amount));
                else skippedVat.push(round2(amount));
                return;
            }

            if (current && current.heading && isWeakDesc(desc)) desc = current.heading;

            // quantity x unit price = amount, when the row shows both
            /* If the row shows a quantity and a unit price, keep them: reading
               "17,82 ton x 13,77" beats a flat 245,38 on the booking. They are
               taken in the order they appear, so the quantity stays the quantity. */
            let qty = 1, unitPrice = amount;
            const numbersInRow = [];
            row.cells.filter(c => c.x < amountX - 1).forEach(c => {
                const re = /\d[\d.,]*/g;
                let m;
                while ((m = re.exec(c.text))) {
                    const v = parseAmount(m[0]);
                    if (!isNaN(v) && v > 0) numbersInRow.push({ value: v, x: c.x, at: m.index });
                }
            });
            /* Only accept a quantity x unit price pair when it reads like one:
               a countable quantity and a price in cents. An exchange rate also
               multiplies out to the amount (620,00 USD x 0,895365 = 555,13 EUR)
               but is neither - taking it would book 620 units at 90 cents. */
            const plausibleQty = v => Math.abs(v) > 0 && Math.abs(v) <= 100000
                && Math.abs(v * 1000 - Math.round(v * 1000)) < 1e-6;
            const plausiblePrice = v => Math.abs(v) > 0 && Math.abs(v * 100 - Math.round(v * 100)) < 1e-6;
            outer:
            for (let i = 0; i < numbersInRow.length; i++) {
                for (let j = i + 1; j < numbersInRow.length; j++) {
                    const a = numbersInRow[i].value, b = numbersInRow[j].value;
                    if (a === amount || b === amount) continue;
                    if (!plausibleQty(a) || !plausiblePrice(b)) continue;
                    if (Math.abs(a * b - amount) < 0.02) { qty = a; unitPrice = b; break outer; }
                    // a credit note shows the quantity positive and the amount negative
                    if (Math.abs(a * b + amount) < 0.02) { qty = Math.abs(a); unitPrice = -Math.abs(b); break outer; }
                }
            }

            /* A charge row naming another unit of the same kind is another
               transport: a trucker lists one trailer or container per row, each
               for its own shipment. A unit of a different kind (a container under
               a B/L heading) only adds to the group it stands in. */
            if (!current) newGroup(unit, '');
            else if (unit && current.unit && current.unit.kind === unit.kind && current.unit.value !== unit.value) newGroup(unit, '');
            else if (unit && !current.unit) current.unit = unit;
            if (unit && unit.kind === 'container' && !current.container) current.container = unit.value;
            current.lines.push({
                desc, qty: round2(qty), unitPrice: round2(unitPrice), amount: round2(amount),
                row: row.raw,
                // A charge row that carries the unit is the transport line itself,
                // which is worth knowing when nothing in its wording says so
                // ("ECT Delta - Nijkerk").
                isTransportRow: !!unit
            });
        });

        const result = groups.filter(g => g.lines.length);
        result.labelledTotals = labelledTotals;
        result.skippedVat = skippedVat;
        return result;
    }

    /* The VAT charged over this invoice's own services. Import VAT that an agent
       paid to customs on our behalf ("Import VAT", "BTW bij invoer") is money we
       owe them and is booked like any disbursement, at 0% - so it is not here. */
    const VAT_DESC = /^(?:btw|b\.t\.w\.?|vat|tva|mwst|ust|iva|moms|omzetbelasting|belasting|sales tax)\b(?!.*\b(?:invoer|import|douane|customs)\b)/i;
    const TOTAL_DESC = /^(?:sub-?\s?)?(?:totaal|total|totale|summe|gesamt)\b|^(?:te betalen|amount due|balance due|grand total|net amount|invoice total|nettobetrag|montant total)\b/i;

    /* A row whose amount equals the sum of the rows above it is a total, not a
       charge. Peel those off - that is how the totals are found without relying
       on the word for "total" in any particular language. */
    function peelTotals(group) {
        const totals = [];
        for (let guard = 0; guard < 6; guard++) {
            if (group.lines.length < 2) break;
            const last = group.lines[group.lines.length - 1];
            const rest = group.lines.slice(0, -1).reduce((s, l) => s + l.amount, 0);
            if (Math.abs(last.amount - rest) < 0.02) {
                totals.push(group.lines.pop().amount);
                continue;
            }
            break;
        }
        return totals;
    }

    /* -------------------------------------------------------------------------
       Number formats: Dutch invoices write 1.234,56 and English ones 1,234.56.
       Decide per string which separator is the decimal one.
       ------------------------------------------------------------------------- */
    function parseAmount(str) {
        const raw = String(str).trim();
        const bracketed = /^\(.*\)$/.test(raw);           // (335,00) means -335,00
        let t = raw.replace(/[^\d.,-]/g, '');
        if (!t) return NaN;
        const negative = bracketed || /^-/.test(t);
        t = t.replace(/-/g, '');
        const lastComma = t.lastIndexOf(','), lastDot = t.lastIndexOf('.');
        if (lastComma > lastDot) t = t.replace(/\./g, '').replace(',', '.');       // 1.234,56
        else if (lastDot > lastComma) t = t.replace(/,/g, '');                      // 1,234.56
        else t = t.replace(',', '.');
        const n = parseFloat(t);
        if (isNaN(n)) return NaN;
        return negative ? -n : n;
    }

    const MONEY = '[\\d][\\d.,]*';
    // OERU-422507-2 and OERU4225072 are the same box
    const CONTAINER_RE = /\b([A-Z]{4})[- ]?(\d{6,7})[- \/]?(\d?)\b/g;
    /* FitOn shipment ids: ten digits, the first one says what kind of file it
       is - 1002... sea freight, 2002... road, 3002... air. All three are found
       under "Shipment id" on the Search page. 4003... is an invoice file and is
       not a shipment, so it is not taken. */
    /* A cost is always booked on a shipment whose number starts 1002 (sea and
       air), 2002 (road) or 3002. Accepting 100 followed by anything took MSC's
       customer number 1001467713 for a shipment id on every one of their
       invoices, so every one of them was looked up under a number FitOn does
       not have. */
    const SHIPMENT_ID_RE = /\b([123]002\d{6})\b/g;
    const isShipmentId = v => /^[123]002\d{6}$/.test(String(v || ''));
    const SHIPMENT_MODALITY = { 1: 'sea', 2: 'road', 3: 'air' };
    const MODALITY = { sea: 'Zeevracht', road: 'Wegtransport', rail: 'Spoortransport', air: 'Luchtvracht' };

    /* The words on a document, as a last resort for how it travelled. Counted,
       not first-found: a sea invoice also mentions trucking, just less often. */
    const MODALITY_WORDS = [
        ['air',  /\b(?:air\s*freight|airfreight|luchtvracht|[mh]?awb|air\s*waybill|airport|luchthaven|flight)\b/gi],
        ['rail', /\b(?:rail|railway|spoor|spoorvervoer|spoortransport|trein|train|bahn|schiene\w*|wagon|wagen|waggon)\b/gi],
        ['sea',  /\b(?:ocean\s*freight|sea\s*freight|zeevracht|vessel|voyage|bill\s*of\s*lading|b\/l|rederij)\b/gi],
        ['road', /\b(?:wegtransport|road\s*freight|trucking|truck|vrachtwagen|oplegger|trailer|cmr|chauffeur|kenteken|maut|tol|lkw)\b/gi]
    ];
    function modalityFromWords(text) {
        let best = '', bestCount = 0, tie = false;
        MODALITY_WORDS.forEach(([mode, re]) => {
            const n = (String(text || '').match(re) || []).length;
            if (n > bestCount) { best = mode; bestCount = n; tie = false; }
            else if (n && n === bestCount) tie = true;
        });
        return tie ? '' : best;
    }

    /* Our shipment id says it for certain, then the unit, then the words. */
    function modalityOf(t, fallback) {
        if (isShipmentId(t.ref)) return SHIPMENT_MODALITY[t.ref[0]];
        const kind = t.unit && UNIT_KINDS[t.unit.kind];
        return (kind && kind.modality) || fallback || '';
    }

    /* A transport by the name FitOn and the reader know it: the container, else
       the unit, else the shipment or dossier number. Worklists saved before
       units existed carry only a container and a reference; this reads both. */
    const transportName = t => (t && (t.container || (t.unit && t.unit.value) || t.ref)) || '';
    const unitKey = t => t.container ? 'container:' + t.container : t.unit ? `${t.unit.kind}:${t.unit.value}` : '';

    /* Everything else known about it, for the review screen and the report:
       ["Kenteken", "shipment 2002004059", "Wegtransport"]. */
    function transportFacts(t) {
        const name = transportName(t);
        const facts = [];
        if (t.container) facts.push('Container');
        if (t.unit && t.unit.kind !== 'container' && UNIT_KINDS[t.unit.kind]) {
            const label = UNIT_KINDS[t.unit.kind].label;
            facts.push(t.unit.value === name ? label : `${label} ${t.unit.value}`);
        }
        if (t.ref) {
            const kind = isShipmentId(t.ref) ? 'shipment' : 'dossier';
            facts.push(t.ref === name ? (kind === 'shipment' ? 'shipment id' : 'dossier') : `${kind} ${t.ref}`);
        }
        const modality = modalityOf(t, t.modality);
        if (modality) facts.push(MODALITY[modality]);
        return facts;
    }
    const normaliseContainer = m => (m[1] + m[2] + (m[3] || '')).toUpperCase();

    // Lines that are never a charge.
    const SKIP_LINE = new RegExp([
        'totaal', 'total', 'subtotaal', 'subtotal', 'sub-total', '\\bnet\\b', '\\bgross\\b',
        'amount due', 'te betalen', 'btw-?(nummer|bedrag|percentage)', 'vat (no|reg|amount|specification)',
        'iban', 'swift', '\\bbank\\b', 'payment', 'betaling', 'invoice no', 'factuurnr', 'factuurnummer',
        'dossiernummer', 'kvk', 'telefoon', 'e-?mail', 'customer', 'klantnr', 'page ', 'pagina',
        'due date', 'vervaldatum', 'vervaldag', 'address', 'tel:', 'www\\.', 'report \\d',
        'straat \\d', 'weg \\d', 'laan \\d', '\\bplein \\d'
    ].join('|'), 'i');

    /* One charge line: a description followed by numbers, the last of which is
       the amount. If the line also carries a quantity and a unit price we keep
       those, so 17,82 ton x 13,77 stays visible on the booking instead of being
       flattened into one figure. */
    function parseChargeLine(line) {
        if (line.length < 6 || SKIP_LINE.test(line)) return null;

        const numbers = [...line.matchAll(new RegExp(MONEY, 'g'))]
            .map(m => ({ raw: m[0], value: parseAmount(m[0]), index: m.index }))
            .filter(n => !isNaN(n.value));
        if (!numbers.length) return null;

        /* An amount is written as money: it has two decimals. Requiring that is
           what separates a charge from a phone number, a postcode, a KvK number
           or a year - all of which sit in the header of a typical invoice. */
        const moneyMatches = [...line.matchAll(/\d[\d.]*[.,]\d{2}(?!\d)/g)]
            .map(m => ({ value: parseAmount(m[0]), index: m.index }))
            .filter(n => !isNaN(n.value) && n.value !== 0);
        if (!moneyMatches.length) return null;

        const amount = moneyMatches[moneyMatches.length - 1].value;
        if (!(amount > 0)) return null;

        const firstNum = Math.min(numbers[0].index, moneyMatches[0].index);
        let desc = line.slice(0, firstNum).trim()
            .replace(/[\s:;,\-–(]+$/, '')            // trailing punctuation from split cells
            .replace(/\s+(à|a|x)$/i, '')             // "Wachturen lossen (1 à"
            .trim();

        // A transport row starts with a date and carries the container; build a
        // readable description from what sits between them and the amounts.
        if (/^\d{1,2}[-/ ](?:\w{3,}|\d{1,2})/.test(line)) {
            const c = CONTAINER_RE.exec(line);
            CONTAINER_RE.lastIndex = 0;
            const tail = c ? line.slice(c.index + c[0].length, moneyMatches[moneyMatches.length - 1].index) : '';
            const route = tail.replace(/\b\d+\b/g, ' ').replace(/\s{2,}/g, ' ').trim();
            desc = route ? `Transport ${route}` : 'Transport';
        }
        if (desc.length < 3) return null;

        // qty x unitPrice == amount somewhere in the line?
        let qty = 1, unitPrice = amount;
        const usable = numbers.filter(n => n.value !== 0);
        for (let i = 0; i < usable.length - 1; i++) {
            for (let j = i + 1; j < usable.length; j++) {
                const a = usable[i].value, b = usable[j].value;
                if (a > 0 && b > 0 && Math.abs(a * b - amount) < 0.02 && a !== amount && b !== amount) {
                    qty = a; unitPrice = b;
                }
            }
        }
        return { desc, qty: round2(qty), unitPrice: round2(unitPrice), amount: round2(amount) };
    }

    function firstMatch(text, patterns) {
        for (const re of patterns) {
            const m = re.exec(text);
            if (m && m[1]) return m[1].trim();
        }
        return '';
    }

    /* Labels and their values often sit in a grid: the label on one line, the
       value on the line below it in the same column. Reading that needs the
       positions, not another regular expression - so look one row up and one row
       down and take the cell that stands in the same column as the label. */
    function valueNearLabel(rows, labelRe, valueRe, reach = 1) {
        for (let i = 0; i < rows.length; i++) {
            const labelCell = rows[i].cells.find(c => labelRe.test(c.text));
            if (!labelCell) continue;

            /* The line below, in the same column, is the most reliable: a header
               row often carries several labels, so the value standing next to one
               of them may belong to the label after it. */
            const below = [];
            for (let k = 1; k <= reach; k++) below.push(rows[i + k]);
            for (const neighbour of [...below, rows[i - 1]]) {
                if (!neighbour) continue;
                const aligned = neighbour.cells
                    .filter(c => valueRe.test(c.text))
                    .filter(c => Math.abs(c.x - labelCell.x) < 90)
                    .sort((a, b) => Math.abs(a.x - labelCell.x) - Math.abs(b.x - labelCell.x))[0];
                if (aligned) return aligned.text.trim();
            }

            // Only then the cell immediately after the label on the same line.
            const after = rows[i].cells.filter(c => c.x > labelCell.x)
                .sort((a, b) => a.x - b.x)[0];
            if (after && valueRe.test(after.text)) return after.text.trim();
        }
        return '';
    }

    function parseInvoiceRows(rows, imageHashes) {
        const text = rows.map(r => r.raw).join('\n');
        const marks = documentMarks(text, imageHashes);

        const groups = [];
        const parsedGroups = structuredParse(rows);
        const labelledTotals = parsedGroups.labelledTotals || [];
        const skippedVat = parsedGroups.skippedVat || [];
        /* VAT is a share of the charges, so a "VAT" amount larger than all the
           charges together is something else; it is left out of the VAT sum. */
        const netOfCharges = parsedGroups.reduce((a, g) => a + g.lines.reduce((b, l) => b + l.amount, 0), 0);
        const vatSum = round2(skippedVat.filter(v => Math.abs(v) <= Math.abs(netOfCharges) + 0.01).reduce((a, v) => a + v, 0));
        parsedGroups.forEach(g => {
            /* A carrier invoice repeats the container above every charge block;
               that is still one container, not three. Merged only when the
               reference matches too, so two transports of one box stay apart. */
            const key = unitKey(g);
            const same = key && groups.find(x => unitKey(x) === key && x.ref === g.ref);
            if (same) same.lines.push(...g.lines);
            else groups.push(g);
        });

        let statedTotal = null;

        /* A grand total often sits at the bottom of the last block and gets read
           as one more charge. It gives itself away: it equals everything else
           added together, so the sum including it is exactly twice its value. */
        const allLines = () => groups.flatMap(g => g.lines);
        const distinct = [...new Set(allLines().map(l => l.amount))].sort((a, b) => b - a);
        for (const v of distinct) {
            const rest = round2(allLines().filter(l => Math.abs(l.amount - v) > 0.001)
                                          .reduce((s, l) => s + l.amount, 0));
            if (Math.abs(rest) > 0 && Math.abs(rest - v) < 0.02) {
                // v equals everything else together, so every line showing v is a
                // total line - invoices often print it twice (net and payable).
                statedTotal = v;
                groups.forEach(g => { g.lines = g.lines.filter(l => Math.abs(l.amount - v) > 0.001); });
                break;
            }
        }
        groups.forEach(g => {
            const t = peelTotals(g);
            g.subtotal = t.length ? t[t.length - 1] : null;
            g.total = round2(g.lines.reduce((sum, l) => sum + l.amount, 0));
        });

        let calcTotal = round2(groups.reduce((sum, g) => sum + g.total, 0));
        /* The tax annex in another currency (Maersk: DKK) is left out of the
           charges already; leave it out here too, or its total becomes "the
           amount the document names" and the check fails on a correct read. */
        const mainCurrency = dominantCurrency(rows);
        const inMainCurrency = row => {
            if (!mainCurrency) return true;
            const cs = new Set((row.raw.match(CURRENCY_RE) || []).map(c => c.toUpperCase()));
            return !cs.size || cs.has(mainCurrency);
        };
        const moneyOnPage = rows.filter(inMainCurrency).flatMap(moneyCellsOf).map(m => m.value);
        const matches = v => moneyOnPage.some(x => Math.abs(x - v) < 0.02);

        /* Multi-page invoices repeat their lines - a summary page, a copy, a tax
           specification. If the total we read is not on the page but the total
           after removing repeats is, the repeats were duplicates. Only then do we
           drop them, so a genuine twice-charged line is never silently removed. */
        if (!matches(calcTotal)) {
            const deduped = groups.map(g => {
                const seen = new Set();
                const lines = g.lines.filter(l => {
                    const key = l.desc + '|' + l.amount;
                    if (seen.has(key)) return false;
                    seen.add(key);
                    return true;
                });
                return Object.assign({}, g, { lines, total: round2(lines.reduce((s, l) => s + l.amount, 0)) });
            });
            const dedupTotal = round2(deduped.reduce((sum, g) => sum + g.total, 0));
            if (dedupTotal !== calcTotal && matches(dedupTotal)) {
                log(`Repeated lines removed: ${money(calcTotal)} -> ${money(dedupTotal)}`);
                groups.length = 0;
                deduped.forEach(g => groups.push(g));
                calcTotal = dedupTotal;
            }
        }

        // Any money value anywhere that equals the sum of everything we read is
        // the invoice total, whatever it is called on the page.
        const allMoney = moneyOnPage;
        const matchTotal = allMoney.find(v => Math.abs(v - calcTotal) < 0.02);
        /* No subtotal printed, only the total including VAT: the charges plus
           the VAT we skipped must then add up to it. */
        const matchGross = vatSum ? allMoney.find(v => Math.abs(v - (calcTotal + vatSum)) < 0.02) : undefined;
        if (matchTotal !== undefined) statedTotal = round2(matchTotal);
        else if (matchGross !== undefined) statedTotal = calcTotal;
        else {
            // Otherwise the largest value that is not one of the charges is the
            // most likely total - reported, never silently trusted.
            const charges = new Set(groups.flatMap(g => g.lines.map(l => l.amount)));
            const candidates = allMoney.filter(v => !charges.has(v));
            if (candidates.length) statedTotal = round2(Math.max(...candidates));
        }

        let invoiceNo = String(firstMatch(text, [
            /Factuurnr\.?:?\s*([A-Z0-9\/-]{4,})/i,
            /Factuurnummer\s*:?\s*([A-Z0-9\/-]{4,})/i,
            /Invoice\s*(?:no|nr|number)\.?\s*:?\s*([A-Z0-9\/-]{4,})/i,
            /Document\s*N[°o]\s*:?\s*([A-Z0-9\/-]{4,})/i,
            /\bRechnungs?-?(?:nummer|nr\.?)\s*:?\s*([A-Z0-9\/-]{4,})/i,
            /\bRechnung\s+Nr\.?\s*:?\s*([A-Z0-9\/-]{4,})/i,
            /\bFacture\s*n[°o]\.?\s*:?\s*([A-Z0-9\/-]{4,})/i,
            /\bINVOICE\b[^\n]{0,20}?\b([A-Z]{2}\d{6,}[A-Z]?)\b/,
            /\bINVOICE\b\s*(?:ORIGINAL|COPY|DUPLICATE)?\s*\n?\s*([A-Z]{2,4}\d{6,}[A-Z]?)\b/i,
            // value printed before its label
            /\b((?!NL\d{9}B\d{2})[A-Z0-9][A-Z0-9\/-]{4,})\s*\n?\s*Factuurnummer\b/i,
            /\b((?!NL\d{9}B\d{2})[A-Z0-9][A-Z0-9\/-]{4,})\s*\n?\s*Invoice\s*(?:no|number)\b/i,
            /\b((?!NL\d{9}B\d{2})[A-Z0-9][A-Z0-9\/-]{4,})\s*\n?\s*Document\s*N[°o]/i,
            // "Please quote on payment: NL260917824I 1001467713"
            /quote on payment\s*:?\s*([A-Z0-9][A-Z0-9\/-]{4,})/i,
            /(?:vermeld|quote|reference)\D{0,18}([A-Z]{2}\d{6,}[A-Z]?)\b/i
        ]) || '').trim();

        // Whatever matched has to look like an invoice number: it carries digits
        // and is not a VAT number or a stray word from the layout.
        if (invoiceNo && (!/\d{3}/.test(invoiceNo) || /^[A-Z]{2}\d{9}B\d{2}$/i.test(invoiceNo))) invoiceNo = '';

        if (!invoiceNo) {
            invoiceNo = valueNearLabel(
                rows,
                /^(document\s*n[°o]?|factuurnummer|factuurnr\.?|invoice\s*(no|nr|number)\.?)\s*:?$/i,
                /^[A-Z0-9][A-Z0-9\/-]{4,}$/
            );
            if (invoiceNo && (!/\d{3}/.test(invoiceNo) || /^[A-Z]{2}\d{9}B\d{2}$/i.test(invoiceNo))) invoiceNo = '';
        }

        if (!invoiceNo) {
            /* The word INVOICE as a title, with the number printed a few lines
               lower in the same column (CMA CGM puts the B/L line in between). */
            invoiceNo = valueNearLabel(rows, /^(invoice|factuur|facture|rechnung)$/i,
                                       /^[A-Z]{2,4}\d{6,}[A-Z]?$/, 3);
            if (invoiceNo && /^[A-Z]{2}\d{9}B\d{2}$/i.test(invoiceNo)) invoiceNo = '';
        }

        if (!invoiceNo) {
            // Some layouts put the word "Factuur" on one line and the number on
            // the next, with no label at all.
            const near = /^\s*(?:factuur|invoice)\s*$[\r\n]+\s*([A-Z0-9][A-Z0-9\/-]{4,})\s*$/im.exec(text);
            if (near) invoiceNo = near[1];
        }

        /* Whatever route found it, an invoice number contains digits and is not
           our own VAT number or a word from the layout such as "ORIGINAL". */
        if (invoiceNo && (!/\d{3}/.test(invoiceNo) || /^[A-Z]{2}\d{9}B\d{2}$/i.test(invoiceNo))) invoiceNo = '';

        // A labelled reference beats a loose number anywhere on the page.
        /* A payment reference is the invoice number again (Maersk: "PAYMENT
           REFERENCE 7556428189"), so it is never the dossier. */
        // 4003... is a FitOn invoice file, not a shipment: nothing to search on
        const notInvoice = v => v && v !== invoiceNo && !(invoiceNo && invoiceNo.includes(v)) && !/^400\d{7}$/.test(v);
        let labelledRef = [...text.matchAll(/(payment\s+)?(?:Dossiernummer|Dossier|Referentie|Our ref|Your ref|Reference|Shipment)\D{0,14}(\d{9,11})/gi)]
                .filter(m => !m[1] && notInvoice(m[2])).map(m => [m[0], m[2]])[0]
            || [...text.matchAll(/\b(\d{9,11})\s*\n?\s*(?:Dossiernummer|Dossier|Referentie)\b/gi)]
                .filter(m => notInvoice(m[1]))[0];
        if (!labelledRef) {
            const near = valueNearLabel(rows, /^(dossiernummer|dossier|referentie|your ref\.?|reference)\s*:?$/i, /^\d{9,11}$/);
            if (near && notInvoice(near)) labelledRef = [near, near];
        }
        /* Our own shipment id beats any other reference: it is exactly what the
           Search page looks up. Only used when the document names one shipment -
           with several, each group keeps what stands on its own rows. */
        const shipmentIds = [...new Set([...text.matchAll(SHIPMENT_ID_RE)].map(m => m[1]).filter(notInvoice))];
        const pageShipment = shipmentIds.length === 1 ? shipmentIds[0] : '';

        /* A unit named once in the header covers the document when it holds a
           single transport - the waybill of an air invoice, the trailer of a road
           one. A container keeps its old reach: every group without one. */
        const docUnit = unitIn(text);
        const docModality = modalityFromWords(text);
        groups.forEach(g => {
            if (!g.ref && pageShipment) g.ref = pageShipment;
            if (!g.ref && labelledRef) g.ref = labelledRef[1];
            if (docUnit && docUnit.kind === 'container' && !g.container) g.container = docUnit.value;
            if (docUnit && !g.unit && (docUnit.kind === 'container' || groups.length === 1)) g.unit = docUnit;
            g.modality = modalityOf(g, docModality);
        });

        const isCredit = groups.length > 0 && groups.every(g => g.lines.every(l => l.amount < 0)) ;
        let confidence = 'none', note = '';
        if (!groups.length) {
            note = 'Geen kostenregels herkend in dit document.';
        } else if (statedTotal === null) {
            confidence = 'unverified';
            note = 'Geen totaal gevonden om tegen te controleren.';
        } else if (Math.abs(calcTotal - statedTotal) < 0.02) {
            const lineCount = groups.reduce((n, g) => n + g.lines.length, 0);
            const totalRowAgrees = labelledTotals.some(v => Math.abs(v - statedTotal) < 0.02);
            if (lineCount === 1 && Math.abs(groups[0].lines[0].amount - statedTotal) < 0.02 && !totalRowAgrees) {
                // Could be a one-charge invoice, or the total read as a charge.
                // Nothing in the document distinguishes the two, so do not claim
                // it is verified.
                confidence = 'unverified';
                note = 'Er is één bedrag herkend en dat is meteen het totaal — controleer of dit klopt.';
            } else {
                confidence = 'exact';
            }
        } else {
            confidence = 'mismatch';
            note = `De herkende regels tellen op tot ${money(calcTotal)}, het document noemt ${money(statedTotal)} `
                 + `(verschil ${money(round2(calcTotal - statedTotal))}).`;
        }

        return {
            transports: groups, statedTotal, calcTotal, invoiceNo,
            confidence, note, isCredit, skippedVat: vatSum, marks,
            creditor: detectCreditor(text) || creditorByMarks(marks)
        };
    }

    function parseServiceSpec(text) {
        return parseInvoiceRows(rowsFromText(text));
    }

    function buildSpecItems(transport, o) {
        const items = [];
        const who = transportName(transport);
        const ref = [o.invoiceNo, who].filter(Boolean).join(' ').trim();
        const describe = base => (o.descMode === 'invoiceOnly' ? (o.invoiceNo || base)
                                : o.descMode === 'invoice' ? ref
                                : o.descMode === 'both' ? `${ref} - ${base}` : base);

        if (o.combine) {
            /* One line for the lot, on the ledger all its charges share - the
               miscellaneous ledger only when they differ. */
            const ledgers = transport.lines.map(l => ledgerForSpecLine(l.desc, l));
            const shared = ledgers.length && ledgers.every(l => l.id === ledgers[0].id) ? ledgers[0] : LEDGER.misc;
            items.push({
                ledgerId: shared.id, ledgerName: shared.name,
                desc: describe(transport.lines.length === 1 ? transport.lines[0].desc : 'Kosten volgens factuur'),
                qty: 1.000, price: transport.total,
                group: 'Specificatie', creditorSeq: o.creditorSeq || null, creditorName: o.creditorName || ''
            });
        } else {
            transport.lines.forEach(l => {
                const led = ledgerForSpecLine(l.desc, l);
                items.push({
                    ledgerId: led.id, ledgerName: led.name,
                    desc: describe(l.desc), qty: l.qty, price: l.unitPrice,
                    group: 'Specificatie', guessedLedger: ledgerIsGuess(l.desc),
                    creditorSeq: o.creditorSeq || null, creditorName: o.creditorName || ''
                });
            });
        }
        return items;
    }

    /* =========================================================================
       COST DIALOG - carrier template + invoice number
       ========================================================================= */
    function buildCostItems(o) {
        const items = [];
        const ctr = Math.max(1, Math.round(o.containers || 1));
        const carrier = CARRIERS.find(c => c.key === o.carrier);
        const type = CONTAINER_TYPES.find(t => t.key === o.containerType);
        const label = `${carrier ? carrier.name : ''} ${type ? type.label : ''}`.trim();

        const describe = base => {
            if (o.descMode === 'invoice') return o.invoiceNo || base;
            if (o.descMode === 'both') return o.invoiceNo ? `${o.invoiceNo} - ${base}` : base;
            return base;
        };

        const creditorSeq = (o.setCreditor !== false && carrier && carrier.creditorSeq) ? carrier.creditorSeq : null;
        const creditorName = carrier ? carrier.name : '';

        const chosen = CARRIER_CHARGES
            .map(ch => ({ ch, amount: (o.amounts && o.amounts[ch.key]) || 0 }))
            .filter(x => x.amount > 0);

        if (o.combine) {
            const total = chosen.reduce((sum, x) => sum + x.amount, 0);
            if (total > 0) {
                items.push({
                    ledgerId: LEDGER.thc.id, ledgerName: LEDGER.thc.name,
                    desc: describe(`THC ${label}`), qty: ctr, price: round2(total),
                    group: 'Carrier', creditorSeq, creditorName
                });
            }
        } else {
            chosen.forEach(x => items.push({
                ledgerId: x.ch.ledger.id, ledgerName: x.ch.ledger.name,
                desc: describe(x.ch.desc), qty: ctr, price: round2(x.amount),
                group: 'Carrier', creditorSeq, creditorName
            }));
        }

        (o.extraLines || []).forEach(line => {
            if (!line.amount) return;
            items.push({
                ledgerId: LEDGER.misc.id, ledgerName: LEDGER.misc.name,
                desc: describe(line.desc || 'Overige kosten'), qty: 1.000,
                price: round2(line.amount), group: 'Overig'
            });
        });

        return items;
    }

    /* Several invoices at once: a stack of container notes from the same carrier
       is the normal case, and reading them in one at a time means retyping the
       booking settings for every one. Each document keeps its own invoice
       number, creditor and totals check - they are never shared - and the
       shipments of all of them are booked in a single run. */
    function showSpecImportModal(callback) {
        if (document.querySelector('.fip-overlay')) return;

        let prefs = {};
        try { prefs = JSON.parse(localStorage.getItem('fiton_spec_prefs') || '{}'); } catch (e) {}

        const CREDITOR_OPTIONS = CREDITORS.slice().sort((a, b) => a.name.localeCompare(b.name))
            .map(c => `<option value="${esc(c.seq)}" data-name="${esc(c.name)}">${esc(c.name)} (${esc(c.seq)})</option>`).join('');

        const overlay = document.createElement('div');
        overlay.className = 'fip-overlay fip-root';
        overlay.innerHTML = `
        <div class="fip-modal">
            <div class="fip-modal-head">
                <div>
                    <h3>Facturen inlezen</h3>
                    <p>Sleep er één of meer PDF's in — de extensie leest per factuur wie hem stuurde, welke kosten erop staan en bij welke zending ze horen</p>
                </div>
                <button class="fip-modal-close" id="spec-cancel" title="Sluiten (Esc)">&times;</button>
            </div>

            <div class="fip-modal-body">
                <div class="fip-card">
                    <div class="fip-card-title">Documenten <span class="fip-count" id="spec-doccount">0</span></div>
                    <div class="fip-drop" id="spec-drop">
                        <div class="fip-drop-icon">📄</div>
                        <div><b>Sleep hier je facturen</b> of <label class="fip-drop-link">kies bestanden<input type="file" id="spec-file" accept=".pdf,.txt" multiple hidden></label></div>
                        <div class="fip-hint">Meerdere tegelijk mag: een stapel containernota's van dezelfde rederij gaat in één keer. Elke leverancier en elke vervoerswijze — rederij, transporteur, spoor, luchtvracht, koelhuis, keurpunt. PDF wordt direct gelezen, geen OCR en geen upload.</div>
                    </div>
                    <div id="spec-docs"></div>
                    <details class="fip-details">
                        <summary>of tekst plakken</summary>
                        <textarea id="spec-text" class="fip-textarea" rows="4"
                            placeholder="Plak hier de tekst van de factuur…"></textarea>
                    </details>
                    <div class="fip-hint" id="spec-status">Nog geen factuur ingelezen.</div>
                </div>

                <div class="fip-banner" id="spec-confidence" style="display:none;"></div>

                <div class="fip-card" id="spec-result-card" style="display:none;">
                    <div class="fip-card-title">Gevonden kosten <span class="fip-count" id="spec-count">0</span></div>
                    <div class="fip-scroll"><table class="fip-table" id="spec-table"></table></div>
                </div>

                <div class="fip-card">
                    <div class="fip-card-title">Boeken</div>
                    <div class="fip-grid">
                        <div class="fip-field">
                            <label>Omschrijving</label>
                            <select id="spec-descmode">
                                <option value="both" ${(prefs.descMode || 'both') === 'both' ? 'selected' : ''}>Factuur + zending + kostensoort</option>
                                <option value="invoice" ${prefs.descMode === 'invoice' ? 'selected' : ''}>Alleen factuur + zending</option>
                                <option value="invoiceOnly" ${prefs.descMode === 'invoiceOnly' ? 'selected' : ''}>Alleen factuurnummer</option>
                                <option value="name" ${prefs.descMode === 'name' ? 'selected' : ''}>Alleen kostensoort</option>
                            </select>
                            <div class="fip-hint">Factuurnummer en crediteur staan per document hierboven.</div>
                        </div>
                    </div>
                    <div class="fip-checklist" style="margin-top:10px;">
                        <label class="fip-check"><input type="radio" name="spec-combine" value="split" ${prefs.combine ? '' : 'checked'}>
                            <span>Aparte regel per kostensoort</span></label>
                        <label class="fip-check"><input type="radio" name="spec-combine" value="combine" ${prefs.combine ? 'checked' : ''}>
                            <span>Eén totaalregel per zending</span></label>
                    </div>
                    <div class="fip-checklist" style="margin-top:8px;">
                        <label class="fip-check"><input type="checkbox" id="spec-ignore-existing">
                            <span>Ook boeken als dezelfde bedragen al op de zending staan</span></label>
                    </div>
                    <div class="fip-hint">Uit (standaard): een zending waar het factuurnummer, het factuurtotaal of alle bedragen al op staan, wordt overgeslagen en in het eindrapport gemeld.</div>
                </div>
            </div>

            <div class="fip-modal-foot">
                <label class="fip-check" id="spec-override-wrap" style="display:none; margin:0 8px 0 0;">
                    <input type="checkbox" id="spec-override"><span style="font-size:11.5px;">Toch boeken</span>
                </label>
                <button type="button" class="fip-btn fip-btn-ghost fip-btn-sm" id="spec-copy">Overzicht kopiëren</button>
                <div class="fip-foot-total">
                    <span id="spec-sel-label">Geen zending gekozen</span>
                    <strong id="spec-sel-total">${money(0)}</strong>
                </div>
                <button type="button" class="fip-btn fip-btn-primary" id="spec-submit" disabled>Boek selectie</button>
            </div>
        </div>`;

        document.body.appendChild(overlay);
        enableModalResize(overlay, 'fiton_modal_size_spec');

        const $ = id => document.getElementById(id);

        /* One entry per document read in. Nothing here is shared between them:
           two invoices from the same carrier still each carry their own number. */
        let docs = [];
        let docSeq = 0;
        /* Dropping a second stack while the first is still being read must not
           throw it away, so reads queue behind each other. */
        let reading = Promise.resolve();

        // The shipment reference on the page tells us which container to pick.
        const pageText = (document.body && document.body.innerText) || '';

        const docTransports = () => docs.reduce((all, d) => all.concat(
            (d.parsed.transports || []).map(tr => ({ doc: d, tr }))), []);
        const chosenPairs = () => docTransports().filter(p => p.tr.pick);
        const docTotal = d => (d.parsed.transports || []).reduce((a, tr) => a + tr.total, 0);

        /* ---------- reading documents ---------- */

        function makeDoc(name, kind, parsed, file) {
            docSeq++;
            const d = {
                id: 'd' + docSeq, name, kind, parsed, file: file || null,
                invoiceNo: parsed.invoiceNo || '',
                creditorSeq: parsed.creditor ? parsed.creditor.seq : '',
                creditorName: parsed.creditor ? parsed.creditor.name : '',
                creditorHint: parsed.creditor
                    ? (parsed.creditor.viaKind
                        ? `Herkend aan ${MARK_LABEL[parsed.creditor.viaKind]}: ${parsed.creditor.name}`
                        : `Herkend: ${parsed.creditor.name}`)
                    : ((parsed.marks && parsed.marks.length)
                        ? 'Niet herkend — kies de crediteur zelf; dezelfde afzender wordt daarna vanzelf herkend'
                        : 'Niet herkend — kies de crediteur zelf')
            };
            /* Is one of these the shipment already open? Then tick just that one;
               otherwise tick the lot, which is what a stack of notes is for. */
            const onThisPage = tr => [tr.ref, transportName(tr)].some(v => v && pageText.includes(v));
            const anyOnPage = (parsed.transports || []).some(onThisPage);
            (parsed.transports || []).forEach(tr => {
                tr.onPage = onThisPage(tr);
                tr.pick = anyOnPage ? tr.onPage : true;
            });
            return d;
        }

        function addFiles(fileList) {
            const files = [...(fileList || [])];
            if (!files.length) return;
            reading = reading.then(() => readFiles(files)).catch(e => log('Reading failed', String(e.message || e)));
        }

        async function readFiles(files) {
            let failed = 0;
            for (let i = 0; i < files.length; i++) {
                const file = files[i];
                $('spec-status').textContent = files.length > 1
                    ? `${file.name} inlezen… (${i + 1} van ${files.length})`
                    : `${file.name} inlezen…`;
                // Same file twice in a stack of drops is a slip, not an intent.
                if (docs.some(d => d.kind === 'file' && d.name === file.name && d.size === file.size)) continue;
                try {
                    const read = await readDroppedFile(file);
                    const parsed = parseInvoiceRows(read.rows, read.imageHashes || []);
                    if (!parsed.transports.length) {
                        docs.push(Object.assign(makeDoc(file.name, 'file', parsed, null),
                            { size: file.size, error: 'Geen kostenregels herkend in dit document.' }));
                        failed++;
                    } else {
                        const keep = read.bytes && read.bytes.byteLength <= MAX_REPORT_DOC_BYTES
                            ? { name: file.name, base64: bytesToBase64(read.bytes) } : null;
                        docs.push(Object.assign(makeDoc(file.name, 'file', parsed, keep), { size: file.size }));
                    }
                } catch (err) {
                    log('PDF read failed', { file: file.name, error: err.message });
                    docs.push(Object.assign(makeDoc(file.name, 'file', { transports: [] }, null),
                        { size: file.size, error: 'Lezen mislukt: ' + err.message }));
                    failed++;
                }
                renderDocs();
                renderResults();
            }
            if (failed) {
                const details = overlay.querySelector('.fip-details');
                if (details) details.open = true;      // open the paste box as a fallback
            }
            renderStatus(failed);
        }

        // Pasted text has no images to go on, and there is only ever one of it.
        function handleText(text) {
            const existing = docs.findIndex(d => d.kind === 'text');
            if (existing >= 0) docs.splice(existing, 1);
            const typed = String(text || '').trim();
            if (typed) {
                const parsed = parseInvoiceRows(rowsFromText(text), []);
                if (parsed.transports.length) docs.push(makeDoc('geplakte tekst', 'text', parsed, null));
            }
            renderDocs();
            renderResults();
            renderStatus(0, !!typed);
        }

        function removeDoc(id) {
            const i = docs.findIndex(d => d.id === id);
            if (i < 0) return;
            if (docs[i].kind === 'text') $('spec-text').value = '';
            docs.splice(i, 1);
            renderDocs();
            renderResults();
            renderStatus();
        }

        /* ---------- painting ---------- */

        function renderStatus(failed, pasted) {
            const good = docs.filter(d => !d.error);
            if (!docs.length) {
                $('spec-status').textContent = pasted
                    ? 'Geen kostenregels herkend in de geplakte tekst.'
                    : 'Nog geen factuur ingelezen.';
                return;
            }
            const nLines = good.reduce((n, d) => n + d.parsed.transports.reduce((m, t) => m + t.lines.length, 0), 0);
            const nTrans = good.reduce((n, d) => n + d.parsed.transports.length, 0);
            const sum = good.reduce((a, d) => a + docTotal(d), 0);
            const allExact = good.length && good.every(d => d.parsed.confidence === 'exact');
            $('spec-status').textContent = good.length
                ? `${good.length} factu${good.length === 1 ? 'ur' : 'ren'}: ${nLines} kostenregel${nLines === 1 ? '' : 's'}`
                  + ` over ${nTrans} zending${nTrans === 1 ? '' : 'en'}, samen ${money(sum)}`
                  + (allExact ? ' — elk totaal klopt met de factuur ✓' : '')
                  + (failed ? ` · ${failed} niet gelukt` : '')
                : 'Geen kostenregels herkend.';
        }

        function docSummary(d) {
            if (d.error) return `<span class="fip-badge is-bad">niet gelezen</span>`;
            const n = d.parsed.transports.length;
            const guessed = d.parsed.transports.reduce((m, t) =>
                m + t.lines.filter(l => ledgerIsGuess(l.desc) && !l.isTransportRow).length, 0);
            const bits = [`${n} zending${n === 1 ? '' : 'en'}`, money(docTotal(d))];
            if (d.parsed.isCredit) bits.push('creditnota');
            if (d.parsed.skippedVat) bits.push(`btw ${money(d.parsed.skippedVat)} niet geboekt`);
            if (guessed) bits.push(`${guessed} regel(s) zonder zeker grootboek`);
            return esc(bits.join(' · ')) + (d.parsed.confidence === 'exact'
                ? ' <span class="fip-badge is-ok">totaal klopt</span>'
                : ' <span class="fip-badge is-warn">niet geverifieerd</span>');
        }

        function renderDocs() {
            $('spec-doccount').textContent = docs.length;
            $('spec-docs').innerHTML = docs.map(d => `
                <div class="fip-doc${d.error ? ' is-bad' : ''}" data-doc="${d.id}">
                    <div class="fip-doc-head">
                        <span class="fip-doc-name" title="${esc(d.name)}">${esc(d.name)}</span>
                        <span class="fip-doc-meta">${docSummary(d)}</span>
                        <button type="button" class="fip-doc-del" data-del="${d.id}" title="Verwijderen">&times;</button>
                    </div>
                    ${d.error ? `<div class="fip-hint">${esc(d.error)}</div>` : `
                    <div class="fip-doc-fields">
                        <div class="fip-field">
                            <label>Factuurnummer</label>
                            <input type="text" data-inv="${d.id}" value="${esc(d.invoiceNo)}">
                        </div>
                        <div class="fip-field">
                            <label>Crediteur</label>
                            <select data-cred="${d.id}">
                                <option value="">— kies crediteur —</option>
                                ${CREDITOR_OPTIONS}
                            </select>
                        </div>
                        <div class="fip-field">
                            <label>Of handmatig nummer</label>
                            <input type="text" data-credseq="${d.id}" value="${esc(d.creditorSeq)}" placeholder="bijv. 71587">
                        </div>
                    </div>
                    <div class="fip-hint" data-credhint="${d.id}">${esc(d.creditorHint)}</div>`}
                </div>`).join('');
            docs.forEach(d => {
                const sel = overlay.querySelector(`[data-cred="${d.id}"]`);
                if (sel) sel.value = d.creditorSeq || '';
            });
        }

        function renderResults() {
            const pairs = docTransports();
            const t = $('spec-table');
            if (!pairs.length) {
                $('spec-result-card').style.display = 'none';
                $('spec-submit').disabled = true;
                $('spec-sel-label').textContent = 'Geen zending gekozen';
                $('spec-sel-total').textContent = money(0);
                paintConfidence();
                return;
            }
            $('spec-result-card').style.display = 'block';
            $('spec-count').textContent = pairs.length;

            const many = docs.filter(d => !d.error).length > 1;
            const body = docs.filter(d => !d.error && d.parsed.transports.length).map(d => {
                const head = many ? `
                    <tr class="fip-docgroup">
                        <td><input type="checkbox" class="spec-doc-check" data-doccheck="${d.id}"
                            ${d.parsed.transports.every(x => x.pick) ? 'checked' : ''} title="Hele factuur aan/uit"></td>
                        <td colspan="2"><b>${esc(d.name)}</b>${d.invoiceNo ? ` · factuur ${esc(d.invoiceNo)}` : ''}${d.creditorName ? ` · ${esc(d.creditorName)}` : ''}</td>
                        <td class="num">${money(docTotal(d))}</td>
                    </tr>` : '';
                return head + d.parsed.transports.map((tr, i) => `
                    <tr data-doc="${d.id}" data-i="${i}" class="fip-spec-row ${tr.pick ? 'is-chosen' : ''}">
                        <td><input type="checkbox" class="spec-pick" data-doc="${d.id}" data-i="${i}" ${tr.pick ? 'checked' : ''}></td>
                        <td>
                            <div><b>${esc(transportName(tr) || 'onbekend')}</b>${tr.onPage ? ' <span class="fip-tag">deze zending</span>' : ''}</div>
                            ${transportFacts(tr).length ? `<div class="fip-ledger">${esc(transportFacts(tr).join(' · '))}</div>` : ''}
                            ${transportName(tr) ? '' : '<div class="fip-ledger">geen container, eenheid of referentie herkend — kan niet worden opgezocht</div>'}
                        </td>
                        <td class="fip-lines">
                            ${tr.lines.map(l => {
                                const led = ledgerForSpecLine(l.desc, l);
                                return `<div class="fip-linerow">
                                    <span class="fip-linedesc">${esc(l.desc)}</span>
                                    <span class="fip-lineledger${ledgerIsGuess(l.desc) && !l.isTransportRow ? ' is-guess' : ''}"
                                          title="${esc(led.name)}">${led.id}</span>
                                    <span class="fip-lineamt">${money(l.amount)}</span>
                                </div>`;
                            }).join('')}
                        </td>
                        <td class="num">${money(tr.total)}</td>
                    </tr>`).join('');
            }).join('');

            const grandTotal = docs.filter(d => !d.error).reduce((a, d) => a + docTotal(d), 0);
            t.innerHTML = `
                <thead><tr>
                    <th style="width:30px;"><input type="checkbox" id="spec-all-check"
                        ${pairs.every(p => p.tr.pick) ? 'checked' : ''} title="Alles aan/uit"></th>
                    <th>Zending</th>
                    <th>Kosten</th>
                    <th class="num">Totaal</th>
                </tr></thead>
                <tbody>${body}
                    <tr class="fip-total"><td colspan="3">Totaal ${many ? 'alle facturen' : 'factuur'}</td><td class="num">${money(grandTotal)}</td></tr>
                </tbody>`;

            refreshFooter();
            paintConfidence();
        }

        /* Which chosen documents did not add up to their own stated total. */
        const unverified = () => [...new Set(chosenPairs().map(p => p.doc))]
            .filter(d => d.parsed.confidence !== 'exact');

        function refreshFooter() {
            const chosen = chosenPairs();
            const pairs = docTransports();
            const sum = chosen.reduce((a, p) => a + p.tr.total, 0);
            const nDocs = new Set(chosen.map(p => p.doc.id)).size;
            $('spec-sel-label').textContent = chosen.length
                ? `${chosen.length} van ${pairs.length} zendingen gekozen`
                  + (nDocs > 1 ? `, uit ${nDocs} facturen` : '')
                : 'Niets geselecteerd';
            $('spec-sel-total').textContent = money(sum);
            $('spec-submit').textContent = chosen.length
                ? `Boek ${chosen.length} zending${chosen.length === 1 ? '' : 'en'}`
                : 'Boek selectie';
            const blocked = unverified().length && !($('spec-override') && $('spec-override').checked);
            $('spec-submit').disabled = !chosen.length || !!blocked;
            if (blocked && chosen.length) $('spec-submit').textContent = 'Controle vereist';
        }

        function paintConfidence() {
            const box = $('spec-confidence');
            if (!box) return;
            const bad = unverified();
            if (!bad.length) {
                box.style.display = 'none';
                $('spec-override-wrap').style.display = 'none';
                return;
            }
            box.style.display = 'flex';
            const which = bad.length === 1
                ? esc(bad[0].parsed.note || '')
                : bad.map(d => `${esc(d.name)}: ${esc(d.parsed.note || '')}`).join('<br>');
            box.innerHTML = `<span>⚠</span><div><b>Bedragen niet geverifieerd${bad.length > 1 ? ` (${bad.length} facturen)` : ''}</b><br>${which}<br>
                Controleer elke regel, of gebruik voor rederijfacturen het carriertemplate.</div>`;
            $('spec-override-wrap').style.display = 'block';
        }

        /* ---------- wiring ---------- */

        const drop = $('spec-drop');
        ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => {
            e.preventDefault(); e.stopPropagation(); drop.classList.add('is-over');
        }));
        ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => {
            e.preventDefault(); e.stopPropagation(); drop.classList.remove('is-over');
        }));
        drop.addEventListener('drop', e => addFiles(e.dataTransfer.files));
        $('spec-file').addEventListener('change', e => { addFiles(e.target.files); e.target.value = ''; });

        // Per-document fields: typed into, never re-rendered under the cursor.
        overlay.addEventListener('input', e => {
            const inv = e.target.getAttribute && e.target.getAttribute('data-inv');
            if (inv) {
                const d = docs.find(x => x.id === inv);
                if (d) { d.invoiceNo = e.target.value.trim(); renderResults(); }
                return;
            }
            const seq = e.target.getAttribute && e.target.getAttribute('data-credseq');
            if (seq) {
                const d = docs.find(x => x.id === seq);
                if (!d) return;
                d.creditorSeq = e.target.value.trim();
                const known = CREDITORS.find(c => String(c.seq) === d.creditorSeq);
                d.creditorName = known ? known.name : '';
                const sel = overlay.querySelector(`[data-cred="${d.id}"]`);
                if (sel) sel.value = known ? String(known.seq) : '';
                renderResults();
            }
        });

        overlay.addEventListener('change', e => {
            const cred = e.target.getAttribute && e.target.getAttribute('data-cred');
            if (!cred) return;
            const d = docs.find(x => x.id === cred);
            if (!d) return;
            const opt = e.target.selectedOptions[0];
            d.creditorSeq = e.target.value || '';
            d.creditorName = (opt && opt.getAttribute('data-name')) || '';
            const manual = overlay.querySelector(`[data-credseq="${d.id}"]`);
            if (manual) manual.value = d.creditorSeq;
            const hint = overlay.querySelector(`[data-credhint="${d.id}"]`);
            if (hint && d.creditorName) hint.textContent = `Gekozen: ${d.creditorName}`;
            renderResults();
        });

        $('spec-text').addEventListener('input', e => handleText(e.target.value));
        $('spec-text').addEventListener('paste', () => setTimeout(() => handleText($('spec-text').value), 0));

        overlay.addEventListener('click', e => {
            const del = e.target.getAttribute && e.target.getAttribute('data-del');
            if (del) { removeDoc(del); return; }
            if (e.target.id === 'spec-override') { refreshFooter(); return; }
            if (e.target.id === 'spec-all-check') {
                const on = e.target.checked;
                docTransports().forEach(p => { p.tr.pick = on; });
                renderResults();
                return;
            }
            const docCheck = e.target.getAttribute && e.target.getAttribute('data-doccheck');
            if (docCheck) {
                const d = docs.find(x => x.id === docCheck);
                if (d) d.parsed.transports.forEach(tr => { tr.pick = e.target.checked; });
                renderResults();
                return;
            }
            const row = e.target.closest('.fip-spec-row');
            if (!row) return;
            const d = docs.find(x => x.id === row.getAttribute('data-doc'));
            const tr = d && d.parsed.transports[parseInt(row.getAttribute('data-i'), 10)];
            if (!tr) return;
            // a click anywhere on the row toggles it; the checkbox handles itself
            tr.pick = e.target.classList && e.target.classList.contains('spec-pick')
                ? e.target.checked : !tr.pick;
            renderResults();
        });

        $('spec-copy').addEventListener('click', () => {
            const many = docs.filter(d => !d.error).length > 1;
            const head = (many ? 'Factuur\tBestand\t' : '') + 'Zending\tDetails\tRegels\tBedrag';
            const tsv = [head].concat(docTransports().map(({ doc, tr }) =>
                (many ? [doc.invoiceNo, doc.name] : []).concat([
                    transportName(tr), transportFacts(tr).join(' · '), tr.lines.length,
                    tr.total.toFixed(2).replace('.', ',')]).join('\t'))).join('\n');
            navigator.clipboard.writeText(tsv).then(() => {
                $('spec-copy').textContent = 'Gekopieerd ✓';
                setTimeout(() => { $('spec-copy').textContent = 'Overzicht kopiëren'; }, 1600);
            }).catch(() => fipTell('Kopiëren naar het klembord is mislukt.'));
        });

        const close = () => {
            overlay.dispatchEvent(new Event('fip-close'));
            if (overlay.parentNode) document.body.removeChild(overlay);
            document.removeEventListener('keydown', onKey);
        };
        function onKey(e) { if (e.key === 'Escape') close(); }
        document.addEventListener('keydown', onKey);
        $('spec-cancel').addEventListener('click', close);

        function collectOptions() {
            const combineEl = overlay.querySelector('input[name="spec-combine"]:checked');
            return {
                descMode: $('spec-descmode').value,
                combine: combineEl && combineEl.value === 'combine',
                ignoreExisting: !!($('spec-ignore-existing') && $('spec-ignore-existing').checked)
            };
        }

        async function startWorklist(pairs, opts) {
            const used = [...new Set(pairs.map(p => p.doc))];
            // Learn only from a creditor that was actually booked on.
            used.forEach(d => learnCreditorMarks(d.parsed.marks, d.creditorSeq, d.creditorName));

            const first = used[0];
            REPORT_CONTEXT = {
                invoiceNo: first ? first.invoiceNo : '',
                creditor: first ? first.creditorName : '',
                creditorSeq: first ? first.creditorSeq : '',
                amount: pairs.reduce((a, p) => a + p.tr.total, 0),
                document: first ? first.file : null
            };
            const without = used.filter(d => !d.creditorSeq);
            if (without.length) {
                const go = await fipAsk({
                    title: 'Geen crediteur',
                    message: (without.length === used.length
                        ? 'Er is geen crediteurnummer ingevuld, dus de crediteur wordt niet automatisch gezet.'
                        : `Bij ${without.length} van de ${used.length} facturen is geen crediteurnummer ingevuld`
                          + ` (${without.map(d => d.name).join(', ')}), dus daar wordt de crediteur niet automatisch gezet.`)
                        + '\n\nToch doorgaan?',
                    okLabel: 'Doorgaan', cancelLabel: 'Terug'
                });
                if (!go) return false;
            }
            localStorage.setItem('fiton_spec_prefs', JSON.stringify({
                descMode: opts.descMode, combine: opts.combine
            }));
            saveWorklist({
                running: true, index: 0, attempts: 0,
                // Kept for a report or a resume that still reads the old fields.
                invoiceNo: first ? first.invoiceNo : '',
                creditorSeq: first ? first.creditorSeq : '',
                creditorName: first ? first.creditorName : '',
                creditor: first ? first.creditorName : '',
                fileName: first ? first.name : '',
                confidence: first ? first.parsed.confidence : '',
                statedTotal: first ? first.parsed.statedTotal : null,
                amount: used.length === 1 ? (first ? first.parsed.calcTotal : null) : REPORT_CONTEXT.amount,
                descMode: opts.descMode, combine: opts.combine,
                searchUrl: location.href,
                user: fitonUser(), startedAt: Date.now(),
                ignoreExisting: !!opts.ignoreExisting,
                /* What was read per document, so the end report can go out one
                   row per invoice however many went in at once. */
                docs: used.map(d => ({
                    docId: d.id, docName: d.name, invoiceNo: d.invoiceNo,
                    creditorSeq: d.creditorSeq, creditorName: d.creditorName,
                    amount: d.parsed.calcTotal, statedTotal: d.parsed.statedTotal != null ? d.parsed.statedTotal : null,
                    confidence: d.parsed.confidence || ''
                })),
                items: pairs.map(({ doc, tr }) => Object.assign({}, tr, {
                    status: 'pending',
                    docId: doc.id, docName: doc.name,
                    invoiceNo: doc.invoiceNo, creditorSeq: doc.creditorSeq, creditorName: doc.creditorName
                }))
            });
            /* The PDFs do not survive the page loads ahead; keep them for the
               reports at the end, largest first out if it gets out of hand. */
            let budget = MAX_REPORT_DOC_TOTAL;
            const keep = [];
            used.forEach(d => {
                if (!d.file) return;
                const size = d.file.base64.length;
                if (size > budget) return;
                budget -= size;
                keep.push({ docId: d.id, name: d.file.name, base64: d.file.base64 });
            });
            chrome.storage.local.set({ [REPORT_DOC_KEY]: keep }).catch(() => {});
            close();
            runWorklist();
            return true;
        }

        $('spec-submit').addEventListener('click', async () => {
            const chosen = chosenPairs();
            if (!chosen.length) return;
            const opts = collectOptions();
            const used = [...new Set(chosen.map(p => p.doc))];
            const totalLines = chosen.reduce((n, p) => n + (opts.combine ? 1 : p.tr.lines.length), 0);
            const sum = chosen.reduce((a, p) => a + p.tr.total, 0);

            const noNumber = used.filter(d => !d.invoiceNo).length;
            const descNote = opts.descMode === 'invoiceOnly' && noNumber
                ? `Let op: ${noNumber === used.length ? 'geen factuurnummer' : `${noNumber} factu${noNumber === 1 ? 'ur' : 'ren'} zonder nummer`}`
                  + ' — de omschrijving wordt dan de kostensoort.\n\n' : '';
            const unnamed = chosen.filter(p => !transportName(p.tr)).length;
            const unnamedNote = unnamed
                ? `Let op: ${unnamed} zending${unnamed === 1 ? '' : 'en'} zonder container, eenheid of referentie kan niet worden opgezocht en wordt als niet gevonden gemeld.\n\n` : '';
            /* With one invoice the containers themselves are the useful list;
               with a stack of them it is the invoices. */
            const what = used.length === 1
                ? chosen.map(p => transportName(p.tr) || '?').join(', ')
                : used.map(d => `${d.invoiceNo || d.name}: ${chosen.filter(p => p.doc === d).length} zending(en)`).join('\n');
            const go = await fipAsk({
                title: used.length > 1
                    ? `${chosen.length} zendingen uit ${used.length} facturen boeken`
                    : chosen.length === 1 ? 'Eén zending boeken' : `${chosen.length} zendingen boeken`,
                message: `${what}\n\n`
                       + `Samen ${money(sum)} in ${totalLines} regel${totalLines === 1 ? '' : 's'}.\n\n`
                       + descNote + unnamedNote
                       + 'Elke zending wordt apart opgezocht en op het eigen dossier geboekt, met het factuurnummer en de crediteur van de factuur waar hij op stond. '
                       + 'Laat dit tabblad open staan.\n\nStarten?',
                okLabel: 'Starten', cancelLabel: 'Annuleren'
            });
            if (!go) return;
            startWorklist(chosen, opts);
        });

        renderDocs();
        $('spec-text').focus();
    }

    function showCostModal(callback) {
        if (document.querySelector('.fip-overlay')) return;

        let prefs = {};
        try { prefs = JSON.parse(localStorage.getItem('fiton_cost_prefs') || '{}'); } catch (e) {}

        const carrierKey = prefs.carrier || CARRIERS[0].key;
        const typeKey = prefs.containerType || '40RF';

        const overlay = document.createElement('div');
        overlay.className = 'fip-overlay fip-root';
        overlay.innerHTML = `
        <div class="fip-modal">
            <div class="fip-modal-head">
                <div>
                    <h3>Kosten boeken — carriertemplate</h3>
                    <p>Bedragen per carrier en containertype · bron: <span id="rates-source">${esc(RATES_META.source)}</span>${RATES_META.version ? ' v' + esc(String(RATES_META.version)) : ''}</p>
                </div>
                <button class="fip-modal-close" id="cost-cancel" title="Sluiten (Esc)">&times;</button>
            </div>

            <div class="fip-modal-body">
                <div class="fip-card">
                    <div class="fip-card-title">Zending</div>
                    <div class="fip-grid">
                        <div class="fip-field">
                            <label>Carrier</label>
                            <select id="cost-carrier">
                                ${CARRIERS.map(c => `<option value="${c.key}" ${c.key === carrierKey ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
                            </select>
                        </div>
                        <div class="fip-field">
                            <div class="fip-hint" id="cost-account" style="display:none; margin-bottom:6px;"></div>
                            <label>Tarievenpagina carrier</label>
                            <a id="cost-tariff-link" class="fip-tarifflink" target="_blank" rel="noopener">openen</a>
                            <div class="fip-hint">Controleer of bewerk de bedragen hieronder</div>
                        </div>
                        <div class="fip-field">
                            <label>Containertype</label>
                            <select id="cost-type">
                                ${CONTAINER_TYPES.map(tp => `<option value="${tp.key}" ${tp.key === typeKey ? 'selected' : ''}>${esc(tp.label)}</option>`).join('')}
                            </select>
                        </div>
                        <div class="fip-field">
                            <label>Aantal containers</label>
                            <input type="number" id="cost-containers" min="1" step="1" value="${prefs.containers || 1}">
                        </div>
                        <div class="fip-field">
                            <label>Factuurnummer carrier</label>
                            <input type="text" id="cost-invoice" placeholder="bijv. NL260817541I" value="">
                            <div class="fip-hint">Komt in de omschrijving van elke regel</div>
                        </div>
                    </div>
                </div>

                <div class="fip-card">
                    <div class="fip-card-title">Kosten van de carrierfactuur <span class="fip-count" id="cost-count">0</span></div>
                    <div class="fip-hint" style="margin:-4px 0 10px;">Leeg of 0 = niet boeken. Bedragen worden onthouden per carrier en containertype.</div>
                    <div class="fip-grid" id="cost-charges"></div>
                </div>

                <div class="fip-card">
                    <div class="fip-card-title">Crediteur</div>
                    <div class="fip-checklist">
                        <label class="fip-check">
                            <input type="checkbox" id="cost-setcreditor" ${prefs.setCreditor === false ? '' : 'checked'}>
                            <span>Crediteur automatisch instellen</span>
                        </label>
                    </div>
                    <div class="fip-hint" id="cost-creditor-note" style="margin-top:6px;"></div>
                </div>

                <div class="fip-card">
                    <div class="fip-card-title">Boekwijze</div>
                    <div class="fip-checklist">
                        <label class="fip-check"><input type="radio" name="cost-combine" value="split" ${prefs.combine ? '' : 'checked'}>
                            <span>Aparte regels per kostensoort</span></label>
                        <label class="fip-check"><input type="radio" name="cost-combine" value="combine" ${prefs.combine ? 'checked' : ''}>
                            <span>Alles samen op één THC-regel</span></label>
                    </div>
                    <div class="fip-field" style="margin-top:10px; max-width:280px;">
                        <label>Omschrijving</label>
                        <select id="cost-descmode">
                            <option value="invoice" ${(prefs.descMode || 'invoice') === 'invoice' ? 'selected' : ''}>Alleen factuurnummer</option>
                            <option value="both" ${prefs.descMode === 'both' ? 'selected' : ''}>Factuurnummer + kostensoort</option>
                            <option value="name" ${prefs.descMode === 'name' ? 'selected' : ''}>Alleen kostensoort</option>
                        </select>
                    </div>
                </div>
            </div>

            <div class="fip-modal-foot">
                <button type="button" class="fip-btn fip-btn-ghost fip-btn-sm" id="cost-save-rates">Tarieven bewaren</button>
                <div class="fip-foot-total">
                    <span id="cost-lines">0 regels</span>
                    <strong id="cost-total">${money(0)}</strong>
                </div>
                <button type="button" class="fip-btn fip-btn-primary" id="cost-submit">Controleer regels</button>
            </div>
        </div>`;

        document.body.appendChild(overlay);
        enableModalResize(overlay, 'fiton_modal_size_cost');

        const $ = id => document.getElementById(id);

        function paintCharges() {
            const carrier = $('cost-carrier').value;
            const type = $('cost-type').value;

            const meta = CARRIERS.find(c => c.key === carrier);
            const noteBox = $('cost-creditor-note');
            if (noteBox) {
                const on = $('cost-setcreditor') && $('cost-setcreditor').checked;
                noteBox.textContent = (meta && meta.creditorSeq)
                    ? (on ? `Wordt geboekt op crediteur ${meta.name} (${meta.creditorSeq}).`
                          : `Crediteur wordt niet gewijzigd; ${meta.name} is ${meta.creditorSeq}.`)
                    : 'Voor deze carrier is geen crediteurnummer bekend — stel de crediteur zelf in.';
            }

            const accBox = $('cost-account');
            if (accBox) {
                accBox.textContent = (meta && meta.account) ? ('Ons klantnummer bij ' + meta.name + ': ' + meta.account) : '';
                accBox.style.display = (meta && meta.account) ? 'block' : 'none';
            }
            const link = $('cost-tariff-link');
            if (meta && meta.tariff) {
                link.href = meta.tariff;
                link.textContent = meta.name + ' tarieven';
                link.classList.remove('is-off');
            } else {
                link.removeAttribute('href');
                link.textContent = 'geen link bekend';
                link.classList.add('is-off');
            }
            $('cost-charges').innerHTML = CARRIER_CHARGES.map(ch => {
                const stored = carrierRate(carrier, type, ch.key);
                return `
                <div class="fip-field">
                    <label>${esc(ch.desc)}</label>
                    <input type="number" class="cost-amount" data-key="${ch.key}" min="0" step="0.01"
                           placeholder="0,00" value="${stored !== null ? stored : ''}">
                </div>`;
            }).join('');
            refresh();
        }

        function collect() {
            const amounts = {};
            overlay.querySelectorAll('.cost-amount').forEach(inp => {
                const v = parseFloat(inp.value);
                if (!isNaN(v) && v > 0) amounts[inp.getAttribute('data-key')] = round2(v);
            });
            const combineEl = overlay.querySelector('input[name="cost-combine"]:checked');
            return {
                carrier: $('cost-carrier').value,
                containerType: $('cost-type').value,
                containers: Math.max(1, Math.round(parseFloat($('cost-containers').value) || 1)),
                invoiceNo: $('cost-invoice').value.trim(),
                amounts,
                combine: combineEl && combineEl.value === 'combine',
                descMode: $('cost-descmode').value,
                setCreditor: $('cost-setcreditor') ? $('cost-setcreditor').checked : true
            };
        }

        function refresh() {
            const o = collect();
            const items = buildCostItems(o);
            const total = items.reduce((sum, i) => sum + i.qty * i.price, 0);
            $('cost-total').textContent = money(total);
            $('cost-lines').textContent = `${items.length} regel${items.length === 1 ? '' : 's'}`;
            $('cost-count').textContent = Object.keys(o.amounts).length;
            $('cost-submit').disabled = items.length === 0;
        }

        overlay.addEventListener('input', refresh);
        overlay.addEventListener('change', e => {
            if (e.target.id === 'cost-carrier' || e.target.id === 'cost-type') paintCharges();
            else if (e.target.id === 'cost-setcreditor') paintCharges();
            else refresh();
        });

        $('cost-save-rates').addEventListener('click', () => {
            const o = collect();
            setCarrierRates(o.carrier, o.containerType, o.amounts);
            const b = $('cost-save-rates');
            b.textContent = 'Bewaard ✓';
            setTimeout(() => { b.textContent = 'Tarieven bewaren'; }, 1600);
        });

        const close = () => {
            overlay.dispatchEvent(new Event('fip-close'));
            if (overlay.parentNode) document.body.removeChild(overlay);
            document.removeEventListener('keydown', onKey);
        };
        function onKey(e) { if (e.key === 'Escape') close(); }
        document.addEventListener('keydown', onKey);
        $('cost-cancel').addEventListener('click', close);
        overlay.addEventListener('mousedown', e => { if (e.target === overlay) close(); });

        $('cost-submit').addEventListener('click', async () => {
            const o = collect();
            const items = buildCostItems(o);
            if (!items.length) return;

            if (!o.invoiceNo && o.descMode !== 'name') {
                const go = await fipAsk({
                    title: 'Geen factuurnummer',
                    message: 'Er is geen factuurnummer van de carrier ingevuld. De omschrijving valt dan terug op de kostensoort.\n\nToch doorgaan?',
                    okLabel: 'Doorgaan', cancelLabel: 'Terug'
                });
                if (!go) return;
            }

            localStorage.setItem('fiton_cost_prefs', JSON.stringify({
                carrier: o.carrier, containerType: o.containerType, containers: o.containers,
                combine: o.combine, descMode: o.descMode, setCreditor: o.setCreditor
            }));
            close();
            callback(o, items);
        });

        paintCharges();
        $('cost-invoice').focus();
    }

    /* =========================================================================
       PREVIEW MODAL
       ========================================================================= */

    function showPreview(templateType, items, warnings, onConfirm) {
        if (document.querySelector('.fip-overlay')) return;
        const cfg = CLIENTS[templateType];
        const nl = cfg.lang === 'nl';
        const t = (a, b) => (nl ? a : b);

        // Work on a copy: quantities and prices can be edited here before booking.
        const rows = items.map(i => Object.assign({}, i));
        const groups = [...new Set(rows.map(r => r.group))];

        const lineTotal = r => r.qty * r.price;
        const grandTotal = () => rows.reduce((sum, r) => sum + lineTotal(r), 0);

        function rowHtml(r, idx) {
            return `
            <tr data-idx="${idx}" class="${r.price < 0 ? 'fip-credit' : ''}">
                <td class="fip-rownum">${idx + 1}</td>
                <td>
                    <input class="fip-cell fip-cell-desc" data-field="desc" value="${esc(r.desc || '')}">
                    <div class="fip-ledger">${esc(r.ledgerName)}${r.isOutlay ? ' · <span class="fip-tag">outlay</span>' : ''}</div>
                </td>
                <td class="num"><input class="fip-cell fip-cell-num" data-field="qty" type="number" step="0.001" value="${r.qty}"></td>
                <td class="num"><input class="fip-cell fip-cell-num" data-field="price" type="number" step="0.01" value="${r.price}"></td>
                <td class="num fip-line-total">${money(lineTotal(r))}</td>
                <td class="num"><button class="fip-row-del" title="${t('Regel verwijderen', 'Remove line')}">&times;</button></td>
            </tr>`;
        }

        const bodyHtml = groups.map(g => {
            const idxs = rows.map((r, i) => [r, i]).filter(([r]) => r.group === g);
            const sub = idxs.reduce((sum, [r]) => sum + lineTotal(r), 0);
            return `
                <tbody class="fip-group" data-group="${esc(g)}">
                    <tr class="fip-group-head">
                        <td colspan="4">${esc(g)}</td>
                        <td class="num fip-group-total">${money(sub)}</td>
                        <td></td>
                    </tr>
                    ${idxs.map(([r, i]) => rowHtml(r, i)).join('')}
                </tbody>`;
        }).join('');

        const overlay = document.createElement('div');
        overlay.className = 'fip-overlay fip-root';
        overlay.innerHTML = `
        <div class="fip-modal">
            <div class="fip-modal-head">
                <div>
                    <h3>${MODE === 'cost' ? t('Controleer kostenregels', 'Review cost lines') : t('Controleer factuurregels', 'Review invoice lines')}</h3>
                    <p>${esc(cfg.name)} · <span id="preview-count">${rows.length}</span> ${t('regels', 'lines')} · ${CURRENCY_CODE} ·
                       ${t('velden zijn aanpasbaar', 'fields are editable')}</p>
                </div>
                <button class="fip-modal-close" id="preview-close" title="Esc">&times;</button>
            </div>
            <div class="fip-modal-body">
                ${warnings.length ? `<div class="fip-banner"><span>⚠</span><div><b>${warnings.length} ${t('aandachtspunt(en)', 'point(s) to check')}</b><ul style="margin:5px 0 0 16px; padding:0;">${warnings.map(w => `<li>${esc(w)}</li>`).join('')}</ul></div></div>` : ''}
                <div class="fip-card" style="padding:6px 12px;">
                    <table class="fip-table fip-table-edit">
                        <thead><tr>
                            <th style="width:26px;">#</th>
                            <th>${t('Omschrijving / grootboek', 'Description / ledger')}</th>
                            <th class="num" style="width:80px;">${t('Aantal', 'Qty')}</th>
                            <th class="num" style="width:90px;">${t('Prijs', 'Price')}</th>
                            <th class="num" style="width:95px;">${t('Bedrag', 'Amount')}</th>
                            <th style="width:28px;"></th>
                        </tr></thead>
                        ${bodyHtml}
                    </table>
                </div>
            </div>
            <div class="fip-modal-foot">
                <div class="fip-foot-total">
                    <span>${t('Totaal excl. btw', 'Total excl. VAT')} (${CURRENCY_CODE})</span>
                    <strong id="preview-total">${money(grandTotal())}</strong>
                </div>
                ${MODE === 'cost' ? `<button type="button" class="fip-btn fip-btn-ghost" id="preview-zero">${t('Prijzen leegmaken', 'Clear prices')}</button>` : ''}
                <button type="button" class="fip-btn fip-btn-ghost" id="preview-copy">${t('Kopieer', 'Copy')}</button>
                <button type="button" class="fip-btn fip-btn-ghost" id="preview-back">${t('Terug', 'Back')}</button>
                <button type="button" class="fip-btn fip-btn-primary" id="preview-confirm">${t('Boek regels', 'Book lines')}</button>
            </div>
        </div>`;
        document.body.appendChild(overlay);
        enableModalResize(overlay, 'fiton_modal_size_preview');

        const live = () => rows.filter(r => !r.removed);

        function refresh() {
            overlay.querySelectorAll('tr[data-idx]').forEach(tr => {
                const r = rows[parseInt(tr.getAttribute('data-idx'), 10)];
                tr.querySelector('.fip-line-total').textContent = money(lineTotal(r));
                tr.classList.toggle('fip-removed', !!r.removed);
            });
            overlay.querySelectorAll('.fip-group').forEach(tb => {
                const g = tb.getAttribute('data-group');
                const sub = live().filter(r => r.group === g).reduce((sum, r) => sum + lineTotal(r), 0);
                tb.querySelector('.fip-group-total').textContent = money(sub);
            });
            overlay.querySelector('#preview-total').textContent =
                money(live().reduce((sum, r) => sum + lineTotal(r), 0));
            overlay.querySelector('#preview-count').textContent = live().length;
        }

        overlay.addEventListener('input', e => {
            const cell = e.target.closest('.fip-cell');
            if (!cell) return;
            const tr = cell.closest('tr[data-idx]');
            const r = rows[parseInt(tr.getAttribute('data-idx'), 10)];
            const field = cell.getAttribute('data-field');
            if (field === 'desc') r.desc = cell.value;
            else {
                const v = parseFloat(cell.value);
                r[field] = isNaN(v) ? 0 : v;
            }
            refresh();
        });

        overlay.addEventListener('click', e => {
            const del = e.target.closest('.fip-row-del');
            if (!del) return;
            const tr = del.closest('tr[data-idx]');
            const r = rows[parseInt(tr.getAttribute('data-idx'), 10)];
            r.removed = !r.removed;
            del.innerHTML = r.removed ? '&#8630;' : '&times;';
            refresh();
        });

        const close = () => {
            overlay.dispatchEvent(new Event('fip-close'));
            if (overlay.parentNode) document.body.removeChild(overlay);
            document.removeEventListener('keydown', onKey);
        };
        function onKey(e) { if (e.key === 'Escape') close(); }
        document.addEventListener('keydown', onKey);

        const zeroBtn = overlay.querySelector('#preview-zero');
        if (zeroBtn) {
            zeroBtn.addEventListener('click', () => {
                rows.forEach(r => { if (!r.isOutlay) r.price = 0; });
                overlay.querySelectorAll('tr[data-idx]').forEach(tr => {
                    const r = rows[parseInt(tr.getAttribute('data-idx'), 10)];
                    tr.querySelector('[data-field="price"]').value = r.price;
                });
                refresh();
            });
        }

        overlay.querySelector('#preview-close').addEventListener('click', close);
        overlay.querySelector('#preview-back').addEventListener('click', close);
        overlay.querySelector('#preview-confirm').addEventListener('click', () => {
            const final = live().map(r => ({
                ledgerId: r.ledgerId, ledgerName: r.ledgerName, desc: r.desc,
                qty: r.qty, price: r.price, vatSeq: r.vatSeq,
                creditorSeq: r.creditorSeq, creditorName: r.creditorName
            }));
            if (!final.length) return;
            close();
            onConfirm(final);
        });
        overlay.querySelector('#preview-copy').addEventListener('click', () => {
            const tsv = live().map(r => [r.group, r.ledgerName, r.desc, r.qty,
                String(r.price).replace('.', ','), lineTotal(r).toFixed(2).replace('.', ',')].join('\t')).join('\n');
            navigator.clipboard.writeText(tsv).then(() => {
                const b = overlay.querySelector('#preview-copy');
                b.textContent = t('Gekopieerd ✓', 'Copied ✓');
                setTimeout(() => { b.textContent = t('Kopieer', 'Copy'); }, 1600);
            }).catch(() => fipTell(t('Kopiëren naar het klembord is mislukt.', 'Copying to the clipboard failed.')));
        });
    }

    /* =========================================================================
       FORM AUTOMATION
       ========================================================================= */

    function setCreditor(seq, displayName) {
        const hidden = el('creditorHidden');
        const visible = el('creditor');
        if (!hidden && !visible) { log('No creditor field on this page - skipped'); return false; }

        if (hidden) {
            hidden.value = seq;
            hidden.dispatchEvent(new Event('input', { bubbles: true }));
            hidden.dispatchEvent(new Event('change', { bubbles: true }));
        }
        if (visible && displayName) {
            visible.value = displayName;
            visible.dispatchEvent(new Event('input', { bubbles: true }));
            visible.dispatchEvent(new Event('change', { bubbles: true }));
        }
        if (window.apex && window.apex.item && F().creditor) {
            try { window.apex.item(F().creditor).setValue(seq, displayName || ''); } catch (e) {}
        }
        log(`Creditor set to ${seq}${displayName ? ' (' + displayName + ')' : ''}`);
        return true;
    }

    function forceEuroCurrency() {
        // Prefer this page's own currency field; only consult the legacy list
        // when the map has none, so we can never write to another page's item.
        const mapped = F().currency;
        const candidates = mapped ? [mapped] : CURRENCY_FIELD_IDS.slice();
        for (const id of candidates) {
            const field = document.getElementById(id);
            if (!field) continue;
            let value = CURRENCY_CODE;
            if (field.tagName === 'SELECT') {
                const opt = Array.from(field.options).find(o =>
                    o.value === CURRENCY_CODE ||
                    /^eur$/i.test((o.text || '').trim()) ||
                    /\beur\b/i.test(o.text || ''));
                if (!opt) { log(`Currency field ${id} has no EUR option`); continue; }
                value = opt.value;
            }
            field.value = value;
            if (window.apex && window.apex.item) {
                try { window.apex.item(id).setValue(value); } catch (e) {}
            }
            field.dispatchEvent(new Event('input', { bubbles: true }));
            field.dispatchEvent(new Event('change', { bubbles: true }));
            log(`Currency field ${id} set to EUR`);
            return true;
        }
        return false;
    }

    async function fillSingleItem(item) {
        const tp = TIMING;
        log(`Filling ledger ${item.ledgerId} (${item.ledgerName})`, item);

        // A real entry form has the fields AND a Create button. The saved-record
        // view shows the same fields, so checking the fields alone is not enough.
        await waitFor(() => el('ledger') && el('qty') && el('price') && getCreateButton(),
                      tp.formWait, tp.fieldWait);

        const hiddenField = el('ledgerHidden');
        if (hiddenField) {
            hiddenField.value = item.ledgerId;
            hiddenField.dispatchEvent(new Event('input', { bubbles: true }));
            hiddenField.dispatchEvent(new Event('change', { bubbles: true }));
        }

        const textDisplayField = el('ledger');
        if (textDisplayField) {
            textDisplayField.value = item.ledgerName;
            textDisplayField.dispatchEvent(new Event('input', { bubbles: true }));
            textDisplayField.dispatchEvent(new Event('change', { bubbles: true }));
        }

        if (window.apex && window.apex.item) {
            try { window.apex.item(F().ledger).setValue(item.ledgerId, item.ledgerName); } catch (e) {}
        }
        if (typeof window.getLedgerVat === 'function') {
            try { window.getLedgerVat(); } catch (e) {}
        }

        /* Changing the ledger fires getVatSeq. Waiting for that answer beats
           waiting a fixed 200 ms: usually quicker, and never too short. */
        await waitForAjaxIdle(tp.ajaxIdle || 4000);

        // Cost lines carry their carrier's creditor, so a Hapag invoice can never
        // be booked against MSC by accident.
        if (item.creditorSeq) setCreditor(item.creditorSeq, item.creditorName);

        // Every rate in this script is EUR - make sure the line is booked in EUR.
        forceEuroCurrency();

        const qtyField = el('qty');
        if (qtyField) setNativeValue(qtyField, item.qty);

        const priceField = el('price');
        if (priceField) setNativeValue(priceField, item.price);

        const descField = el('desc');
        if (descField) setNativeValue(descField, item.desc);

        /* The page works out the VAT code itself: changing the creditor, the
           ledger or the date fires the application process getVatSeq, whose
           answer lands in the VAT field. That answer can arrive after we have
           set the field, quietly replacing our value - so wait for the page to
           go quiet first, and set the code after that. */
        await waitForAjaxIdle(tp.ajaxIdle || 4000);

        const vatSeq = item.vatSeq || DEFAULT_VAT_SEQ;
        for (let i = 0; i < 2; i++) {
            const vatField = el('vat');
            if (vatField) {
                vatField.value = vatSeq;
                if (window.apex && window.apex.item) {
                    try { window.apex.item(F().vat).setValue(vatSeq); } catch (e) {}
                }
                if (typeof window.setVatAmount === 'function' && F().amount) {
                    try { window.setVatAmount(vatField, F().amount, F().vatAmount); } catch (e) {}
                }
                vatField.dispatchEvent(new Event('input', { bubbles: true }));
                vatField.dispatchEvent(new Event('change', { bubbles: true }));
                if (typeof jQuery !== 'undefined') {
                    try { jQuery('#' + F().vat).val(vatSeq).trigger('change').trigger('select2:select'); } catch (e) {}
                }
            }
            await sleep(tp.vatStep);
            if (String((el('vat') || {}).value) === String(vatSeq)) break;   // took on the first pass
        }

        /* And once more after it has gone quiet: if a late answer still put
           something else there, the line is wrong in a way nobody sees on the
           overview. Better to stop than to book it. */
        await waitForAjaxIdle(tp.ajaxIdle || 4000);
        const vatNow = (el('vat') || {}).value;
        if (vatNow && String(vatNow) !== String(vatSeq)) {
            const again = el('vat');
            if (again) {
                again.value = vatSeq;
                if (window.apex && window.apex.item) { try { window.apex.item(F().vat).setValue(vatSeq); } catch (e) {} }
                again.dispatchEvent(new Event('change', { bubbles: true }));
            }
            await waitForAjaxIdle(tp.ajaxIdle || 4000);
            const after = (el('vat') || {}).value;
            log(`VAT code was ${vatNow}, wanted ${vatSeq}, now ${after}`);
            if (after && String(after) !== String(vatSeq)) {
                throw new Error(`De pagina zet de btw-code op ${after} en houdt die vast, terwijl ${vatSeq} (0%) verwacht wordt. `
                              + 'Regel niet geboekt — controleer deze zelf.');
            }
        }

    }

    /* Wait until nothing is on the way to the server any more. The counter comes
       from the injected bridge; without it, fall back to waiting a moment. */
    async function waitForAjaxIdle(timeout) {
        const root = document.documentElement;
        if (!root.hasAttribute('data-fiton-ajax')) { await sleep(400); return false; }
        const deadline = Date.now() + (timeout || 4000);
        let quietSince = 0;
        while (Date.now() < deadline) {
            const busy = parseInt(root.getAttribute('data-fiton-ajax') || '0', 10) > 0;
            if (busy) quietSince = 0;
            else if (!quietSince) quietSince = Date.now();
            /* 200 ms of quiet, not less: an APEX dynamic action can fire its
               request a moment after the change event, and returning too early
               is exactly the race this wait exists to avoid. */
            else if (Date.now() - quietSince >= 200) return true;
            await sleep(40);
        }
        log('Page still busy after waiting for the server');
        return false;
    }

    /* ---------------------------------------------------------------------
       Panel messaging - replaces blocking alert() dialogs.
       --------------------------------------------------------------------- */
    function panelMessage(text, tone) {
        const box = document.getElementById('fip-message');
        if (!box) { if (tone === 'error') console.warn('[InvoiceBot]', text); return; }
        box.textContent = text;
        box.className = 'fip-message is-' + (tone || 'info');
        box.style.display = 'block';
    }
    function clearPanelMessage() {
        const box = document.getElementById('fip-message');
        if (box) { box.style.display = 'none'; box.textContent = ''; }
    }

    function setStatus(text, tone, pct) {
        const panel = document.getElementById('fiton-invoice-helper');
        const head = document.querySelector('.fip-panel-head');
        const statusBox = document.querySelector('.fip-status');
        const statusText = document.getElementById('fip-status-text');
        const bar = document.getElementById('fip-progress-bar');

        if (statusText && statusText.textContent !== text) {
            statusText.textContent = text;
            statusText.classList.remove('fip-tick');
            void statusText.offsetWidth;
            statusText.classList.add('fip-tick');
        }
        if (head) {
            head.classList.toggle('is-running', tone === 'running');
            head.classList.toggle('is-done', tone === 'done');
        }
        if (panel) panel.classList.toggle('is-busy', tone === 'running');
        if (statusBox) {
            statusBox.classList.remove('is-done');
            if (tone === 'done') { void statusBox.offsetWidth; statusBox.classList.add('is-done'); }
        }
        if (bar) {
            bar.classList.toggle('is-running', tone === 'running');
            bar.classList.toggle('is-done', tone === 'done');
            bar.classList.toggle('is-error', tone === 'error');
            if (typeof pct === 'number') bar.style.width = Math.max(0, Math.min(100, pct)) + '%';
        }
    }

    function setSubStatus(text) {
        const el = document.getElementById('fip-substatus');
        if (el) el.textContent = text || '';
    }

    function animateNumber(el, from, to, format) {
        if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
            el.textContent = format(to); return;
        }
        const start = performance.now(), dur = 260;
        function frame(now) {
            const p = Math.min(1, (now - start) / dur);
            const eased = 1 - Math.pow(1 - p, 3);
            el.textContent = format(from + (to - from) * eased);
            if (p < 1) requestAnimationFrame(frame);
        }
        requestAnimationFrame(frame);
    }

    function setRunButton(busy, label) {
        const btn = document.getElementById('apply-template-btn');
        const lbl = document.getElementById('apply-template-label');
        if (!btn) return;
        btn.disabled = busy;
        btn.classList.toggle('is-working', busy);
        if (lbl && label) lbl.textContent = label;
    }

    function finishRun(state, tone, message) {
        if (state && tone !== 'done') state.failReason = message;
        localStorage.removeItem('fiton_automation_queue');
        if (state && state.fromWorklist && worklistLineFinished(state, tone === 'done')) {
            setRunButton(false, 'Start template');
            panelMessage(message, tone === 'done' ? 'ok' : 'error');
            return;
        }
        if (state) {
            const times = state.lineTimes || [];
            const done = {
                key: state.shipmentKey, client: state.client, lines: state.items.length,
                booked: state.currentIndex, at: Date.now(),
                /* How long a line really took. Worth keeping: it is the only way
                   to tell whether a change made things quicker, or only felt
                   quicker. */
                lineTimes: times,
                avgMs: times.length ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : null
            };
            try { localStorage.setItem('fiton_last_run', JSON.stringify(done)); } catch (e) {}
            reportRun(done, state, tone, message);
        }
        setRunButton(false, 'Start template');
        setSubStatus('');
        panelMessage(message, tone === 'done' ? 'ok' : 'error');
    }

    async function processQueue() {
        if (isProcessing) return;
        const queueData = localStorage.getItem('fiton_automation_queue');
        if (!queueData) return;

        let state;
        try { state = JSON.parse(queueData); }
        catch (e) { localStorage.removeItem('fiton_automation_queue'); return; }
        if (!state.running) return;

        if (state.mode && SETTINGS.maps[state.mode]) MODE = state.mode;   // resume on the right page

        isProcessing = true;
        createUI();
        const panelEl = document.getElementById('fiton-invoice-helper');
        if (panelEl && panelEl.classList.contains('is-collapsed')) {
            panelEl.classList.remove('is-collapsed');
            const cb = document.getElementById('fip-collapse');
            if (cb) cb.textContent = '−';
        }
        setRunButton(true, 'Bezig…');

        const tp = TIMING;
        const pct = (state.currentIndex / state.items.length) * 100;
        if (!state.waitingForCreateNext && !state.lineStartedAt) state.lineStartedAt = Date.now();

        if (state.waitingForCreateNext) {
            setStatus(`Volgende regel openen (${state.currentIndex}/${state.items.length})`, 'running', pct);

            // --- confirm the line we just clicked Create on actually saved ---
            if (state.rowsBefore !== null && state.rowsBefore !== undefined) {
                const saved = await waitFor(() => {
                    const c = getSavedRowCount();
                    return c !== null && c > state.rowsBefore;
                }, tp.saveWait, 120);

                if (!saved && getSavedRowCount() !== null) {
                    state.saveRetries = (state.saveRetries || 0) + 1;
                    log(`Line did not save (list still at ${getSavedRowCount()} rows) - retrying`);

                    if (state.saveRetries > 3) {
                        isProcessing = false;
                        setStatus('Gestopt: regel werd niet opgeslagen', 'error', pct);
                        finishRun(state, 'error',
                            `Gestopt bij regel ${state.currentIndex}: niet opgeslagen. Volgens de lijst zijn er ${getSavedRowCount()} regel(s). Controleer of een regel is overschreven.`);
                        return;
                    }

                    const onRecord = !getCreateButton() && !!getCreateNextButton();
                    state.currentIndex = Math.max(0, state.currentIndex - 1);
                    state.waitingForCreateNext = onRecord;
                    state.rowsBefore = null;
                    localStorage.setItem('fiton_automation_queue', JSON.stringify(state));
                    await sleep(tp.retry * 2);
                    isProcessing = false;
                    processQueue();
                    return;
                }
                state.rowsBefore = null;
                state.saveRetries = 0;
                if (state.lineStartedAt) {
                    state.lineTimes = (state.lineTimes || []).concat(Date.now() - state.lineStartedAt);
                    state.lineStartedAt = null;
                }
                localStorage.setItem('fiton_automation_queue', JSON.stringify(state));
            }

            // --- drift guard: the queue must never run ahead of the list ---
            const rowsNow = getSavedRowCount();
            if (rowsNow !== null && state.rowsAtStart !== null && state.rowsAtStart !== undefined) {
                const booked = rowsNow - state.rowsAtStart;
                if (state.currentIndex - booked > 1) {
                    isProcessing = false;
                    setStatus('Gestopt: teller liep vooruit op de lijst', 'error', pct);
                    finishRun(state, 'error',
                        `Gestopt: teller stond op regel ${state.currentIndex + 1} maar er zijn ${booked} regel(s) geboekt.`);
                    return;
                }
            }

            /* Not every FitOn page works the same way. On the revenue page a saved
               line is shown in edit mode and you press "Create Next" to open a new
               one. On the cost page the form comes back blank and ready straight
               after Create, so there is no Create Next button to wait for - and
               waiting for one stalls the run. If a usable entry form is already
               open, just carry on. */
            if (!getCreateNextButton() && getCreateButton() && !isEditForm()) {
                log('Fresh entry form already open - no Create Next needed');
                state.waitingForCreateNext = false;
                state.createNextRetries = 0;
                localStorage.setItem('fiton_automation_queue', JSON.stringify(state));
                await sleep(tp.afterCreateNext);
                isProcessing = false;
                processQueue();
                return;
            }

            await waitFor(getCreateNextButton, tp.btnWait, tp.beforeCreateNext);
            const createNextBtn = getCreateNextButton();
            if (createNextBtn) {
                createNextBtn.click();
                // Proof the click landed: a fresh entry form has a Create button.
                const formIsUp = await waitFor(getCreateButton, tp.formWait, 60);
                if (formIsUp) {
                    state.waitingForCreateNext = false;
                    state.createNextRetries = 0;
                    localStorage.setItem('fiton_automation_queue', JSON.stringify(state));
                    await sleep(tp.afterCreateNext);
                    isProcessing = false;
                    processQueue();
                    return;
                }
                log('Create Next click did not open a new line - will click again');
            }

            state.createNextRetries = (state.createNextRetries || 0) + 1;
            setStatus(`Wachten op nieuw formulier (poging ${state.createNextRetries})`, 'running', pct);
            if (state.createNextRetries > 10) {
                isProcessing = false;
                setStatus("Gestopt: 'Create Next' niet gevonden", 'error', pct);
                finishRun(state, 'error',
                    "Gestopt: er kwam geen nieuw invoerformulier terug na het opslaan. "
                    + `Regel ${state.currentIndex} van ${state.items.length} is wel geboekt.`);
                return;
            }
            localStorage.setItem('fiton_automation_queue', JSON.stringify(state));
            await sleep(tp.retry);
            isProcessing = false;
            processQueue();
            return;
        }

        // --- run complete: verify against the list before declaring success ---
        if (state.currentIndex >= state.items.length) {
            const rowsNow = getSavedRowCount();
            const booked = (rowsNow !== null && state.rowsAtStart !== null && state.rowsAtStart !== undefined)
                ? rowsNow - state.rowsAtStart : null;
            isProcessing = false;
            if (booked === null) {
                setStatus(`Klaar — ${state.items.length} regels`, 'done', 100);
                finishRun(state, 'done', `Klaar: ${state.items.length} regels verwerkt (lijst niet leesbaar om te controleren).`);
            } else if (booked === state.items.length) {
                setStatus(`Klaar — ${booked}/${state.items.length} geboekt`, 'done', 100);
                finishRun(state, 'done', `Klaar: alle ${booked} regels staan in de lijst.`);
            } else {
                setStatus(`Klaar met verschil: ${booked}/${state.items.length}`, 'error', 100);
                finishRun(state, 'error', `Let op: ${booked} van de ${state.items.length} regels staan in de lijst. Controleer de zending.`);
            }
            return;
        }

        // --- baseline: rows already on the shipment before this run started ---
        if (state.rowsAtStart === null || state.rowsAtStart === undefined) {
            const base = getSavedRowCount();
            if (base !== null) {
                state.rowsAtStart = base - state.currentIndex;
                localStorage.setItem('fiton_automation_queue', JSON.stringify(state));
                log(`Baseline: ${base} row(s) on the shipment before this run`);
            }
        }

        const currentItem = state.items[state.currentIndex];
        setStatus(`Regel ${state.currentIndex + 1} van ${state.items.length}`, 'running', pct);
        setSubStatus(currentItem.desc || currentItem.ledgerName);

        await fillSingleItem(currentItem);

        // Locate Create BEFORE advancing: if the click never happens, the next
        // line would otherwise be typed over this unsaved one.
        await waitFor(getCreateButton, tp.btnWait, 60);
        const createBtn = getCreateButton();

        if (!createBtn) {
            state.createRetries = (state.createRetries || 0) + 1;

            if (getCreateNextButton()) {
                log('On a saved record, not an entry form - re-opening a new line');
                state.waitingForCreateNext = true;
                state.createNextRetries = 0;
                localStorage.setItem('fiton_automation_queue', JSON.stringify(state));
                await sleep(tp.retry);
                isProcessing = false;
                processQueue();
                return;
            }

            if (state.createRetries > 12) {
                isProcessing = false;
                setStatus('Gestopt: Create knop niet gevonden', 'error', pct);
                finishRun(state, 'error',
                    `Gestopt: Create knop onvindbaar. De regel "${currentItem.desc || currentItem.ledgerName}" is niet geboekt.`);
                return;
            }

            setStatus(`Wachten op Create knop (poging ${state.createRetries})`, 'running', pct);
            localStorage.setItem('fiton_automation_queue', JSON.stringify(state));
            await sleep(tp.retry * 2);
            isProcessing = false;
            processQueue();
            return;
        }

        const rowsBefore = getSavedRowCount();
        state.currentIndex++;
        state.waitingForCreateNext = true;
        state.createNextRetries = 0;
        state.createRetries = 0;
        state.rowsBefore = rowsBefore;
        localStorage.setItem('fiton_automation_queue', JSON.stringify(state));

        if (typeof createBtn.click !== 'function') {
            log('Create button found but not clickable - retrying');
            state.currentIndex--;                       // roll the line back
            state.waitingForCreateNext = false;
            localStorage.setItem('fiton_automation_queue', JSON.stringify(state));
            isProcessing = false;
            return;
        }
        createBtn.click();

        if (rowsBefore !== null) {
            await waitFor(() => {
                const c = getSavedRowCount();
                return c !== null && c > rowsBefore;
            }, tp.afterCreate, 80);
        } else {
            await sleep(tp.afterCreate);
        }
        isProcessing = false;
    }

    function detectClient() {
        const text = (document.body && document.body.innerText) || '';
        const hits = Object.keys(CLIENTS).filter(key =>
            (CLIENTS[key].debtorHints || []).some(h => text.toLowerCase().includes(h.toLowerCase())));
        return hits.length === 1 ? hits[0] : null;   // only act when it is unambiguous
    }

    /* Auto-updates only happen when the extension came from the Web Store or
       from an update_url. Without that a colleague can sit on a version from
       months ago and never know, which on a shared install means booking with
       rules the rest of the department has already moved past. The service
       worker asks the shared project every few hours which version is current;
       this only shows the answer. */
    function paintUpdateNotice(info) {
        const box = document.getElementById('fip-update');
        const ver = document.getElementById('fip-ver');
        if (!box) return;
        if (!info || !info.outdated) {
            box.style.display = 'none';
            if (ver) ver.classList.remove('is-old');
            return;
        }
        box.innerHTML = `<b>Versie ${esc(info.latest)} is er — jij hebt ${esc(info.current || VERSION)}</b>`
            + (info.notes ? `${esc(info.notes)}<br>` : '')
            + 'Werk bij via het icoon van de extensie → Instellingen.';
        box.style.display = 'block';
        if (ver) ver.classList.add('is-old');
    }

    let updateNoticeWatched = false;

    function watchUpdateNotice() {
        try {
            // The panel is rebuilt more than once, so repaint every time...
            chrome.storage.local.get(['versionCheck'], d => paintUpdateNotice(d && d.versionCheck));
            if (updateNoticeWatched) return;      // ...but listen only once
            updateNoticeWatched = true;
            chrome.storage.onChanged.addListener((changes, area) => {
                if (area === 'local' && changes.versionCheck) paintUpdateNotice(changes.versionCheck.newValue);
            });
        } catch (e) { log('Version check unavailable', String(e.message || e)); }
    }

    function createUI() {
        try { buildPanel(); }
        catch (e) {
            // The panel must appear even if one piece of wiring fails.
            console.error('[InvoiceBot] Panel wiring failed:', e);
        }
    }

    function buildPanel() {
        if (document.getElementById('fiton-invoice-helper')) return;

        const container = document.createElement('div');
        container.id = 'fiton-invoice-helper';
        container.className = 'fip-root';
        container.innerHTML = `
            <div class="fip-panel-head" id="fip-drag-handle">
                <span class="fip-dot"></span>
                <span class="fip-panel-title">Factuurregels</span>
                <span class="fip-ver" id="fip-ver">v${VERSION} · ${CURRENCY_CODE}</span>
                <button class="fip-collapse" id="fip-collapse" title="In-/uitklappen">−</button>
            </div>
            <div class="fip-panel-body">
                <div class="fip-modes">
                    <button type="button" class="fip-mode" data-mode="revenue">Omzet</button>
                    <button type="button" class="fip-mode" data-mode="cost">Kosten</button>
                </div>
                <span class="fip-label">Klant</span>
                <select id="template-selector">
                    <option value="">Selecteer klant…</option>
                    ${Object.keys(CLIENTS).map(k => `<option value="${k}">${esc(CLIENTS[k].name)}</option>`).join('')}
                </select>
                <div class="fip-update" id="fip-update" style="display:none;"></div>
                <div class="fip-detected" id="fip-detected" style="display:none;"></div>
                <div class="fip-detected is-quiet" id="fip-pagehint" style="display:none;"></div>
                <div class="fip-detected is-warn" id="fip-automap" style="display:none;">
                    <span id="fip-automap-text"></span>
                </div>
                <button class="fip-btn fip-btn-primary fip-btn-block" id="apply-template-btn" style="margin-top:11px;">
                    <span class="fip-spinner"></span><span id="apply-template-label">Start template</span>
                </button>
                <button class="fip-btn fip-btn-ghost fip-btn-block fip-btn-sm" id="resume-btn" style="margin-top:6px; display:none;">Hervatten</button>
                <button class="fip-btn fip-btn-danger fip-btn-block fip-btn-sm" id="stop-template-btn" style="margin-top:6px;">Stop &amp; herlaad</button>
                <button class="fip-btn fip-btn-ghost fip-btn-block fip-btn-sm" id="spec-import-btn" style="margin-top:6px; display:none;">Facturen inlezen</button>
                <button class="fip-btn fip-btn-ghost fip-btn-block fip-btn-sm" id="report-btn" style="margin-top:6px; display:none;">Laatste rapport</button>
                <button class="fip-btn fip-btn-ghost fip-btn-block fip-btn-sm" id="cred-refresh-btn" style="margin-top:6px; display:none;">Crediteuren verversen</button>
                <button class="fip-btn fip-btn-ghost fip-btn-block fip-btn-sm" id="learn-fields-btn" style="margin-top:6px;">Velden leren</button>
                <div class="fip-message" id="fip-message" style="display:none;"></div>
                <div class="fip-status">
                    <div class="fip-status-line"><span id="fip-status-text">Gereed</span></div>
                    <div class="fip-substatus" id="fip-substatus"></div>
                    <div class="fip-progress-track"><div class="fip-progress-bar" id="fip-progress-bar"></div></div>
                </div>
            </div>`;
        document.body.appendChild(container);

        /* ---- drag the panel by its header, position remembered ---- */
        try {
            const pos = JSON.parse(localStorage.getItem('fiton_panel_pos') || 'null');
            if (pos) {
                container.style.left = Math.min(pos.left, window.innerWidth - 60) + 'px';
                container.style.top = Math.min(pos.top, window.innerHeight - 40) + 'px';
                container.style.right = 'auto';
                container.style.bottom = 'auto';
            }
        } catch (e) { log('Stored panel position unreadable'); }

        const handle = document.getElementById('fip-drag-handle');
        let dragState = null;
        if (handle) {
        handle.addEventListener('pointerdown', e => {
            if (e.target.closest('.fip-collapse')) return;
            const r = container.getBoundingClientRect();
            dragState = { dx: e.clientX - r.left, dy: e.clientY - r.top };
            container.classList.add('is-dragging');
            try { handle.setPointerCapture(e.pointerId); } catch (err) {}
        });
        handle.addEventListener('pointermove', e => {
            if (!dragState) return;
            const left = Math.max(4, Math.min(window.innerWidth - 80, e.clientX - dragState.dx));
            const top = Math.max(4, Math.min(window.innerHeight - 40, e.clientY - dragState.dy));
            container.style.left = left + 'px';
            container.style.top = top + 'px';
            container.style.right = 'auto';
            container.style.bottom = 'auto';
        });
        function endPanelDrag(e) {
            if (!dragState) return;
            dragState = null;
            container.classList.remove('is-dragging');
            try { handle.releasePointerCapture(e.pointerId); } catch (err) {}
            const r = container.getBoundingClientRect();
            localStorage.setItem('fiton_panel_pos', JSON.stringify({ left: Math.round(r.left), top: Math.round(r.top) }));
        }
        handle.addEventListener('pointerup', endPanelDrag);
        handle.addEventListener('pointercancel', endPanelDrag);
        handle.addEventListener('dblclick', () => {
            container.style.left = ''; container.style.top = '';
            container.style.right = ''; container.style.bottom = '';
            localStorage.removeItem('fiton_panel_pos');
        });
        }

        const collapseBtn = document.getElementById('fip-collapse');
        if (collapseBtn && localStorage.getItem('fiton_panel_collapsed') === '1') {
            container.classList.add('is-collapsed');
            collapseBtn.textContent = '+';
        }
        if (collapseBtn) collapseBtn.addEventListener('click', () => {
            const collapsed = container.classList.toggle('is-collapsed');
            collapseBtn.textContent = collapsed ? '+' : '−';
            localStorage.setItem('fiton_panel_collapsed', collapsed ? '1' : '0');
        });

        const selector = document.getElementById('template-selector');
        const detectedBox = document.getElementById('fip-detected');
        const detected = detectClient();
        const lastClient = localStorage.getItem('fiton_last_client');

        if (!selector) { log('Panel markup incomplete - aborting wiring'); return; }
        if (detected) {
            selector.value = detected;
            if (detectedBox) {
                detectedBox.textContent = 'Herkend: ' + CLIENTS[detected].name;
                detectedBox.style.display = 'flex';
                setTimeout(() => { detectedBox.style.display = 'none'; }, 6000);
            }
        } else if (lastClient && CLIENTS[lastClient]) {
            selector.value = lastClient;
        }
        selector.addEventListener('change', clearPanelMessage);

        /* ---- resume an interrupted run ---- */
        function refreshResume() {
            const btn = document.getElementById('resume-btn');
            if (!btn) return;
            const raw = localStorage.getItem('fiton_automation_queue');
            if (!raw) { btn.style.display = 'none'; return; }
            let st;
            try { st = JSON.parse(raw); } catch (e) { btn.style.display = 'none'; return; }
            if (!st.items || st.currentIndex >= st.items.length) { btn.style.display = 'none'; return; }
            btn.style.display = 'block';
            btn.textContent = `Hervat vanaf regel ${st.currentIndex + 1} van ${st.items.length}`;
        }
        refreshResume();

        const _btn_resume_btn = document.getElementById('resume-btn');
        if (_btn_resume_btn) _btn_resume_btn.addEventListener('click', () => {
            const raw = localStorage.getItem('fiton_automation_queue');
            if (!raw) return;
            let st;
            try { st = JSON.parse(raw); } catch (e) { return; }
            st.running = true;
            localStorage.setItem('fiton_automation_queue', JSON.stringify(st));
            clearPanelMessage();
            processQueue();
        });

        const _btn_apply_template_btn = document.getElementById('apply-template-btn');
        if (_btn_apply_template_btn) _btn_apply_template_btn.addEventListener('click', async () => {
            const selected = selector.value;
            if (MODE !== 'cost' && !CLIENTS[selected]) { panelMessage('Selecteer eerst een klant.', 'error'); return; }
            clearPanelMessage();
            localStorage.setItem('fiton_last_client', selected);

            // duplicate-run protection
            let duplicate = null;
            try {
                const last = JSON.parse(localStorage.getItem('fiton_last_run') || 'null');
                if (last && last.key === shipmentKey() && Date.now() - last.at < 6 * 3600 * 1000) duplicate = last;
            } catch (e) {}

            if (duplicate) {
                const when = new Date(duplicate.at).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });
                const who = CLIENTS[duplicate.client] ? CLIENTS[duplicate.client].name : duplicate.client;
                const go = await fipAsk({
                    title: 'Al eerder geboekt op deze zending',
                    message: `Om ${when} is hier al een template gedraaid: ${duplicate.booked} van ${duplicate.lines} regels (${who}).\n\nWeet je zeker dat je opnieuw wilt starten?`,
                    okLabel: 'Toch starten', cancelLabel: 'Annuleren', tone: 'danger'
                });
                if (!go) return;
            }

            const startRun = finalItems => {
                localStorage.setItem('fiton_automation_queue', JSON.stringify({
                    running: true, client: selected, mode: MODE, shipmentKey: shipmentKey(),
                    currentIndex: 0, waitingForCreateNext: false, createNextRetries: 0,
                    createRetries: 0, saveRetries: 0, rowsBefore: null, rowsAtStart: null,
                    items: finalItems
                }));
                processQueue();
            };

            if (MODE === 'cost') {
                showCostModal((opts, items) => {
                    const warnings = [];
                    if (!opts.invoiceNo) warnings.push('Geen factuurnummer ingevuld — de omschrijving valt terug op de kostensoort.');
                    if (opts.combine) warnings.push('Alle kosten staan op één THC-regel; controleer of dat klopt met de carrierfactuur.');
                    if (!items.some(i => i.creditorSeq)) warnings.push('De crediteur wordt niet automatisch ingesteld — controleer dat de juiste crediteur openstaat.');
                    showPreview(selected, items, warnings, startRun);
                });
                return;
            }

            showConfigModal(selected, opts => {
                const items = buildItemsList(selected, opts);
                const warnings = validate(selected, opts, items);
                showPreview(selected, items, warnings, startRun);
            });
        });

        const _btn_stop_template_btn = document.getElementById('stop-template-btn');
        if (_btn_stop_template_btn) _btn_stop_template_btn.addEventListener('click', () => {
            localStorage.removeItem('fiton_automation_queue');
            location.reload();
        });

        /* ---- omzet / kosten ----
           The page decides which side you are booking: a Cost breadcrumb cannot
           take revenue lines and vice versa. So only the tab that matches the
           open page is shown; both appear only when the page is ambiguous. */
        const pageMode = detectMode();
        if (pageMode) MODE = pageMode;

        function paintMode() {
            const kind = pageKind();
            const isEntry = kind === 'entry';

            // On Search or a shipment there is no line form, so only the parts
            // that make sense there are shown.
            const modeBar = container.querySelector('.fip-modes');
            if (modeBar) modeBar.style.display = isEntry ? '' : 'none';

            const runBtn2 = document.getElementById('apply-template-btn');
            if (runBtn2) runBtn2.style.display = isEntry ? '' : 'none';

            const learnBtn2 = document.getElementById('learn-fields-btn');
            if (learnBtn2 && !isEntry) learnBtn2.style.display = 'none';

            // The specification import only runs from Forwarding > Search, because
            // that is where each container gets looked up.
            const specBtn2 = document.getElementById('spec-import-btn');
            if (specBtn2) specBtn2.style.display = (kind === 'search') ? 'block' : 'none';

            // Only where the creditor popup is: a cost line.
            const credBtn = document.getElementById('cred-refresh-btn');
            if (credBtn) credBtn.style.display = document.getElementById(creditorFieldId()) ? 'block' : 'none';
            refreshReportButton();

            const stopBtn = document.getElementById('stop-template-btn');
            if (stopBtn) {
                const busy = !!localStorage.getItem('fiton_automation_queue') || !!loadWorklist();
                stopBtn.style.display = (isEntry || busy) ? '' : 'none';
            }

            const hint = document.getElementById('fip-pagehint');
            if (hint) {
                hint.textContent = kind === 'search'
                    ? 'Zoekpagina — sleep hier een factuur in om kosten te boeken.'
                    : kind === 'shipment'
                        ? 'Zending geopend.'
                        : '';
                hint.style.display = isEntry ? 'none' : 'block';
            }

            if (!isEntry) {
                const clientLabel0 = container.querySelector('.fip-label');
                const clientSelect0 = document.getElementById('template-selector');
                if (clientLabel0) clientLabel0.style.display = 'none';
                if (clientSelect0) clientSelect0.style.display = 'none';
                return;   // nothing else on this page needs painting
            }

            const auto = currentAutoMap();
            const autoBox = document.getElementById('fip-automap');
            const autoText = document.getElementById('fip-automap-text');
            if (auto && auto.page) log(`Page P${auto.page} recognised, fields mapped automatically`);   // console only
            if (autoBox) {
                // Only worth saying when something is wrong; a working page is silent.
                if (!auto || !auto.page) {
                    if (autoText) autoText.textContent = 'Pagina niet herkend — controleer de veldnamen in de instellingen';
                    autoBox.style.display = 'flex';
                } else {
                    autoBox.style.display = 'none';
                }
            }
            container.querySelectorAll('.fip-mode').forEach(b => {
                const mode = b.getAttribute('data-mode');
                b.classList.toggle('is-active', mode === MODE);
                // hide the side this page cannot book
                b.style.display = (pageMode && mode !== pageMode) ? 'none' : '';
            });
            const modeBarEl = container.querySelector('.fip-modes');
            if (modeBarEl) modeBarEl.classList.toggle('is-single', !!pageMode);
            container.classList.toggle('is-cost', MODE === 'cost');
            const clientLabel = container.querySelector('.fip-label');
            const clientSelect = document.getElementById('template-selector');
            if (clientLabel && clientSelect) {
                clientLabel.style.display = MODE === 'cost' ? 'none' : 'block';
                clientSelect.style.display = MODE === 'cost' ? 'none' : 'block';
            }

            const learnBtn = document.getElementById('learn-fields-btn');
            const ready = mapIsConfigured(MODE);
            if (learnBtn) learnBtn.style.display = ready ? 'none' : 'block';   // only needed when auto-mapping fails
            setRunButton(false, MODE === 'cost' ? 'Start kostentemplate' : 'Start template');
            const runBtn = document.getElementById('apply-template-btn');
            if (runBtn) runBtn.disabled = !ready;
            if (!ready) {
                panelMessage(`Deze pagina wordt nog niet herkend. Open de ${SETTINGS.maps[MODE].label.toLowerCase()}pagina in FitOn, of klik "Velden leren" als dat niet helpt.`, 'info');
            } else {
                clearPanelMessage();
            }
        }
        container.querySelectorAll('.fip-mode').forEach(btn => {
            btn.addEventListener('click', () => {
                MODE = btn.getAttribute('data-mode');
                paintMode();
            });
        });
        paintMode();

        const _btn_learn_fields_btn = document.getElementById('learn-fields-btn');
        if (_btn_learn_fields_btn) _btn_learn_fields_btn.addEventListener('click', () => startLearnMode(paintMode));

        const credBtnEl = document.getElementById('cred-refresh-btn');
        if (credBtnEl) credBtnEl.addEventListener('click', async () => {
            if (credBtnEl.disabled) return;
            credBtnEl.disabled = true;
            try { await runCreditorRefresh(); } finally { credBtnEl.disabled = false; }
        });

        const reportBtnEl = document.getElementById('report-btn');
        if (reportBtnEl) reportBtnEl.addEventListener('click', () => {
            const rep = loadLastReport();
            if (rep && rep.worklist) showWorklistReport(rep.worklist);
        });
        refreshReportButton();
        watchUpdateNotice();

        const specBtnEl = document.getElementById('spec-import-btn');
        if (specBtnEl) specBtnEl.addEventListener('click', () => {
            clearPanelMessage();
            showSpecImportModal((transport, items) => {
                const warnings = [];
                if (!items.some(i => i.creditorSeq)) warnings.push('De crediteur wordt niet automatisch ingesteld — controleer dat de juiste crediteur openstaat.');
                if (!transport.onPage) warnings.push(`Referentie ${transport.ref} staat niet op deze pagina — controleer of dit de juiste zending is.`);
                showPreview(selector.value || 'vbfood', items, warnings, finalItems => {
                    localStorage.setItem('fiton_automation_queue', JSON.stringify({
                        running: true, client: selector.value || '', mode: MODE, shipmentKey: shipmentKey(),
                        currentIndex: 0, waitingForCreateNext: false, createNextRetries: 0,
                        createRetries: 0, saveRetries: 0, rowsBefore: null, rowsAtStart: null,
                        items: finalItems
                    }));
                    processQueue();
                });
            });
        });
    }

    /* =========================================================================
       LEARN MODE - click each field on the page once and the extension records
       its id. This is how the cost page gets mapped without anyone reading HTML.
       ========================================================================= */
    function startLearnMode(onDone) {
        if (document.getElementById('fip-learn')) return;
        let step = 0;
        const learnKey = mapKey(MODE);    // a road form learns into costRoad, not cost
        const learned = Object.assign({}, SETTINGS.maps[learnKey]);

        const bar = document.createElement('div');
        bar.id = 'fip-learn';
        bar.className = 'fip-root fip-learn';
        document.body.appendChild(bar);

        function paint() {
            const f = FIELD_KEYS[step];
            bar.innerHTML = `
                <div class="fip-learn-inner">
                    <span class="fip-learn-step">${step + 1}/${FIELD_KEYS.length}</span>
                    <span class="fip-learn-text">Klik op: <b>${esc(f.label)}</b>${f.optional ? ' <i>(optioneel)</i>' : ''}</span>
                    <button type="button" class="fip-btn fip-btn-ghost fip-btn-sm" id="fip-learn-skip">Overslaan</button>
                    <button type="button" class="fip-btn fip-btn-ghost fip-btn-sm" id="fip-learn-cancel">Stoppen</button>
                </div>`;
            bar.querySelector('#fip-learn-skip').addEventListener('click', () => { learned[FIELD_KEYS[step].key] = ''; next(); });
            bar.querySelector('#fip-learn-cancel').addEventListener('click', stop);
        }

        function next() {
            step++;
            if (step >= FIELD_KEYS.length) {
                SETTINGS.maps[learnKey] = learned;
                persistMaps();
                stop();
                panelMessage('Velden opgeslagen. Deze instelling geldt op al je apparaten.', 'ok');
                if (onDone) onDone();
                return;
            }
            paint();
        }

        function onClick(e) {
            if (e.target.closest('#fip-learn') || e.target.closest('#fiton-invoice-helper')) return;
            e.preventDefault();
            e.stopPropagation();
            const node = e.target.closest('[id]');
            if (!node) return;
            learned[FIELD_KEYS[step].key] = node.id;
            log(`Learned ${FIELD_KEYS[step].key} = ${node.id}`);
            next();
        }

        function stop() {
            document.removeEventListener('click', onClick, true);
            document.body.classList.remove('fip-learning');
            if (bar.parentNode) document.body.removeChild(bar);
        }

        document.addEventListener('click', onClick, true);
        document.body.classList.add('fip-learning');
        paint();
    }



    /* =========================================================================
       DEBUG CONSOLE
       -------------------------------------------------------------------------
       Open F12 on a FitOn page and type:  fiton.help()
       Everything the extension knows and does can be inspected from there, so a
       problem can be diagnosed without guessing at what version is running.
       ========================================================================= */
    function installDebugApi() {
        const out = () => ({ logs: [], tables: [], value: undefined });

        const describe = p => {
            const r = out();
            r.logs.push(`crediteur : ${p.creditor ? p.creditor.name + ' (' + p.creditor.seq + ')' : 'niet herkend'}`);
            r.logs.push(`factuur   : ${p.invoiceNo || '-'}`);
            r.logs.push(`controle  : ${p.confidence}${p.note ? ' — ' + p.note : ''}`);
            r.logs.push(`totaal    : ${money(p.calcTotal)}${p.statedTotal !== null ? '  (document: ' + money(p.statedTotal) + ')' : ''}`);
            p.transports.forEach(g => {
                r.tables.push({
                    title: `[${transportName(g) || '-'}${transportFacts(g).length ? ' · ' + transportFacts(g).join(' · ') : ''}]  ${money(g.total)}`,
                    rows: g.lines.map(l => ({
                        omschrijving: l.desc,
                        aantal: l.qty,
                        prijs: l.unitPrice,
                        bedrag: l.amount,
                        grootboek: ledgerForSpecLine(l.desc, l).id,
                        geraden: (ledgerIsGuess(l.desc) && !l.isTransportRow) ? 'ja' : ''
                    }))
                });
            });
            return r;
        };

        let lastRows = null, lastParsed = null;

        const handlers = {
            /* Wat hier draait, en wat de versiecontrole laatst zei. Vraagt het
               meteen opnieuw, zodat je niet op de zesuurscyclus hoeft te wachten. */
            version: () => new Promise(resolve => {
                const r = out();
                r.value = VERSION;
                r.logs.push(`FitOn Invoice Automation v${VERSION}`);
                try {
                    chrome.runtime.sendMessage({ type: 'checkVersion' }, info => {
                        if (chrome.runtime.lastError || !info) {
                            r.logs.push('Versiecontrole gaf geen antwoord.');
                            return resolve(r);
                        }
                        r.tables.push({ title: 'versiecontrole', rows: [{
                            hier: info.current || VERSION,
                            nieuwste: info.latest || '-',
                            verouderd: info.outdated ? 'ja' : 'nee',
                            bron: info.source || (info.configured ? '-' : 'niets ingesteld'),
                            gecontroleerd: info.checkedAt ? new Date(info.checkedAt).toLocaleString('nl-NL') : '-',
                            fout: info.error || '-'
                        }] });
                        resolve(r);
                    });
                } catch (e) {
                    r.logs.push('Versiecontrole niet bereikbaar: ' + e.message);
                    resolve(r);
                }
            }),

            help: () => {
                const r = out();
                r.logs.push([
                    `FitOn Invoice Automation v${VERSION}`,
                    '',
                    '  fiton.info()          welke pagina, welke velden, welke knoppen',
                    '  fiton.version()       draai je de nieuwste versie?',
                    '  fiton.readFile()      kies één of meer facturen en zie wat eruit komt',
                    '  fiton.readText(`…`)   idem voor geplakte tekst',
                    '  fiton.rows()          de gelezen regels met posities',
                    '  fiton.parsed()        het laatste leesresultaat',
                    '  fiton.creditors()     hoeveel crediteuren bekend zijn',
                    '  fiton.marks()         geleerde kenmerken (logo, klantnr) per crediteur',
                    '  fiton.capture(true)   POST-verzoeken opnemen (overleeft de refresh van APEX)',
                    '  fiton.requests()      opgenomen verzoeken tonen; ("clear") wist ze',
                    '  fiton.refreshCreditors()  crediteuren opnieuw uit FitOn lezen (op een kostenregel)',
                    '  fiton.ledger("Tol")   welk grootboek een omschrijving krijgt',
                    '  fiton.state()         lopende boekrun en werklijst',
                    '  fiton.timing()        hoe lang elke regel duurde in de laatste run',
                    '  fiton.diagnose()      waarom een PDF niet gelezen werd'
                ].join('\n'));
                return r;
            },

            info: () => {
                const r = out();
                const map = F();
                r.tables.push({ title: 'status', rows: [{
                    versie: VERSION,
                    pagina: pageKind() || 'niet herkend',
                    modus: MODE,
                    apexPagina: apexPageId() || '-',
                    grootboekveld: map.ledger || '-',
                    createKnop: getCreateButton() ? 'gevonden' : 'niet gevonden',
                    createNextKnop: getCreateNextButton() ? 'gevonden' : 'niet gevonden',
                    crediteuren: CREDITORS.length,
                    zoekveldShipmentId: onSearchPage() ? ((shipmentIdField() || {}).id || 'niet gevonden') : '-',
                    regelsInLijst: getSavedRowCount()
                }] });
                return r;
            },

            readText: text => {
                if (!text) { const r = out(); r.logs.push('Geef tekst mee: fiton.readText(`…`)'); return r; }
                lastRows = rowsFromText(text);
                lastParsed = parseInvoiceRows(lastRows);
                return describe(lastParsed);
            },

            diagnose: () => {
                const r = out();
                const d = lastPdfDiagnosis;
                if (!d) { r.logs.push('Nog geen PDF gelezen — gebruik eerst fiton.readFile()'); return r; }
                r.tables.push({ title: 'laatste PDF-lezing', rows: [d] });
                return r;
            },

            /* One file, or a stack of them: with several, each gets a line of
               its own and the last one stays loaded for fiton.rows(). */
            readFile: () => new Promise(resolve => {
                const input = document.createElement('input');
                input.type = 'file';
                input.accept = '.pdf,.txt';
                input.multiple = true;
                input.onchange = async () => {
                    const files = [...input.files];
                    if (!files.length) { const r = out(); r.logs.push('Geen bestand gekozen.'); return resolve(r); }
                    if (files.length === 1) {
                        const file = files[0];
                        try {
                            const doc = await readDroppedFile(file);
                            lastRows = doc.rows;
                            lastParsed = parseInvoiceRows(doc.rows, doc.imageHashes || []);
                            const r = describe(lastParsed);
                            r.logs.unshift(`${file.name}: ${doc.rows.length} regels gelezen`);
                            return resolve(r);
                        } catch (e) {
                            const r = out();
                            r.logs.push(`Lezen mislukt: ${e.message}`);
                            return resolve(r);
                        }
                    }
                    const r = out();
                    r.logs.push(`${files.length} bestanden:`);
                    for (const file of files) {
                        try {
                            const doc = await readDroppedFile(file);
                            const parsed = parseInvoiceRows(doc.rows, doc.imageHashes || []);
                            lastRows = doc.rows;
                            lastParsed = parsed;
                            r.logs.push(`  ${file.name}: ${parsed.transports.length} zending(en), `
                                + `${parsed.transports.reduce((n, t) => n + t.lines.length, 0)} regels, `
                                + `${money(parsed.calcTotal)}, factuur ${parsed.invoiceNo || '-'}, `
                                + `${parsed.creditor ? parsed.creditor.name : 'crediteur onbekend'}`
                                + `${parsed.confidence === 'exact' ? ' ✓' : ' (totaal niet geverifieerd)'}`);
                        } catch (e) {
                            r.logs.push(`  ${file.name}: lezen mislukt — ${e.message}`);
                        }
                    }
                    resolve(r);
                };
                input.click();
                const r = out();
                r.logs.push('Kies één of meer bestanden in het venster…');
                // the picker resolves later; this keeps the console responsive
            }),

            rows: () => {
                const r = out();
                if (!lastRows) { r.logs.push('Nog niets gelezen — gebruik fiton.readFile()'); return r; }
                r.tables.push({ title: `${lastRows.length} regels`, rows: lastRows.map(x => ({
                    tekst: x.raw.slice(0, 90), cellen: x.cells.length
                })) });
                return r;
            },

            parsed: () => (lastParsed ? describe(lastParsed) : (() => { const r = out(); r.logs.push('Nog niets gelezen.'); return r; })()),

            refreshCreditors: async () => {
                const r = out();
                const res = await refreshCreditorsFromFitOn(t => r.logs.push(t));
                r.logs.push(res.error ? `NIET opgeslagen: ${res.error}`
                    : `${res.meta.read} gelezen, ${res.meta.added} nieuw, ${res.meta.updated} bijgewerkt, ${res.meta.total} opgeslagen`
                      + (res.partial ? ' (Show More bleef hangen: mogelijk onvolledig)' : ''));
                r.tables.push({ title: 'kolommen', rows: res.headers.map((h, i) =>
                    ({ kolom: h, veld: Object.keys(res.map).find(k => res.map[k] === i) || '-' })) });
                r.tables.push({ title: 'eerste rijen zoals gelezen', rows: res.sample });
                r.tables.push({ title: 'controle tegen ingebouwde lijst', rows: [{ klopt: res.check.ok, afwijkend: res.check.bad.join('; ') || '-' }] });
                r.value = res.meta ? res.meta.total : 0;
                return r;
            },

            marks: () => {
                const r = out();
                const known = Object.entries(CREDITOR_MARKS).map(([mark, v]) =>
                    ({ kenmerk: mark, crediteur: v.name || v.seq, seq: v.seq, genegeerd: v.conflicting ? 'ja (botst)' : '' }));
                r.tables.push({ title: `geleerde kenmerken (${known.length})`, rows: known });
                r.value = known.length;
                return r;
            },


            capture: flag => {
                const r = out();
                const on = flag !== false;
                try { localStorage.setItem('fiton_capture', on ? '1' : '0'); } catch (e) {}
                r.logs.push(on
                    ? 'Opnemen staat AAN. Maak nu één kostenregel aan; na de refresh: fiton.requests().'
                    : 'Opnemen staat UIT.');
                r.logs.push('Let op: de opgenomen bodies bevatten sessietokens. fiton.requests("clear") wist ze.');
                r.value = on;
                return r;
            },

            requests: what => {
                const r = out();
                if (what === 'clear') {
                    try { localStorage.removeItem('fiton_requests'); } catch (e) {}
                    r.logs.push('Opnames gewist.');
                    r.value = 0;
                    return r;
                }

                let list = [];
                try { list = JSON.parse(localStorage.getItem('fiton_requests') || '[]'); } catch (e) {}

                /* fiton.requests(3) prints one request whole. APEX hides the
                   page values inside p_json, so that is unpacked here: which
                   items were submitted, and which of the rest are tokens. */
                if (typeof what === 'number') {
                    const q = list[what];
                    if (!q) { r.logs.push(`Geen opname nummer ${what}.`); return r; }
                    r.logs.push(`${q.method} ${q.url}`);
                    r.logs.push(`${q.kind} · ${new Date(q.at).toLocaleString('nl-NL')} · status ${q.status === null ? '(navigatie)' : q.status}`);
                    const pairs = (q.body && q.body.pairs) || [];
                    pairs.forEach(([k, v]) => {
                        const items = apexItemsIn(v);
                        if (items) {
                            r.tables.push({ title: `${k} → ingezonden items`, rows: items });
                            r.logs.push(`${k}: ${String(v).length} tekens (zie tabel)`);
                        } else {
                            r.logs.push(`${k} = ${v}`);
                        }
                    });
                    if (!pairs.length && q.body && q.body.raw) r.logs.push(q.body.raw);
                    if (q.response) r.logs.push('Antwoord: ' + q.response);
                    r.value = q;
                    return r;
                }
                if (!list.length) {
                    r.logs.push(localStorage.getItem('fiton_capture') === '1'
                        ? 'Niets opgenomen. Het opnemen staat aan — maak een kostenregel aan en kijk daarna opnieuw.'
                        : 'Niets opgenomen. Zet het eerst aan met fiton.capture(true).');
                    return r;
                }

                r.tables.push({
                    title: `${list.length} verzoek(en), oudste eerst`,
                    rows: list.map((q, i) => ({
                        nr: i, tijd: new Date(q.at).toLocaleTimeString('nl-NL'), soort: q.kind,
                        methode: q.method, url: String(q.url).replace(/^https?:\/\/[^/]+/, ''),
                        velden: (q.body && q.body.pairs ? q.body.pairs.length : 0),
                        status: q.status === null ? '(navigatie)' : q.status
                    }))
                });

                /* The interesting one is the last POST that carries page items:
                   that is the create. Its fields are printed in full, because
                   the question is which of them are values and which are tokens. */
                const posts = list.filter(q => q.method === 'POST');
                const last = posts[posts.length - 1];
                if (last) {
                    r.logs.push(`Laatste POST: ${last.method} ${last.url}`);
                    const pairs = (last.body && last.body.pairs) || [];
                    if (pairs.length) {
                        // p_request is the action (CREATE), not a token
                        const CHECKSUM = /checksum|md5|p_instance|p_page_submission_id|salt|token|csrf/i;
                        r.tables.push({
                            title: 'velden in die POST',
                            rows: pairs.map(([k, v]) => ({
                                veld: k,
                                waarde: String(v).length > 80 ? String(v).slice(0, 80) + '…' : String(v),
                                soort: CHECKSUM.test(k) ? 'token/checksum'
                                     : /^p_request$/i.test(k) ? 'actie'
                                     : /^p_/i.test(k) ? 'APEX' : 'waarde'
                            }))
                        });
                        const tokens = pairs.filter(([k]) => CHECKSUM.test(k)).map(([k]) => k);
                        r.logs.push(tokens.length
                            ? `Beveiligd met: ${[...new Set(tokens)].join(', ')} — die horen bij één paginaweergave, `
                              + 'dus een POST napraten kan alleen met tokens uit een net geladen pagina.'
                            : 'Geen checksum- of tokenvelden gezien in deze POST.');
                    } else if (last.body && last.body.raw) {
                        r.logs.push('Body (ingekort): ' + String(last.body.raw).slice(0, 1500));
                    }
                    if (last.response) r.logs.push('Antwoord (ingekort): ' + last.response.slice(0, 500));
                }

                r.logs.push('fiton.requests(18) toont één verzoek helemaal, inclusief de items uit p_json.');
                r.logs.push('Volledige opname als JSON staat hieronder; rechtsklik > Copy object.');
                r.value = list;
                return r;
            },

            creditors: () => {
                const r = out();
                r.logs.push(`${CREDITORS.length} crediteuren bekend`);
                r.tables.push({ rows: CREDITORS.slice(0, 25).map(c => ({ seq: c.seq, code: c.code, naam: c.name })) });
                r.value = CREDITORS.length;
                return r;
            },

            ledger: desc => {
                const r = out();
                const led = ledgerForSpecLine(String(desc || ''));
                r.logs.push(`"${desc}"  ->  ${led.id}  ${led.name}${ledgerIsGuess(desc) ? '   (geraden)' : ''}`);
                r.value = led.id;
                return r;
            },

            timing: () => {
                const r = out();
                let last = null;
                try { last = JSON.parse(localStorage.getItem('fiton_last_run') || 'null'); } catch (e) {}
                if (!last || !last.lineTimes || !last.lineTimes.length) {
                    r.logs.push('Nog geen tijden gemeten. Draai eerst een boekrun met deze versie.');
                    return r;
                }
                const t = last.lineTimes;
                const sorted = [...t].sort((a, b) => a - b);
                r.tables.push({ title: 'seconden per regel', rows: t.map((ms, i) => ({ regel: i + 1, seconden: (ms / 1000).toFixed(1) })) });
                r.logs.push(`${t.length} regels · gemiddeld ${(last.avgMs / 1000).toFixed(1)}s · `
                          + `snelste ${(sorted[0] / 1000).toFixed(1)}s · traagste ${(sorted[sorted.length - 1] / 1000).toFixed(1)}s · `
                          + `samen ${(t.reduce((a, b) => a + b, 0) / 1000).toFixed(0)}s`);
                r.value = last;
                return r;
            },

            state: () => {
                const r = out();
                const queue = localStorage.getItem('fiton_automation_queue');
                const work = loadWorklist();
                r.logs.push('boekrun: ' + (queue ? `regel ${JSON.parse(queue).currentIndex + 1} van ${JSON.parse(queue).items.length}` : 'geen'));
                r.logs.push('werklijst: ' + (work ? `zending ${work.index + 1} van ${work.items.length} (factuur ${work.invoiceNo || '-'})` : 'geen'));
                if (work) r.tables.push({ rows: work.items.map(i => ({
                    zending: transportName(i), details: transportFacts(i).join(' · '), bedrag: i.total, status: i.status, reden: i.reason || ''
                })) });
                return r;
            }
        };

        // Available in the extension's own console context...
        try { Object.defineProperty(window, 'fiton', { value: handlers, configurable: true }); }
        catch (e) { window.fiton = handlers; }

        // ...and in the page context, through the injected bridge.
        window.addEventListener('fiton-debug-request', async event => {
            const { id, method, args } = event.detail || {};
            const reply = detail => window.dispatchEvent(new CustomEvent('fiton-debug-response', { detail }));
            try {
                const fn = handlers[method];
                if (!fn) return reply({ id, ok: false, error: `onbekend commando: ${method}` });
                const result = await fn.apply(null, args || []);
                reply({ id, ok: true, result: JSON.parse(JSON.stringify(result || {})) });
            } catch (e) {
                reply({ id, ok: false, error: e.message });
            }
        });

        try {
            const tag = document.createElement('script');
            tag.src = chrome.runtime.getURL('content/page-debug.js');
            tag.onload = () => tag.remove();
            (document.head || document.documentElement).appendChild(tag);
        } catch (e) {
            log('Page bridge could not be injected: ' + e.message);
        }
    }

    /* =========================================================================
       BOOT - the panel should be there the moment the revenue page is, not a
       second later. Three triggers: an immediate check on load, a fast poll,
       and a MutationObserver for APEX rendering the region asynchronously.
       ========================================================================= */

    let lastPageState = null;

    function tick() {
        const onRevenue = isEntryPage();
        const queueData = localStorage.getItem('fiton_automation_queue');

        if (onRevenue) {
            createUI();
            // Only an entry form has fields to wait for. On Search or a shipment
            // the panel is immediately usable - the import does not need a form.
            markFormReady(pageKind() === 'entry' ? !!el('ledger') : true);
            if (queueData) {
                let state;
                try { state = JSON.parse(queueData); }
                catch (e) { localStorage.removeItem('fiton_automation_queue'); return; }
                if (state.running && !isProcessing) processQueue();
            } else if (loadWorklist()) {
                runWorklist();
            }
        } else {
            const ui = document.getElementById('fiton-invoice-helper');
            if (ui && !queueData) ui.remove();
        }
        lastPageState = onRevenue;
    }

    // Marks the panel as usable only once the form fields actually exist, so the
    // Start button can never be pressed against a half-rendered page.
    function markFormReady(ready) {
        const body = document.querySelector('#fiton-invoice-helper .fip-panel-body');
        if (!body) return;
        const skeleton = document.getElementById('fip-skeleton');
        if (ready) {
            body.classList.remove('fip-waiting');
            if (skeleton) skeleton.remove();
            if (!localStorage.getItem('fiton_automation_queue') && !loadWorklist()) {
                const txt = document.getElementById('fip-status-text');
                if (txt && txt.textContent === 'Pagina laden…') setStatus('Gereed', null, 0);
            }
        } else {
            body.classList.add('fip-waiting');
            setStatus('Pagina laden…', null, 0);
        }
    }

    let rafPending = false, lastTick = 0;
    function scheduleTick() {
        if (rafPending) return;
        const wait = Math.max(0, 250 - (Date.now() - lastTick));   // throttle: our own
        rafPending = true;                                          // field writes also
        setTimeout(() => {                                          // fire mutations
            requestAnimationFrame(() => { rafPending = false; lastTick = Date.now(); tick(); });
        }, wait);
    }

    try { localStorage.removeItem('fiton_hide_automap'); } catch (e) {}   // no longer used
    log(`FitOn invoice automation v${VERSION} loading`);
    installDebugApi();

    // Settings live in chrome.storage.sync so they follow the user between
    // machines. Paint with the built-in defaults, then repaint once they arrive.
    tick();
    loadSettings().then(loadCreditors).then(loadCreditorMarks).then(loadRemoteRates).then(() => {
        log('Settings loaded', { cost: mapIsConfigured('cost') ? 'mapped' : 'not mapped yet' });
        const panel = document.getElementById('fiton-invoice-helper');
        if (panel) panel.remove();     // rebuild with the stored maps applied
        tick();
    });

    document.addEventListener('DOMContentLoaded', scheduleTick);
    window.addEventListener('load', scheduleTick);
    window.addEventListener('pageshow', scheduleTick);

    // APEX swaps regions in without a navigation, so watch the DOM as well.
    try {
        const observer = new MutationObserver(scheduleTick);
        observer.observe(document.documentElement, { childList: true, subtree: true });
    } catch (e) { log('MutationObserver unavailable'); }

    // Fast poll for the first 30s after load (covers slow region rendering),
    // then settle into a cheap 1s heartbeat.
    const bootedAt = Date.now();
    let pollHandle = setInterval(() => {
        tick();
        if (Date.now() - bootedAt > 30000) {
            clearInterval(pollHandle);
            pollHandle = setInterval(tick, 1000);
        }
    }, 200);

})();
