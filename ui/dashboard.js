/* Dashboard inside the extension. Reads the Supabase project every colleague's
   extension reports to (supabase/setup.sql); nothing is stored here.

   A report is one invoice. Everything read in together - the 34 invoices of one
   afternoon - shares a dossier id (batchId, since 9.23) or, before that, the
   moment the run started. The page folds the reports back into those dossiers,
   so the list shows one line per inlezing and the invoices sit inside it. */

'use strict';

const $ = id => document.getElementById(id);
const esc = s => String(s === null || s === undefined ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const euro = n => (n === null || n === undefined || n === '' || isNaN(Number(n))) ? '—' :
  new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR' }).format(n);
const when = ms => ms ? new Date(ms).toLocaleString('nl-NL', { dateStyle: 'medium', timeStyle: 'short' }) : '—';
const ago = ms => {
  if (!ms) return '';
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return 'zojuist';
  if (s < 3600) return `${Math.floor(s / 60)} min geleden`;
  if (s < 86400) return `${Math.floor(s / 3600)} uur geleden`;
  const d = Math.floor(s / 86400);
  return d === 1 ? 'gisteren' : `${d} dagen geleden`;
};
const duration = ms => {
  if (!ms && ms !== 0) return '—';
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
};
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const initials = name => String(name || '?').replace(/[^A-Za-z]/g, '').slice(0, 2).toUpperCase() || '?';
// Supabase gives timestamps as text; the page works in milliseconds
const timeOf = r => Date.parse(r.booked_at || r.received_at) || null;
const num = v => (v === null || v === undefined || v === '' || isNaN(Number(v))) ? null : Number(v);
const DAY = 86400000;

let cfg = null;
const state = {
  status: '', user: '', q: '',
  expanded: new Set(),            // dossier keys folded open
  selected: null,                 // { kind: 'dossier', key } or { kind: 'run', id, key }
  hits: null                      // run ids the search matched, while searching
};
let runsCache = [];               // the reports as loaded
let statsCache = null;
let recentDossiers = 0;           // dossiers in the last 30 days, counted while not searching
let documentUrl = null;

/* A run's result, as the status column in the database counts it. */
function runStatus(r) {
  if (r.outcome === 'done') return { cls: 'ok', key: 'done', label: 'Geboekt' };
  if (Number(r.lines_booked) > 0) return { cls: 'warn', key: 'partial', label: `${r.lines_booked} van ${r.lines_total}` };
  return { cls: 'bad', key: 'failed', label: 'Niet gelukt' };
}
const pill = s => `<span class="pill ${s.cls}">${esc(s.label)}</span>`;

const TRANSPORT_STATUS = {
  done:      { cls: 'ok',   label: 'Geboekt' },
  duplicate: { cls: 'warn', label: 'Overgeslagen' },
  notfound:  { cls: 'bad',  label: 'Niet gevonden' },
  failed:    { cls: 'bad',  label: 'Mislukt' },
  pending:   { cls: 'warn', label: 'Niet verwerkt' },
  booking:   { cls: 'warn', label: 'Onbekend' },
  incomplete:{ cls: 'bad',  label: 'Onvolledig' }
};
const CONFIDENCE = {
  exact: 'Klopt met het factuurtotaal',
  unverified: 'Niet gecontroleerd tegen een totaal',
  mismatch: 'Wijkt af van het factuurtotaal',
  none: 'Geen kostenregels herkend'
};
const DESC_MODE = {
  both: 'Factuur + zending + kostensoort', invoice: 'Factuur + zending',
  invoiceOnly: 'Alleen factuurnummer', name: 'Alleen kostensoort'
};

/* =============================================================================
   DOSSIERS
   ============================================================================= */

/* Which dossier a report belongs to. The id the extension gives a run since
   9.23; before that the moment the run started, which every invoice of one
   run shares - together with who ran it, so two people starting in the same
   millisecond can never be folded into one. A report with neither is a
   dossier of its own. */
const dossierKey = r => r.batch_id ? 'b:' + r.batch_id
  : r.started_at ? `t:${r.started_at}:${r.user || ''}`
  : 'r:' + r.id;

function dossierStatus(d) {
  if (d.runs.length === 1) return runStatus(d.runs[0]);
  const issues = d.runs.length - d.done;
  if (!issues) return { cls: 'ok', key: 'done', label: 'Volledig geboekt' };
  if (!d.done && !d.partial) return { cls: 'bad', key: 'failed', label: 'Niet gelukt' };
  return { cls: 'warn', key: 'partial', label: plural(issues, 'met probleem', 'met problemen') };
}

function buildDossiers(runs) {
  const byKey = new Map();
  runs.forEach(r => {
    const key = dossierKey(r);
    if (!byKey.has(key)) byKey.set(key, { key, runs: [] });
    byKey.get(key).runs.push(r);
  });
  const dossiers = [...byKey.values()].map(d => {
    // oldest report first inside the dossier: the order the invoices were booked in
    d.runs.sort((a, b) => (timeOf(a) || 0) - (timeOf(b) || 0));
    const started = num(d.runs[0].started_at);
    d.time = started || timeOf(d.runs[0]);
    d.last = timeOf(d.runs[d.runs.length - 1]);
    d.user = d.runs.find(r => r.user)?.user || '';
    d.done = d.runs.filter(r => runStatus(r).key === 'done').length;
    d.partial = d.runs.filter(r => runStatus(r).key === 'partial').length;
    d.failed = d.runs.length - d.done - d.partial;
    d.amount = d.runs.reduce((a, r) => a + (num(r.amount) || 0), 0);
    d.bookedAmount = d.runs.filter(r => runStatus(r).key === 'done').reduce((a, r) => a + (num(r.amount) || 0), 0);
    d.size = Math.max(d.runs.length, ...d.runs.map(r => num(r.batch_size) || 0));
    d.durationMs = Math.max(0, ...d.runs.map(r => num(r.duration_ms) || 0)) || null;
    d.documents = d.runs.filter(r => r.doc_name).length;
    const creditors = new Map();
    d.runs.forEach(r => { const c = r.creditor || 'onbekende crediteur'; creditors.set(c, (creditors.get(c) || 0) + 1); });
    d.creditors = [...creditors.entries()].sort((a, b) => b[1] - a[1]).map(([name, n]) => ({ name, n }));
    d.status = dossierStatus(d);
    d.hits = state.hits ? d.runs.filter(r => state.hits.has(r.id)).length : 0;
    return d;
  });
  // newest dossier first
  return dossiers.sort((a, b) => (b.last || 0) - (a.last || 0));
}

function visibleDossiers() {
  return buildDossiers(runsCache).filter(d =>
    (!state.status || d.status.key === state.status) &&
    (!state.user || d.runs.some(r => r.user === state.user)));
}

const creditorSummary = d => {
  const names = d.creditors.map(c => c.name);
  return names.length <= 2 ? names.join(', ') : `${names.slice(0, 2).join(', ')} +${names.length - 2}`;
};

function barOf(d) {
  const seg = (cls, n) => n ? `<span class="${cls}" style="flex:${n}"></span>` : '';
  const leg = (cls, n, word) => n ? `<span class="${cls}"><i></i>${n} ${word}</span>` : '';
  return `<div class="bar-seg">${seg('ok', d.done)}${seg('warn', d.partial)}${seg('bad', d.failed)}</div>
    <div class="bar-legend">${leg('ok', d.done, 'geboekt')}${leg('warn', d.partial, 'deels')}${leg('bad', d.failed, 'mislukt')}</div>`;
}

function invoiceRow(r, key) {
  const st = runStatus(r);
  const open = state.selected && state.selected.kind === 'run' && state.selected.id === r.id;
  const hit = state.hits && state.hits.has(r.id);
  const zending = r.shipment || r.container || '';
  return `
    <tr class="run ${open ? 'is-open' : ''} ${hit ? 'hit' : ''}" data-id="${r.id}" data-key="${esc(key)}" tabindex="0">
      <td><b>${esc(r.invoice_no || 'zonder nummer')}</b><span class="sub clip" title="${esc(r.creditor || '')}">${esc(r.creditor || 'onbekende crediteur')}</span></td>
      <td><span class="clip" title="${esc(zending)}" style="max-width:220px">${esc(zending || '—')}</span></td>
      <td class="num">${r.lines_total ? `${r.lines_booked ?? 0} / ${r.lines_total}` : '—'}</td>
      <td class="num">${euro(r.amount)}</td>
      <td>${pill(st)}</td>
      <td>${r.doc_name ? '<span class="doc-flag" title="De factuur-PDF is bewaard">📄</span>' : ''}</td>
    </tr>`;
}

function dossierBlock(d) {
  const open = state.expanded.has(d.key);
  const selected = state.selected && state.selected.key === d.key;
  const missing = d.size - d.runs.length;
  return `
  <article class="dossier ${d.status.cls} ${open ? 'is-open' : ''} ${selected ? 'is-selected' : ''}" data-key="${esc(d.key)}">
    <div class="d-row" role="button" tabindex="0" aria-expanded="${open}">
      <span class="chev" aria-hidden="true">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="m9 5 7 7-7 7"/></svg>
      </span>
      <div class="d-when"><b>${esc(when(d.time))}</b><span class="sub">${esc(ago(d.last))}${d.durationMs ? ' · ' + esc(duration(d.durationMs)) : ''}</span></div>
      <div>${d.user ? `<span class="user"><span class="avatar">${esc(initials(d.user))}</span><span>${esc(d.user)}</span></span>` : '<span class="muted">onbekend</span>'}</div>
      <div class="d-count"><b>${plural(d.runs.length, 'factuur', 'facturen')}</b>${d.hits ? ` <span class="muted">· ${plural(d.hits, 'treffer', 'treffers')}</span>` : ''}
        <span class="sub clip" title="${esc(d.creditors.map(c => `${c.name} (${c.n})`).join(', '))}">${esc(creditorSummary(d))}</span></div>
      <div>${barOf(d)}</div>
      <div class="num"><b>${euro(d.amount)}</b>${d.done !== d.runs.length ? `<span class="sub">${euro(d.bookedAmount)} geboekt</span>` : ''}</div>
      <div>${pill(d.status)}</div>
    </div>
    <div class="d-invoices" ${open ? '' : 'hidden'}>
      <table>
        <thead><tr><th>Factuur</th><th>Zending</th><th class="num">Zendingen</th><th class="num">Bedrag</th><th>Resultaat</th><th></th></tr></thead>
        <tbody>${d.runs.map(r => invoiceRow(r, d.key)).join('')}</tbody>
      </table>
      ${missing > 0 ? `<div class="more">${plural(missing, 'rapport', 'rapporten')} van dit dossier nog niet ontvangen — komt mee met de volgende boekrun van die pc.</div>` : ''}
    </div>
  </article>`;
}

function renderList() {
  const dossiers = visibleDossiers();
  const invoices = dossiers.reduce((n, d) => n + d.runs.length, 0);
  $('count').textContent = dossiers.length
    ? `${plural(dossiers.length, 'dossier', 'dossiers')} · ${plural(invoices, 'factuur', 'facturen')}${state.q ? '' : ' · laatste 500 rapporten'}`
    : '';
  $('dossiers').innerHTML = dossiers.length ? dossiers.map(dossierBlock).join('')
    : `<div class="empty">${state.q || state.status || state.user
        ? 'Niets gevonden met deze filters.' : 'Nog geen rapporten ontvangen. Zodra iemand een factuur boekt, staat die hier.'}</div>`;
}

/* =============================================================================
   LOADING
   ============================================================================= */

function showError(message) {
  $('banner').textContent = message || '';
  $('banner').hidden = !message;
}

function renderKpis() {
  const s = statsCache;
  if (!s) return;
  // a search narrows the loaded reports, so the dossier count keeps the last full picture
  if (!state.q) {
    const since = Date.now() - 30 * DAY;
    recentDossiers = new Set(runsCache.filter(r => (timeOf(r) || 0) >= since).map(dossierKey)).size;
  }
  const rate = s.runs ? Math.round((s.done / s.runs) * 100) : 0;
  $('kpis').innerHTML = [
    { label: 'Facturen ingelezen', value: s.runs, sub: recentDossiers ? `in ${plural(recentDossiers, 'dossier', 'dossiers')} · laatste 30 dagen` : 'laatste 30 dagen' },
    { label: 'Volledig geboekt', value: `${rate}%`, sub: `${s.done} van ${s.runs}${s.partial || s.failed ? ` · ${s.partial} deels, ${s.failed} niet gelukt` : ''}` },
    { label: 'Geboekt bedrag', value: euro(s.amount), sub: 'volledig geboekte facturen' },
    { label: 'Gebruikers', value: s.userCount, sub: 'actief in 30 dagen' }
  ].map(k => `
    <div class="kpi">
      <div class="kpi-label">${esc(k.label)}</div>
      <div class="kpi-value">${esc(k.value)}</div>
      <div class="kpi-sub">${esc(k.sub)}</div>
    </div>`).join('');

  const sel = $('user');
  const keep = sel.value;
  sel.innerHTML = '<option value="">Alle gebruikers</option>' + (s.users || [])
    .map(u => `<option value="${esc(u.user)}">${esc(u.user)} (${u.runs})</option>`).join('');
  sel.value = keep;
}

async function loadStats() {
  statsCache = await FitonSupabase.stats(cfg);
  renderKpis();
}

/* Without a search: the latest 500 reports, folded into dossiers. With one:
   the reports that match, and then every other report of their dossiers, so a
   dossier found through one invoice is shown whole with the matches marked. */
async function loadRuns() {
  const q = state.q;
  let runs = await FitonSupabase.listRuns(cfg, { q, limit: q ? 200 : 500 });
  let hits = null;
  if (q && runs.length) {
    hits = new Set(runs.map(r => r.id));
    const batchIds = [...new Set(runs.map(r => r.batch_id).filter(Boolean))].slice(0, 60);
    const startedAts = [...new Set(runs.filter(r => !r.batch_id && r.started_at).map(r => r.started_at))].slice(0, 60);
    if (batchIds.length || startedAts.length) {
      const whole = await FitonSupabase.listBatchRuns(cfg, { batchIds, startedAts });
      const byId = new Map(runs.map(r => [r.id, r]));
      whole.forEach(r => byId.set(r.id, r));
      runs = [...byId.values()];
    }
  }
  if (q !== state.q) return;                    // typed on meanwhile
  runsCache = runs;
  const searching = !!q;
  state.hits = hits;
  if (searching) {
    // a search opens the dossiers it found something in
    state.expanded = new Set(buildDossiers(runs).filter(d => d.hits).map(d => d.key));
  }
  renderList();
  renderKpis();
}

async function refresh() {
  try {
    await Promise.all([loadStats(), loadRuns()]);
    showError('');
    $('updated').textContent = 'Bijgewerkt ' + new Date().toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });
  } catch (e) {
    showError('Kan de gegevens niet ophalen: ' + e.message + ' — test de verbinding in de instellingen.');
  }
}

