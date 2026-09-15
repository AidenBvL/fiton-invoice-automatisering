/* Settings page. Field maps are stored in chrome.storage.sync so a colleague
   who signs into Chrome on another machine keeps the same setup. */

const FIELD_KEYS = [
  { key: 'ledger',         label: 'Grootboek (zichtbaar veld)' },
  { key: 'ledgerHidden',   label: 'Grootboek (verborgen waarde)' },
  { key: 'qty',            label: 'Aantal' },
  { key: 'price',          label: 'Prijs' },
  { key: 'desc',           label: 'Omschrijving' },
  { key: 'vat',            label: 'BTW-code' },
  { key: 'currency',       label: 'Valuta' },
  { key: 'amount',         label: 'Bedrag (voor btw-berekening)' },
  { key: 'vatAmount',      label: 'Btw-bedrag' },
  { key: 'creditor',       label: 'Crediteur (zichtbaar veld)' },
  { key: 'creditorHidden', label: 'Crediteur (verborgen waarde)' },
  { key: 'createBtn',      label: 'Knop: opslaan (Create)' },
  { key: 'createNextBtn',  label: 'Knop: volgende regel (Create Next)' },
  { key: 'breadcrumb',     label: 'Breadcrumb-tekst van de pagina' }
];

const DEFAULT_MAPS = {
  revenue: {
    label: 'Omzet', breadcrumb: 'Revenue',
    ledger: 'P674_LEDGER_SEQ', ledgerHidden: 'P674_LEDGER_SEQ_HIDDENVALUE',
    qty: 'P674_QUANTITY', price: 'P674_PRICE', desc: 'P674_DESCRIPTION',
    vat: 'P674_VAT_SEQ', currency: 'P674_CURRENCY_SEQ',
    amount: 'P674_AMOUNT', vatAmount: 'P674_VAT_AMOUNT',
    createBtn: 'B59420024908124917', createNextBtn: 'B268178700524764320'
  },
  cost: {
    // Confirmed on FitOn: the cost entry form is APEX page 673.
    label: 'Kosten', breadcrumb: 'Cost',
    ledger: 'P673_LEDGER_SEQ', ledgerHidden: 'P673_LEDGER_SEQ_HIDDENVALUE',
    qty: 'P673_QUANTITY', price: 'P673_PRICE', desc: 'P673_DESCRIPTION',
    vat: 'P673_VAT_SEQ', currency: 'P673_CURRENCY_SEQ',
    amount: 'P673_AMOUNT', vatAmount: 'P673_VAT_AMOUNT',
    creditor: 'P673_CREDITOR_RELATION_SEQ', creditorHidden: 'P673_CREDITOR_RELATION_SEQ_HIDDENVALUE',
    createBtn: 'B59359322609116685', createNextBtn: 'B268178818434764321'
  },
  costRoad: {
    // Road shipment: Financials > Costs > Create opens page 3708. Buttons are
    // found by their label.
    label: 'Kosten', breadcrumb: 'Cost',
    ledger: 'P3708_LEDGER_SEQ', ledgerHidden: 'P3708_LEDGER_SEQ_HIDDENVALUE',
    qty: 'P3708_QUANTITY', price: 'P3708_PRICE', desc: 'P3708_DESCRIPTION',
    vat: 'P3708_VAT_SEQ', currency: 'P3708_CURRENCY_SEQ',
    amount: 'P3708_AMOUNT', vatAmount: 'P3708_VAT_AMOUNT',
    creditor: 'P3708_CREDITOR_RELATION_SEQ', creditorHidden: 'P3708_CREDITOR_RELATION_SEQ_HIDDENVALUE'
  },
  revenueRoad: {
    // Page number not confirmed yet: fields are found automatically.
    label: 'Omzet', breadcrumb: 'Revenue'
  }
};

// Same as DEFAULT_PAGES in content/invoice.js: where a worklist finds the Costs region.
const DEFAULT_PAGES = { costs: ['606', '3706'], financials: ['3701'], roadForms: ['3708'] };
const pagesText = list => (list || []).join(', ');
const parsePages = text => text.split(/[\s,;]+/).filter(Boolean);

const $ = id => document.getElementById(id);
const REQUIRED = ['ledger', 'qty', 'price', 'desc', 'createBtn'];

function renderFields(container, mode, map) {
  container.innerHTML = FIELD_KEYS.map(f => `
    <div class="row">
      <label for="${mode}-${f.key}">${f.label}</label>
      <input type="text" id="${mode}-${f.key}" data-mode="${mode}" data-key="${f.key}"
             value="${(map[f.key] || '').replace(/"/g, '&quot;')}" placeholder="—">
    </div>`).join('');
}

