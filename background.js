/* Service worker.
   Chrome checks the update_url in manifest.json roughly every 5 hours and
   installs a newer version automatically. This worker only records what
   happened so the popup can show it, and opens the setup page on first run. */

importScripts('ui/supabase.js');

const SETTINGS_DEFAULTS = {
  maps: null,          // filled in by the content script's learn mode
  ratesUrl: '',
  defaultMode: 'revenue',
  supabaseUrl: '',     // the shared Supabase project; see supabase/README.md
  supabaseKey: '',
  dashboardUrl: '',    // or an own dashboard server; both blank = reports stay on this machine
  dashboardToken: '',
  dashboardSendDocument: false
};

chrome.runtime.onInstalled.addListener(async details => {
  const version = chrome.runtime.getManifest().version;

  const stored = await chrome.storage.sync.get(Object.keys(SETTINGS_DEFAULTS));
  const missing = {};
  for (const [key, value] of Object.entries(SETTINGS_DEFAULTS)) {
    if (stored[key] === undefined && value !== null) missing[key] = value;
  }
  if (Object.keys(missing).length) await chrome.storage.sync.set(missing);

  await chrome.storage.local.set({
    lastEvent: {
      reason: details.reason,                       // install | update | chrome_update
      previousVersion: details.previousVersion || null,
      version,
      at: Date.now()
    }
  });

  // First install: show the setup page so nobody has to be told where it is.
  if (details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('ui/options.html?first=1') });
  }
});

// Lets the popup force an update check instead of waiting for the 5-hour cycle.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'checkForUpdate') {
    chrome.runtime.requestUpdateCheck((status, details) => {
      sendResponse({ status, details, version: chrome.runtime.getManifest().version });
    });
    return true;   // async response
  }
  if (msg && msg.type === 'getVersion') {
    sendResponse({ version: chrome.runtime.getManifest().version });
  }

  /* A booking report goes out from here rather than from the page: the service
     worker is not bound by the page's origin, so the dashboard does not have to
     allow every FitOn tab through CORS. */
  if (msg && msg.type === 'sendReport') {
    sendReport(msg.report)
      .then(result => sendResponse(result))
      .catch(e => sendResponse({ ok: false, error: String(e.message || e) }));
    return true;
  }
});

const QUEUE_KEY = 'reportQueue';
const MAX_QUEUE = 50;

async function dashboardSettings() {
  const s = await chrome.storage.sync.get(['dashboardUrl', 'dashboardToken', 'supabaseUrl', 'supabaseKey']);
  const supabase = FitonSupabase.clean(s);
  return {
    supabase: supabase.url && supabase.key ? supabase : null,
    url: String(s.dashboardUrl || '').trim().replace(/\/+$/, ''),
    token: String(s.dashboardToken || '').trim()
  };
}

async function postReport(report, cfg) {
  // The shared Supabase project when it is set up; an own server otherwise.
  if (cfg.supabase) return FitonSupabase.insertRun(cfg.supabase, report);

  const res = await fetch(cfg.url + '/api/runs', {
    method: 'POST',
    headers: Object.assign({ 'content-type': 'application/json' },
                           cfg.token ? { 'x-fiton-token': cfg.token } : {}),
    body: JSON.stringify(report)
  });
  if (!res.ok) throw new Error(`dashboard antwoordde ${res.status}`);
  return res.json().catch(() => ({}));
}

/* Nothing is thrown away when the dashboard is unreachable - a report that
   cannot be sent waits on this machine and goes out with the next one. */
async function sendReport(report) {
  const cfg = await dashboardSettings();
  if (!cfg.supabase && !cfg.url) return { ok: false, skipped: 'geen dashboard ingesteld' };

  const stored = await chrome.storage.local.get([QUEUE_KEY]);
  const queue = Array.isArray(stored[QUEUE_KEY]) ? stored[QUEUE_KEY] : [];
  const pending = queue.concat([report]).slice(-MAX_QUEUE);

  const left = [];
  let sent = 0, lastError = null;
  for (const item of pending) {
    try { await postReport(item, cfg); sent++; }
    catch (e) { lastError = String(e.message || e); left.push(item); }
  }
  await chrome.storage.local.set({ [QUEUE_KEY]: left });
  return { ok: sent > 0 && !left.length, sent, queued: left.length, error: lastError };
}