/* =============================================================================
   DETAIL: A DOSSIER
   ============================================================================= */

function showDossier(key) {
  const d = buildDossiers(runsCache).find(x => x.key === key);
  state.selected = { kind: 'dossier', key };
  renderList();
  const box = $('detail');
  if (!d) { box.innerHTML = '<div class="empty">Dit dossier staat niet meer in de lijst.</div>'; return; }

  const issues = d.runs.filter(r => runStatus(r).key !== 'done');
  const missing = d.size - d.runs.length;
  const stats = [
    { v: `${d.done} / ${d.runs.length}`, l: 'facturen geboekt' },
    { v: euro(d.amount), l: 'factuurbedrag' },
    { v: euro(d.bookedAmount), l: 'geboekt' },
    { v: d.durationMs ? duration(d.durationMs) : '—', l: 'doorlooptijd' }
  ];
  const meta = [
    ['Ingelezen door', d.user || 'onbekend'],
    ['Gestart', when(d.time)],
    ['Laatste rapport', when(d.last)],
    ['Facturen bewaard', d.documents ? `${d.documents} van ${d.runs.length} met PDF` : null],
    ['Computer', d.runs.find(r => r.machine)?.machine || null]
  ].filter(([, v]) => v);

  box.innerHTML = `
    <div class="d-head">
      <div style="min-width:0">
        <div class="eyebrow">Dossier</div>
        <h2>${esc(when(d.time))}</h2>
        <div class="muted">${esc(d.user || 'onbekend')} · ${plural(d.runs.length, 'factuur', 'facturen')}</div>
      </div>
      <div style="margin-left:auto">${pill(d.status)}</div>
    </div>
    <div class="d-body">
      <div class="d-stats">${stats.map(s => `<div class="d-stat"><b>${esc(s.v)}</b><span>${esc(s.l)}</span></div>`).join('')}</div>
      ${missing > 0 ? `<div class="note">${plural(missing, 'rapport', 'rapporten')} van dit dossier nog niet ontvangen. Een rapport dat niet verstuurd kon worden wacht op die pc en komt mee met de volgende boekrun.</div>` : ''}
      <dl class="meta">${meta.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>

      <h3>Crediteuren (${d.creditors.length})</h3>
      <div class="chips">${d.creditors.map(c => `<span class="chip"><b>${c.n}</b> × ${esc(c.name)}</span>`).join('')}</div>

      ${issues.length ? `<h3>Aandacht nodig (${issues.length})</h3>${issues.map(r => {
        const st = runStatus(r);
        return `<div class="issue ${st.cls}" data-id="${r.id}" data-key="${esc(d.key)}" role="button" tabindex="0">
          <div style="min-width:0"><b>${esc(r.invoice_no || 'zonder nummer')}</b><span class="sub">${esc(r.creditor || 'onbekende crediteur')}</span>
            ${r.message ? `<span class="sub">${esc(r.message)}</span>` : ''}</div>
          <div class="right">${pill(st)}<div class="num" style="margin-top:4px">${euro(r.amount)}</div></div>
        </div>`;
      }).join('')}` : `<h3>Resultaat</h3><p class="muted" style="margin:0">Alle ${d.runs.length === 1 ? 'zendingen van deze factuur zijn' : 'facturen zijn volledig'} geboekt.</p>`}
    </div>`;
}

