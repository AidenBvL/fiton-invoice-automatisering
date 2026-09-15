const REQUIRED = ['ledger', 'qty', 'price', 'desc', 'createBtn'];

chrome.runtime.sendMessage({ type: 'getVersion' }, res => {
  if (res && res.version) document.getElementById('version').textContent = res.version;
});

const DEFAULT_COST = {
  ledger: 'P673_LEDGER_SEQ', qty: 'P673_QUANTITY', price: 'P673_PRICE',
  desc: 'P673_DESCRIPTION', createBtn: 'B59359322609116685'
};

chrome.storage.sync.get(['maps'], data => {
  const cost = Object.assign({}, DEFAULT_COST, (data.maps && data.maps.cost) || {});
  const done = REQUIRED.every(k => !!cost[k]);
  document.getElementById('cost-dot').className = 'dot ' + (done ? 'ok' : 'warn');
  document.getElementById('cost-text').textContent =
    'Kostenpagina: ' + (done ? 'klaar' : 'nog niet ingesteld');
});

document.getElementById('options').addEventListener('click', () => chrome.runtime.openOptionsPage());
document.getElementById('dashboard').addEventListener('click', () =>
  chrome.tabs.create({ url: chrome.runtime.getURL('ui/dashboard.html') }));

/* ---- is this copy still the current one? ---------------------------------
   The service worker asks the shared project every few hours and stores the
   answer; this only paints it. Nothing is downloaded from here. */

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function paintVersion(info) {
  const box = document.getElementById('update');
  const state = document.getElementById('version-state');
  if (!info) { box.style.display = 'none'; state.textContent = ''; return; }

  if (info.outdated) {
    const link = info.url
      ? `<div class="notes"><a href="${esc(info.url)}" target="_blank" rel="noreferrer">Nieuwe versie ophalen</a></div>` : '';
    box.innerHTML = `<b>Versie ${esc(info.latest)} is er — jij hebt ${esc(info.current)}</b>`
      + (info.notes ? `<div class="notes">${esc(info.notes)}</div>` : '')
      + `<div class="notes">Werk bij, anders boek je met een oudere versie dan de rest.</div>`
      + link;
    box.style.display = 'block';
    state.innerHTML = '<span style="color:#92400e;">· verouderd</span>';
    return;
  }

  box.style.display = 'none';
  if (!info.configured) { state.textContent = ''; return; }
  state.innerHTML = info.latest && !info.error ? '<span class="ok">· up-to-date</span>' : '';
}

chrome.storage.local.get(['versionCheck'], d => paintVersion(d.versionCheck));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.versionCheck) paintVersion(changes.versionCheck.newValue);
});

document.getElementById('check').addEventListener('click', () => {
  const msg = document.getElementById('msg');
  msg.textContent = 'Bezig met controleren…';
  chrome.runtime.sendMessage({ type: 'checkForUpdate' }, res => {
    if (!res) { msg.textContent = 'Controle mislukt.'; return; }
    const latest = res.latest || {};
    paintVersion(latest);

    // What the shared project says, which works however the extension was installed.
    if (latest.error) msg.textContent = 'Versiecontrole mislukt: ' + latest.error;
    else if (latest.outdated) msg.textContent = `Versie ${latest.latest} is beschikbaar.`;
    else if (!latest.configured) msg.textContent = 'Geen dashboard ingesteld, dus geen versiecontrole. Zie Instellingen.';
    else if (!latest.latest) msg.textContent = 'Nog geen versie bekend in het gedeelde project.';
    else msg.textContent = 'Je hebt de nieuwste versie (' + latest.current + ').';

    // And what Chrome says, which only means something with een update_url.
    if (res.status === 'update_available') msg.textContent = 'Update gevonden — wordt geïnstalleerd.';
    else if (res.status === 'throttled') msg.textContent += ' (Chrome controleerde net al.)';
  });
});
