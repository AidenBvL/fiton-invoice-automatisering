/* Service worker.
   Chrome checks the update_url in manifest.json roughly every 5 hours and
   installs a newer version automatically. This worker records what happened so
   the popup can show it, opens the setup page on first run, sends the booking
   reports, and asks the shared project every few hours which version everyone
   should be on - see checkLatestVersion below. */

importScripts('ui/supabase.js', 'ui/version.js');

const SETTINGS_DEFAULTS = {
  maps: null,          // filled in by the content script's learn mode
  ratesUrl: '',
  defaultMode: 'revenue',
  supabaseUrl: '',     // the shared Supabase project; see supabase/README.md
  supabaseKey: '',
  dashboardUrl: '',    // or an own dashboard server; both blank = reports stay on this machine
  dashboardToken: '',
  dashboardSendDocument: false,
  versionUrl: ''       // optional: a JSON file saying which version is current
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

  scheduleVersionCheck();
  checkLatestVersion();

  // First install: show the setup page so nobody has to be told where it is.
  if (details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('ui/options.html?first=1') });
  }
});

chrome.runtime.onStartup.addListener(() => {
  scheduleVersionCheck();
  checkLatestVersion();
});

// Lets the popup force an update check instead of waiting for the 5-hour cycle.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'checkForUpdate') {
    /* Two different questions, both asked here. Chrome's own check only does
       anything when the extension came from a store or an update_url - loaded
       unpacked it refuses outright - while the version check works whatever way
       it was installed. So the refusal is caught and the answer still goes out
       with what the version check found. */
    const version = chrome.runtime.getManifest().version;
    const check = checkLatestVersion();
    const answer = (status, details) => check
      .then(latest => sendResponse({ status, details, latest, version }))
      .catch(e => sendResponse({ status, details, latest: { error: String(e.message || e) }, version }));
    try {
      if (!chrome.runtime.requestUpdateCheck) return answer('no_update_url'), true;
      chrome.runtime.requestUpdateCheck((status, details) => {
        if (chrome.runtime.lastError) return answer('no_update_url');
        answer(status, details);
      });
    } catch (e) {
      answer('no_update_url');
    }
    return true;   // async response
  }
  if (msg && msg.type === 'checkVersion') {
    checkLatestVersion().then(latest => sendResponse(latest));
    return true;
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

/* =============================================================================
   IS THIS COPY STILL THE CURRENT ONE?
   -----------------------------------------------------------------------------
   Auto-updates only happen when the extension came from the Web Store or from
   an update_url, and until that is set up a colleague can sit on a version from
   months ago without anything saying so. This asks the shared project every few
   hours which version is current and remembers the answer; the popup, the
   settings page and the panel in FitOn read it from there.

   Nothing is downloaded or installed here - it only tells people they are
   behind, and where to get the new one.
   ============================================================================= */

const VERSION_KEY = 'versionCheck';
const VERSION_ALARM = 'fiton-version-check';
const VERSION_EVERY_MIN = 360;          // every six hours, as Chrome does

/* The service worker is woken and shut down all day long, and this file runs
   again every time. Re-creating the alarm on each wake would reset its clock,
   so the check would run a minute after every wake instead of every six hours;
   an alarm that is already set is therefore left alone. */
async function scheduleVersionCheck() {
  if (!chrome.alarms) return;
  try {
    if (await chrome.alarms.get(VERSION_ALARM)) return;
  } catch (e) { /* no alarm yet, or an older Chrome: just create it */ }
  chrome.alarms.create(VERSION_ALARM, { delayInMinutes: 1, periodInMinutes: VERSION_EVERY_MIN });
}

if (chrome.alarms) {
  chrome.alarms.onAlarm.addListener(alarm => {
    if (alarm && alarm.name === VERSION_ALARM) checkLatestVersion();
  });
}

async function readLatest(settings) {
  // An own JSON file wins: a team that keeps one has said where to look.
  const custom = String(settings.versionUrl || '').trim();
  if (custom) {
    const res = await fetch(custom, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`${custom} antwoordde ${res.status}`);
    const body = await res.json();
    return {
      version: String((body && body.version) || '').trim(),
      notes: (body && body.notes) || '',
      url: (body && body.url) || '',
      source: 'url'
    };
  }
  const cfg = FitonSupabase.clean(settings);
  if (cfg.url && cfg.key) return FitonSupabase.latestVersion(cfg);
  return null;                           // nothing set up to ask
}

async function checkLatestVersion() {
  const current = chrome.runtime.getManifest().version;
  const stored = await chrome.storage.local.get([VERSION_KEY]);
  const before = stored[VERSION_KEY] || {};
  const result = {
    current, checkedAt: Date.now(), configured: false,
    latest: '', notes: '', url: '', source: '', outdated: false, error: null
  };
  try {
    const settings = await chrome.storage.sync.get(['supabaseUrl', 'supabaseKey', 'versionUrl']);
    const found = await readLatest(settings);
    if (found) {
      result.configured = true;
      result.latest = found.version || '';
      result.notes = found.notes || '';
      result.url = found.url || '';
      result.source = found.source || '';
    }
  } catch (e) {
    /* Unreachable for a moment is not the same as up to date: keep what the
       last successful check said, so the warning does not blink off. */
    result.error = String(e.message || e);
    result.configured = before.configured !== undefined ? before.configured : true;
    result.latest = before.latest || '';
    result.notes = before.notes || '';
    result.url = before.url || '';
    result.source = before.source || '';
    result.checkedOkAt = before.checkedOkAt || null;
  }
  if (!result.error) result.checkedOkAt = result.checkedAt;
  result.outdated = FitonVersion.isNewer(result.latest, current);
  await chrome.storage.local.set({ [VERSION_KEY]: result });
  return result;
}

// A settings change (a project filled in, a URL corrected) is worth re-asking.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;
  if (changes.supabaseUrl || changes.supabaseKey || changes.versionUrl) checkLatestVersion();
});

scheduleVersionCheck();