/* =============================================================================
   DETAIL: ONE INVOICE
   ============================================================================= */

function transportCard(t) {
  const st = TRANSPORT_STATUS[t.status] || TRANSPORT_STATUS.pending;
  const lines = t.lines || [];
  return `
  <div class="transport ${st.cls}">
    <div class="t-head">
      <div>
        <div class="t-name">${esc(t.name || 'Zonder container, eenheid of referentie')}</div>
        <div class="chips">${(t.facts || []).map(f => `<span class="chip">${esc(f)}</span>`).join('')}</div>
      </div>
      <div class="t-total">${pill(st)}<div class="num t-amount">${euro(t.total)}</div></div>
    </div>
    ${t.reason ? `<div class="reason ${st.cls === 'ok' ? '' : st.cls}">${esc(t.reason)}</div>` : ''}
    ${lines.length ? `
    <table class="lines">
      <thead><tr><th>Kosten</th><th class="num">Aantal</th><th class="num">Prijs</th><th class="num">Bedrag</th></tr></thead>
      <tbody>${lines.map(l => `<tr>
        <td>${esc(l.desc)}${l.ledgerName || l.ledger ? `<div class="ledger">${esc([l.ledger, l.ledgerName].filter(Boolean).join(' · '))}</div>` : ''}</td>
        <td class="num">${esc(l.qty ?? '')}</td><td class="num">${euro(l.price)}</td><td class="num">${euro(l.amount)}</td>
      </tr>`).join('')}</tbody>
    </table>` : ''}
  </div>`;
}

