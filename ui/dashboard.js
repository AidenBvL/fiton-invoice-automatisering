/* Dashboard inside the extension. Reads the Supabase project every colleague's
   extension reports to (supabase/setup.sql); nothing is stored here. */

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
const initials = name => String(name || '?').replace(/[^A-Za-z]/g, '').slice(0, 2).toUpperCase() || '?';
// Supabase gives timestamps as text; the page works in milliseconds
const timeOf = r => Date.parse(r.booked_at || r.received_at) || null;

let cfg = null;
const state = { status: '', user: '', q: '', openId: null };
let documentUrl = null;

/* A run's result, as the status column in the database counts it. */
function runStatus(r) {
  if (r.outcome === 'done') return { cls: 'ok', label: 'Geboekt' };
  if (Number(r.lines_booked) > 0) return { cls: 'warn', label: `${r.lines_booked} van ${r.lines_total}` };
  return { cls: 'bad', label: 'Niet gelukt' };
}
const pill = s => `<span class="pill ${s.cls}">${esc(s.label)}</span>`;

const TRANSPORT_STATUS = {
  done:      { cls: 'ok',   label: 'Geboekt' },
  duplicate: { cls: 'warn', label: 'Overgeslagen' },
  notfound:  { cls: 'bad',  label: 'Niet gevonden' },
  failed:    { cls: 'bad',  label: 'Mislukt' },
  pending:   { cls: 'warn', label: 'Niet verwerkt' },
  booking:   { cls: 'warn', label: 'Onbekend' }
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

function showError(message) {
  $('banner').textContent = message || '';
  $('banner').hidden = !message;
}

async function loadStats() {
  const s = await FitonSupabase.stats(cfg);
  const rate = s.runs ? Math.round((s.done / s.runs) * 100) : 0;
  $('kpis').innerHTML = [
    { label: 'Runs', value: s.runs, sub: 'laatste 30 dagen' },
    { label: 'Volledig geboekt', value: `${rate}%`, sub: `${s.done} van ${s.runs}` },
    { label: 'Geboekt bedrag', value: euro(s.amount), sub: 'volledig geboekte runs' },
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

async function loadRuns() {
  const runs = await FitonSupabase.listRuns(cfg, { q: state.q, status: state.status, user: state.user, limit: 200 });

  $('count').textContent = `${runs.length} run${runs.length === 1 ? '' : 's'}`;
  $('rows').innerHTML = runs.length ? runs.map(r => {
    const t = timeOf(r);
    const zending = r.shipment || r.container || '';
    return `
    <tr class="run ${r.id === state.openId ? 'is-open' : ''}" data-id="${r.id}" tabindex="0">
      <td><span title="${esc(when(t))}">${esc(ago(t))}</span><span class="sub">${esc(when(t))}</span></td>
      <td>${r.user ? `<span class="user"><span class="avatar">${esc(initials(r.user))}</span>${esc(r.user)}</span>` : '<span class="muted">onbekend</span>'}</td>
      <td><b>${esc(r.invoice_no || '—')}</b><span class="sub clip" title="${esc(r.creditor || '')}">${esc(r.creditor || 'onbekende crediteur')}</span></td>
      <td><span class="clip" title="${esc(zending)}">${esc(zending || '—')}</span>${r.doc_name ? '<span class="doc-flag">📄 factuur bewaard</span>' : ''}</td>
      <td class="num">${r.lines_total ? `${r.lines_booked ?? 0} / ${r.lines_total}` : '—'}</td>
      <td class="num">${euro(r.amount)}</td>
      <td>${pill(runStatus(r))}</td>
    </tr>`;
  }).join('') : `<tr><td colspan="7" class="empty">${state.q || state.status || state.user
      ? 'Niets gevonden met deze filters.' : 'Nog geen runs ontvangen. Zodra iemand een factuur boekt, staat die hier.'}</td></tr>`;
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
    if (state.openId !== run.id || !$('doc-box')) return;          // another run was opened meanwhile
    if (documentUrl) URL.revokeObjectURL(documentUrl);
    documentUrl = URL.createObjectURL(new Blob([blob], { type: 'application/pdf' }));
    box.innerHTML = `<a class="doc" href="${documentUrl}" target="_blank" rel="noopener">📄 ${esc(run.doc_name || 'factuur.pdf')} openen</a>
      <iframe src="${documentUrl}" title="Factuur ${esc(run.invoice_no || '')}"></iframe>`;
  } catch (e) {
    box.innerHTML = `<p class="muted">De factuur kan niet geladen worden: ${esc(e.message)}</p>`;
  }
}

async function showDetail(id) {
  state.openId = id;
  document.querySelectorAll('#rows tr.run').forEach(tr => tr.classList.toggle('is-open', Number(tr.dataset.id) === id));
  const box = $('detail');
  box.innerHTML = '<div class="empty">Laden…</div>';

  let run;
  try { run = await FitonSupabase.getRun(cfg, id); }
  catch (e) { box.innerHTML = `<div class="empty">Kan deze run niet laden: ${esc(e.message)}</div>`; return; }
  if (state.openId !== id) return;

  const d = run.detail || {};
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
        <div class="eyebrow">Factuur</div>
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
        : `<p class="muted">${d.fileName ? 'De PDF is bij deze run niet meegestuurd.' : 'Geen factuur bij deze run.'}</p>`}</div>
    </div>`;

  if (run.doc_path) showDocument(run);
}

/* events */
let searchTimer;
$('q').addEventListener('input', e => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { state.q = e.target.value.trim(); loadRuns().catch(err => showError(err.message)); }, 250);
});
document.querySelectorAll('.seg button').forEach(b => b.addEventListener('click', () => {
  state.status = b.dataset.status;
  document.querySelectorAll('.seg button').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
  loadRuns().catch(err => showError(err.message));
}));
$('user').addEventListener('change', e => { state.user = e.target.value; loadRuns().catch(err => showError(err.message)); });
$('refresh').addEventListener('click', refresh);
$('open-options').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('rows').addEventListener('click', e => {
  const tr = e.target.closest('tr.run');
  if (tr) showDetail(Number(tr.dataset.id));
});
$('rows').addEventListener('keydown', e => {
  const tr = e.target.closest('tr.run');
  if (tr && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); showDetail(Number(tr.dataset.id)); }
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