function readFields(mode, base) {
  const map = Object.assign({}, base);
  document.querySelectorAll(`input[data-mode="${mode}"]`).forEach(inp => {
    map[inp.getAttribute('data-key')] = inp.value.trim();
  });
  return map;
}

function paintState(maps) {
  const done = REQUIRED.every(k => !!maps.cost[k]);
  const badge = $('cost-state');
  badge.textContent = done ? 'ingesteld' : 'nog niet ingesteld';
  badge.className = 'badge' + (done ? '' : ' warn');

  [['rev-state', 'revenue'], ['revroad-state', 'revenueRoad'], ['costroad-state', 'costRoad']].forEach(([id, mode]) => {
    const custom = JSON.stringify(maps[mode]) !== JSON.stringify(DEFAULT_MAPS[mode]);
    if ($(id)) $(id).textContent = custom ? 'aangepast' : 'standaard';
  });
}

function status(text, cls) {
  const el = $('status');
  el.textContent = text;
  el.className = 'status ' + (cls || '');
  if (text) setTimeout(() => { el.textContent = ''; }, 4000);
}

let current = JSON.parse(JSON.stringify(DEFAULT_MAPS));

chrome.runtime.sendMessage({ type: 'getVersion' }, res => {
  if (res && res.version) $('version').textContent = res.version;
});

if (new URLSearchParams(location.search).get('first')) $('first-run').style.display = 'block';

function paintDashboardState() {
  const linked = $('supabaseUrl').value.trim() && $('supabaseKey').value.trim();
  const own = !linked && $('dashboardUrl').value.trim();
  $('dash-state').textContent = linked ? 'Supabase' : own ? 'eigen server' : 'niet gekoppeld';
  $('dash-state').className = 'badge' + (linked || own ? '' : ' warn');
}

chrome.storage.sync.get(['maps', 'pages', 'ratesUrl', 'versionUrl', 'defaultMode', 'supabaseUrl', 'supabaseKey', 'dashboardUrl', 'dashboardToken', 'dashboardSendDocument'], data => {
  $('supabaseUrl').value = data.supabaseUrl || '';
  $('supabaseKey').value = data.supabaseKey || '';
  const pages = Object.assign({}, DEFAULT_PAGES, data.pages || {});
  $('pagesCosts').value = pagesText(pages.costs);
  $('pagesFinancials').value = pagesText(pages.financials);
  $('pagesRoadForms').value = pagesText(pages.roadForms);
  $('dashboardUrl').value = data.dashboardUrl || '';
  $('dashboardToken').value = data.dashboardToken || '';
  $('dashboardSendDocument').checked = !!data.dashboardSendDocument;
  paintDashboardState();
  if (data.maps) {
    Object.keys(DEFAULT_MAPS).forEach(mode => {
      current[mode] = Object.assign({}, DEFAULT_MAPS[mode], data.maps[mode] || {});
    });
  }
  $('ratesUrl').value = data.ratesUrl || '';
  $('versionUrl').value = data.versionUrl || '';
  $('defaultMode').value = data.defaultMode || 'revenue';
  renderFields($('rev-fields'), 'revenue', current.revenue);
  renderFields($('cost-fields'), 'cost', current.cost);
  renderFields($('revroad-fields'), 'revenueRoad', current.revenueRoad);
  renderFields($('costroad-fields'), 'costRoad', current.costRoad);
  paintState(current);
});