/* The PDF comes out of private storage as a file, shown from memory. */
async function showDocument(run) {
  const box = $('doc-box');
  try {
    const blob = await FitonSupabase.downloadDocument(cfg, run.doc_path);
    if (!state.selected || state.selected.id !== run.id || !$('doc-box')) return;   // something else was opened meanwhile
    if (documentUrl) URL.revokeObjectURL(documentUrl);
    documentUrl = URL.createObjectURL(new Blob([blob], { type: 'application/pdf' }));
    box.innerHTML = `<a class="doc" href="${documentUrl}" target="_blank" rel="noopener">📄 ${esc(run.doc_name || 'factuur.pdf')} openen</a>
      <iframe src="${documentUrl}" title="Factuur ${esc(run.invoice_no || '')}"></iframe>`;
  } catch (e) {
    box.innerHTML = `<p class="muted">De factuur kan niet geladen worden: ${esc(e.message)}</p>`;
  }
}

async function showDetail(id, key) {
  state.selected = { kind: 'run', id, key };
  state.expanded.add(key);
  renderList();
  const box = $('detail');
  box.innerHTML = '<div class="empty">Laden…</div>';

  let run;
  try { run = await FitonSupabase.getRun(cfg, id); }
  catch (e) { box.innerHTML = `<div class="empty">Kan deze factuur niet laden: ${esc(e.message)}</div>`; return; }
  if (!state.selected || state.selected.id !== id) return;

  const d = run.detail || {};
  const dossier = buildDossiers(runsCache).find(x => x.key === key);
  const transports = Array.isArray(d.transports) ? d.transports : null;
  const count = st => (transports || []).filter(t => t.status === st).length;
  const bookedAmount = d.bookedAmount ?? (run.outcome === 'done' ? run.amount : null);

  const stats = transports ? [
    { v: `${count('done')} / ${transports.length}`, l: 'zendingen geboekt' },
    { v: euro(run.amount), l: 'factuurbedrag' },
    { v: euro(bookedAmount), l: 'geboekt' },
    { v: count('duplicate') + count('notfound') + count('failed') + count('pending'), l: 'overgeslagen of mislukt' }
  ] : [
    { v: `${run.lines_booked ?? 0} / ${run.lines_total ?? 0}`, l: 'regels geboekt' },
    { v: euro(run.amount), l: 'bedrag' },
    { v: run.avg_ms ? (run.avg_ms / 1000).toFixed(1) + ' s' : '—', l: 'per regel' },
    { v: d.client || d.mode || '—', l: 'template' }
  ];

  const meta = [
    ['Ingelezen door', run.user || 'onbekend'],
    ['Tijdstip', when(timeOf(run))],
    ['Doorlooptijd', d.durationMs != null ? duration(d.durationMs) : null],
    ['Crediteur', [run.creditor, run.creditor_seq ? `(${run.creditor_seq})` : ''].filter(Boolean).join(' ') || null],
    ['Controle', d.confidence ? (CONFIDENCE[d.confidence] || d.confidence)
        + (d.statedTotal != null && d.confidence !== 'exact' ? ` · document noemt ${euro(d.statedTotal)}` : '') : null],
    ['Bestand', d.fileName || null],
    ['Omschrijving', d.descMode ? (DESC_MODE[d.descMode] || d.descMode) + (d.combine ? ' · één regel per zending' : '') : null],
    ['Bestaande kosten', d.ignoreExisting ? 'bewust genegeerd bij het boeken' : (transports ? 'gecontroleerd voor het boeken' : null)],
    ['Melding', run.message || null],
    ['Computer', run.machine || null],
    ['Versie extensie', d.version || null]
  ].filter(([, v]) => v);

  const legacyLines = !transports && (d.items || []).length ? `
    <h3>Geboekte regels</h3>
    <div class="transport"><table class="lines">
      <thead><tr><th>Omschrijving</th><th class="num">Aantal</th><th class="num">Prijs</th><th class="num">Bedrag</th></tr></thead>
      <tbody>${d.items.map(l => `<tr>
        <td>${esc(l.desc)}${l.ledgerName || l.ledger ? `<div class="ledger">${esc(l.ledgerName || l.ledger)}</div>` : ''}</td>
        <td class="num">${esc(l.qty ?? '')}</td><td class="num">${euro(l.price)}</td><td class="num">${euro(l.amount)}</td>
      </tr>`).join('')}</tbody>
    </table></div>` : '';

  box.innerHTML = `
    <div class="d-head">
      <div style="min-width:0">
        <div class="eyebrow">Factuur${dossier ? ` · <button class="link-btn" id="back-dossier">dossier van ${esc(when(dossier.time))}</button>` : ''}</div>
        <h2>${esc(run.invoice_no || 'Zonder factuurnummer')}</h2>
        <div class="muted">${esc(run.creditor || 'onbekende crediteur')}</div>
      </div>
      <div style="margin-left:auto">${pill(runStatus(run))}</div>
    </div>
    <div class="d-body">
      <div class="d-stats">${stats.map(s => `<div class="d-stat"><b>${esc(s.v)}</b><span>${esc(s.l)}</span></div>`).join('')}</div>
      <dl class="meta">${meta.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>

      ${transports ? `<h3>Zendingen (${transports.length})</h3>${transports.map(transportCard).join('')}` : legacyLines}

      <h3>Factuur</h3>
      <div id="doc-box">${run.doc_path
        ? '<p class="muted">Factuur laden…</p>'
        : `<p class="muted">${d.fileName ? 'De PDF is bij deze factuur niet meegestuurd.' : 'Geen PDF bij deze factuur.'}</p>`}</div>
    </div>`;

  const back = $('back-dossier');
  if (back) back.addEventListener('click', () => showDossier(key));
  if (run.doc_path) showDocument(run);
}

