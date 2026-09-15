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

document.getElementById('check').addEventListener('click', () => {
  const msg = document.getElementById('msg');
  msg.textContent = 'Bezig met controleren…';
  chrome.runtime.sendMessage({ type: 'checkForUpdate' }, res => {
    if (!res) { msg.textContent = 'Controle mislukt.'; return; }
    msg.textContent = res.status === 'update_available'
      ? 'Update gevonden — wordt geïnstalleerd.'
      : res.status === 'no_update' ? 'Je hebt de nieuwste versie.' : 'Status: ' + res.status;
  });
});