$('save').addEventListener('click', () => {
  const maps = {
    revenue: readFields('revenue', DEFAULT_MAPS.revenue),
    cost: readFields('cost', DEFAULT_MAPS.cost),
    revenueRoad: readFields('revenueRoad', DEFAULT_MAPS.revenueRoad),
    costRoad: readFields('costRoad', DEFAULT_MAPS.costRoad)
  };
  maps.revenue.label = maps.revenueRoad.label = 'Omzet';
  maps.cost.label = maps.costRoad.label = 'Kosten';

  const url = $('ratesUrl').value.trim();
  if (url && !/^https:\/\//i.test(url)) {
    status('De tarieven-URL moet met https:// beginnen.', 'err');
    return;
  }

  const versionUrl = $('versionUrl').value.trim();
  if (versionUrl && !/^https:\/\//i.test(versionUrl)) {
    status('De versie-URL moet met https:// beginnen.', 'err');
    return;
  }

  const pages = {
    costs: parsePages($('pagesCosts').value),
    financials: parsePages($('pagesFinancials').value),
    roadForms: parsePages($('pagesRoadForms').value)
  };
  if (Object.values(pages).flat().some(p => !/^\d+$/.test(p))) {
    status("Paginanummers mogen alleen cijfers zijn, gescheiden door komma's.", 'err');
    return;
  }
  Object.keys(pages).forEach(k => { if (!pages[k].length) pages[k] = DEFAULT_PAGES[k].slice(); });

  const dashboardUrl = $('dashboardUrl').value.trim();
  // http:// is allowed here: an internal dashboard often has no certificate
  if (dashboardUrl && !/^https?:\/\//i.test(dashboardUrl)) {
    status('Het dashboardadres moet met http:// of https:// beginnen.', 'err');
    return;
  }

  const supabaseUrl = $('supabaseUrl').value.trim().replace(/\/+$/, '');
  const supabaseKey = $('supabaseKey').value.trim();
  if (supabaseUrl && !/^https:\/\//i.test(supabaseUrl)) {
    status('De Supabase Project URL moet met https:// beginnen.', 'err');
    return;
  }

  // Without access to these addresses Chrome blocks the report. Asked here,
  // while the click still counts as a user gesture.
  const origins = [supabaseUrl, dashboardUrl, versionUrl].filter(Boolean).map(address => {
    try { const u = new URL(address); return `${u.protocol}//${u.hostname}/*`; } catch (e) { return null; }
  }).filter(Boolean);
  if (origins.length) chrome.permissions.request({ origins }, granted => {
    if (!granted) status('Geen toegang tot het dashboardadres gekregen: rapporten blijven in de wachtrij.', 'err');
  });

  chrome.storage.sync.set({ maps, pages, ratesUrl: url, versionUrl, defaultMode: $('defaultMode').value,
                            supabaseUrl, supabaseKey,
                            dashboardUrl, dashboardToken: $('dashboardToken').value.trim(),
                            dashboardSendDocument: $('dashboardSendDocument').checked }, () => {
    if (chrome.runtime.lastError) {
      status('Opslaan mislukt: ' + chrome.runtime.lastError.message, 'err');
      return;
    }
    current = maps;
    paintState(maps);
    status('Opgeslagen ✓', 'ok');
  });
});

['supabaseUrl', 'supabaseKey', 'dashboardUrl'].forEach(id => $(id).addEventListener('input', paintDashboardState));

// Tests what is typed, saved or not, so a wrong key shows before anyone relies on it.
$('dash-test').addEventListener('click', async () => {
  const box = $('dash-result');
  box.textContent = 'Bezig met testen…';
  try {
    const results = await FitonSupabase.test({ supabaseUrl: $('supabaseUrl').value, supabaseKey: $('supabaseKey').value });
    box.innerHTML = results.map(r => `<div style="color:${r.ok ? 'var(--ok)' : 'var(--danger)'}">`
      + `${r.ok ? '✓' : '✗'} ${r.label}${r.ok ? '' : ' — ' + r.error.replace(/</g, '&lt;')}</div>`).join('')
      + (results.every(r => r.ok) ? '' : '<div>Draai supabase/setup.sql in de SQL Editor van Supabase en controleer URL en key.</div>');
  } catch (e) {
    box.innerHTML = `<div style="color:var(--danger)">✗ ${e.message.replace(/</g, '&lt;')}</div>`;
  }
});

$('dash-open').addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('ui/dashboard.html') }));

$('check').addEventListener('click', () => {
  status('Bezig met controleren…');
  chrome.runtime.sendMessage({ type: 'checkForUpdate' }, res => {
    if (!res) { status('Controle mislukt.', 'err'); return; }
    const latest = res.latest || {};
    paintVersionCheck(latest);
    if (res.status === 'update_available') status('Update gevonden — wordt geïnstalleerd.', 'ok');
    else if (latest.outdated) status(`Versie ${latest.latest} is beschikbaar — zie Versiecontrole.`, 'err');
    else if (res.status === 'no_update' || latest.latest) status('Je hebt de nieuwste versie.', 'ok');
    else if (!latest.configured) status('Niets om aan te vragen welke versie de nieuwste is — zie Versiecontrole.', 'err');
    else status('Nog geen versie bekend om tegen te vergelijken.');
  });
});

$('reset').addEventListener('click', () => {
  if (!confirm('Kostenvelden wissen? Je moet ze dan opnieuw leren.')) return;
  const maps = Object.assign({}, current, {
    cost: Object.assign({}, DEFAULT_MAPS.cost),
    costRoad: Object.assign({}, DEFAULT_MAPS.costRoad)
  });
  chrome.storage.sync.set({ maps }, () => {
    current = maps;
    renderFields($('cost-fields'), 'cost', maps.cost);
    renderFields($('costroad-fields'), 'costRoad', maps.costRoad);
    paintState(maps);
    status('Kostenvelden gewist.', 'ok');
  });
});