/* =============================================================================
   EVENTS
   ============================================================================= */

function toggleDossier(key) {
  if (state.expanded.has(key)) state.expanded.delete(key); else state.expanded.add(key);
  showDossier(key);
}

let searchTimer;
$('q').addEventListener('input', e => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.q = e.target.value.trim();
    if (!state.q) { state.hits = null; state.expanded = new Set(); }
    loadRuns().catch(err => showError(err.message));
  }, 250);
});
document.querySelectorAll('.seg button').forEach(b => b.addEventListener('click', () => {
  state.status = b.dataset.status;
  document.querySelectorAll('.seg button').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
  renderList();
}));
$('user').addEventListener('change', e => { state.user = e.target.value; renderList(); });
$('refresh').addEventListener('click', refresh);
$('open-options').addEventListener('click', () => chrome.runtime.openOptionsPage());

const activate = e => {
  const row = e.target.closest('tr.run');
  if (row) { showDetail(Number(row.dataset.id), row.dataset.key); return true; }
  const head = e.target.closest('.d-row');
  if (head) { toggleDossier(head.closest('.dossier').dataset.key); return true; }
  return false;
};
$('dossiers').addEventListener('click', activate);
$('dossiers').addEventListener('keydown', e => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('tr.run, .d-row') && activate(e)) e.preventDefault();
});
$('detail').addEventListener('click', e => {
  const issue = e.target.closest('.issue');
  if (issue) showDetail(Number(issue.dataset.id), issue.dataset.key);
});
$('detail').addEventListener('keydown', e => {
  const issue = e.target.closest('.issue');
  if (issue && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); showDetail(Number(issue.dataset.id), issue.dataset.key); }
});

// Saving new settings elsewhere reloads this page with them.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && (changes.supabaseUrl || changes.supabaseKey)) location.reload();
});

chrome.storage.sync.get(['supabaseUrl', 'supabaseKey'], settings => {
  cfg = FitonSupabase.clean(settings);
  const linked = !!(cfg.url && cfg.key);
  $('setup').hidden = linked;
  $('app').hidden = !linked;
  $('refresh').hidden = !linked;
  if (!linked) return;
  refresh();
  setInterval(refresh, 30000);
});