/* ---- creditors ---------------------------------------------------------- */
function paintCreditors(list, meta) {
  const badge = $('cred-state');
  badge.textContent = (list && list.length) ? `${list.length} opgeslagen` : 'ingebouwd';
  badge.className = 'badge';
  const when = $('cred-when');
  if (when) {
    when.textContent = meta && meta.at
      ? `Laatst ververst uit FitOn: ${new Date(meta.at).toLocaleString('nl-NL', { dateStyle: 'medium', timeStyle: 'short' })}`
        + ` — ${meta.read} gelezen, ${meta.added} nieuw${meta.partial ? ' (mogelijk onvolledig)' : ''}`
      : 'Nog niet ververst uit FitOn.';
  }
}

chrome.storage.local.get(['creditors', 'creditorsMeta'], d => {
  const list = Array.isArray(d.creditors) ? d.creditors : null;
  paintCreditors(list, d.creditorsMeta);
  if (list) $('creditors').value = JSON.stringify(list, null, 1);
});

$('cred-save').addEventListener('click', () => {
  const raw = $('creditors').value.trim();
  if (!raw) { status('Niets om op te slaan.', 'err'); return; }
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (e) { status('Dit is geen geldige JSON.', 'err'); return; }

  // accept both the array and the code -> seq object the console script prints
  let list = [];
  if (Array.isArray(parsed)) {
    list = parsed.filter(c => c && c.seq).map(c => ({
      seq: String(c.seq), code: String(c.code || ''), name: String(c.name || c.code || c.seq),
      // btw-nummer, IBAN en e-mail identificeren de afzender op de factuur
      vat: String(c.vat || ''), iban: String(c.iban || ''), email: String(c.email || '')
    }));
  } else if (parsed && typeof parsed === 'object') {
    list = Object.entries(parsed).map(([code, seq]) => ({ seq: String(seq), code, name: code }));
  }
  if (!list.length) { status('Geen bruikbare crediteuren gevonden.', 'err'); return; }

  chrome.storage.local.set({ creditors: list }, () => {
    paintCreditors(list, null);
    status(`${list.length} crediteuren opgeslagen ✓`, 'ok');
  });
});

$('cred-clear').addEventListener('click', () => {
  chrome.storage.local.remove(['creditors', 'creditorsMeta'], () => {
    $('creditors').value = '';
    paintCreditors(null, null);
    status('Crediteurenlijst gewist.', 'ok');
  });
});

/* ---- versiecontrole -------------------------------------------------------
   Laat zien of deze installatie nog de huidige is. Het controleren zelf doet
   de service worker; hier staat alleen wat eruit kwam, plus een knop om het
   meteen opnieuw te vragen. */

function paintVersionCheck(info) {
  const badge = $('ver-state');
  const out = $('ver-result');
  if (!badge || !out) return;
  const when = t => new Date(t).toLocaleString('nl-NL', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

  if (!info) {
    badge.textContent = '–';
    badge.className = 'badge';
    out.textContent = 'Nog niet gecontroleerd.';
    return;
  }
  if (!info.configured) {
    badge.textContent = 'geen bron';
    badge.className = 'badge warn';
    out.textContent = 'Er is niets om aan te vragen welke versie de nieuwste is. Vul hierboven het gedeelde '
      + 'Supabase-project in, of hieronder een eigen JSON-bestand.';
    return;
  }
  if (info.outdated) {
    badge.textContent = 'verouderd';
    badge.className = 'badge warn';
    out.innerHTML = `Versie <b>${info.latest}</b> is er; deze computer draait <b>${info.current}</b>.`
      + (info.notes ? ' ' + info.notes : '')
      + (info.url ? ` <a href="${info.url}" target="_blank" rel="noreferrer">Nieuwe versie ophalen</a>.` : '');
    return;
  }
  badge.textContent = info.error ? 'onbekend' : 'up-to-date';
  badge.className = info.error ? 'badge warn' : 'badge';
  out.textContent = info.error
    ? `Laatste controle mislukt: ${info.error}` + (info.checkedOkAt ? ` (laatst gelukt ${when(info.checkedOkAt)})` : '')
    : `Deze computer draait ${info.current}`
      + (info.latest ? `, en dat is de nieuwste` : ', er is nog geen versie gepubliceerd')
      + (info.checkedAt ? ` · gecontroleerd ${when(info.checkedAt)}` : '');
}

chrome.storage.local.get(['versionCheck'], d => paintVersionCheck(d.versionCheck));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.versionCheck) paintVersionCheck(changes.versionCheck.newValue);
});

if ($('ver-check')) $('ver-check').addEventListener('click', () => {
  $('ver-result').textContent = 'Bezig met controleren…';
  chrome.runtime.sendMessage({ type: 'checkVersion' }, info => paintVersionCheck(info));
});
