/* Runs in the page's own JavaScript context.

   A content script lives in an isolated world, so anything it puts on `window`
   is invisible to the console unless you switch the context dropdown. This file
   is injected into the page itself and forwards every call to the content script
   over CustomEvents, so `fiton.help()` just works in the default console. */

/* ---------------------------------------------------------------- capture --
   APEX reloads the page when a cost line is created, which clears the Network
   tab unless "Preserve log" happens to be on - so the one request worth seeing
   is the one you cannot see. This records it instead: every XHR, fetch, and
   form submit is written to localStorage, which survives the reload, and
   fiton.requests() prints it afterwards.

   Off by default, because these bodies hold session tokens. fiton.capture(true)
   turns it on for as long as you need it. */
(() => {
  const KEY = 'fiton_requests';
  const FLAG = 'fiton_capture';
  const MAX_ENTRIES = 25;
  const MAX_BODY = 20000;
  /* Most fields are short, but the one that carries the actual page values -
     p_json in modern APEX, or p_tNN in the classic form - is long and is
     exactly the one worth keeping whole. */
  const BIG_FIELD = /^(p_json|p_clob_01|x\d\d|f\d\d|p_t\d\d)$/i;
  const cut = (key, value) => String(value).slice(0, BIG_FIELD.test(key) ? 12000 : 400);

  const on = () => { try { return localStorage.getItem(FLAG) === '1'; } catch (e) { return false; } };

  /* How many requests are still on the way. The content script lives in another
     world and cannot see this counter, so it is published on the <html> element,
     where both sides can read it. Always on, and it records nothing: this is a
     number, not a copy of the traffic. */
  let inFlight = 0;
  const publish = () => {
    try { document.documentElement.setAttribute('data-fiton-ajax', String(inFlight)); } catch (e) {}
  };
  const started = () => { inFlight++; publish(); };
  const finished = () => { inFlight = Math.max(0, inFlight - 1); publish(); };
  publish();

  const read = () => { try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch (e) { return []; } };
  const write = list => { try { localStorage.setItem(KEY, JSON.stringify(list.slice(-MAX_ENTRIES))); } catch (e) {} };

  /* An APEX body is form-encoded with repeated names (p_t01, p_t02...), so the
     pairs are kept in order rather than collapsed into an object. */
  function describeBody(body, contentType) {
    const ct = String(contentType || '').toLowerCase();
    if (body == null) return { kind: 'none', pairs: [], raw: '' };
    if (typeof FormData !== 'undefined' && body instanceof FormData) {
      return { kind: 'formdata', pairs: [...body.entries()].map(([k, v]) => [k, cut(k, v)]), raw: '' };
    }
    if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
      return { kind: 'urlencoded', pairs: [...body.entries()], raw: body.toString().slice(0, MAX_BODY) };
    }
    const raw = typeof body === 'string' ? body : '[' + (body && body.constructor ? body.constructor.name : typeof body) + ']';
    if (/json/.test(ct) || /^\s*[{[]/.test(raw)) {
      try { return { kind: 'json', pairs: [], json: JSON.parse(raw), raw: raw.slice(0, MAX_BODY) }; } catch (e) {}
    }
    if (/urlencoded/.test(ct) || /(^|&)p_flow_id=/.test(raw)) {
      return { kind: 'urlencoded', pairs: [...new URLSearchParams(raw).entries()], raw: raw.slice(0, MAX_BODY) };
    }
    return { kind: 'text', pairs: [], raw: raw.slice(0, MAX_BODY) };
  }

  function record(entry) {
    if (!on()) return;
    const list = read();
    list.push(Object.assign({ at: Date.now(), page: location.pathname + location.search }, entry));
    write(list);
  }

  // XMLHttpRequest - what apex.server.process uses
  const xhrOpen = XMLHttpRequest.prototype.open;
  const xhrSend = XMLHttpRequest.prototype.send;
  const xhrHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__fiton = { method, url: String(url), headers: {} };
    return xhrOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    if (this.__fiton) this.__fiton.headers[String(name).toLowerCase()] = String(value);
    return xhrHeader.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (body) {
    const info = this.__fiton;
    started();
    this.addEventListener('loadend', finished);
    if (info && on()) {
      const started = Date.now();
      this.addEventListener('loadend', () => {
        record({ kind: 'xhr', method: info.method, url: info.url, headers: info.headers,
                 body: describeBody(body, info.headers['content-type']),
                 status: this.status, ms: Date.now() - started,
                 response: String(this.responseType === '' || this.responseType === 'text' ? (this.responseText || '') : '').slice(0, 2000) });
      });
    }
    return xhrSend.apply(this, arguments);
  };

  // fetch
  const realFetch = window.fetch;
  if (realFetch) {
    window.fetch = function (input, init) {
      const url = String((input && input.url) || input || '');
      const opts = init || {};
      const method = (opts.method || (input && input.method) || 'GET').toUpperCase();
      const headers = {};
      try { new Headers(opts.headers || (input && input.headers) || {}).forEach((v, k) => { headers[k.toLowerCase()] = v; }); } catch (e) {}
      const t0 = Date.now();
      started();
      const p = realFetch.apply(this, arguments);
      p.then(finished, finished);
      if (on() && method !== 'GET') {
        p.then(res => record({ kind: 'fetch', method, url, headers,
                               body: describeBody(opts.body, headers['content-type']),
                               status: res.status, ms: Date.now() - t0 }))
         .catch(() => {});
      }
      return p;
    };
  }

  /* The one that matters here: a classic APEX form post is a navigation, not an
     XHR, so it never shows up as a request you can replay from the Network tab
     after the page has gone. */
  function recordForm(form, how) {
    if (!on() || !form) return;
    let pairs = [];
    try { pairs = [...new FormData(form).entries()].map(([k, v]) => [k, cut(k, v)]); } catch (e) {}
    record({ kind: 'form:' + how, method: (form.method || 'GET').toUpperCase(),
             url: form.action || location.href, headers: { 'content-type': form.enctype || 'application/x-www-form-urlencoded' },
             body: { kind: 'formdata', pairs, raw: '' }, status: null, ms: null });
  }
  document.addEventListener('submit', e => recordForm(e.target, 'event'), true);
  const formSubmit = HTMLFormElement.prototype.submit;
  HTMLFormElement.prototype.submit = function () { recordForm(this, 'submit()'); return formSubmit.apply(this, arguments); };

  const REQUEST = 'fiton-debug-request';
  const RESPONSE = 'fiton-debug-response';
  let counter = 0;
  const pending = new Map();

  window.addEventListener(RESPONSE, event => {
    const { id, ok, result, error } = event.detail || {};
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    if (ok) entry.resolve(result);
    else entry.reject(new Error(error || 'onbekende fout'));
  });

  function call(method, args, timeoutMs) {
    const id = ++counter;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      window.dispatchEvent(new CustomEvent(REQUEST, { detail: { id, method, args } }));
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error('geen antwoord van de extensie — is de pagina net herladen?'));
        }
      }, timeoutMs || 30000);
    });
  }

  /* The content script sends back plain data; printing happens here so the
     output lands in the console you are actually looking at. */
  function show(payload) {
    if (!payload) return payload;
    (payload.logs || []).forEach(line => console.log(line));
    (payload.tables || []).forEach(t => {
      if (t.title) console.log(t.title);
      console.table(t.rows);
    });
    return payload.value !== undefined ? payload.value : undefined;
  }

  const api = {
    help: () => call('help').then(show),
    info: () => call('info').then(show),
    readText: text => call('readText', [text]).then(show),
    readFile: () => call('readFile').then(show),
    rows: () => call('rows').then(show),
    parsed: () => call('parsed').then(show),
    creditors: () => call('creditors').then(show),
    // pressing "Show More" for a few hundred creditors takes a while
    refreshCreditors: () => call('refreshCreditors', [], 300000).then(show),
    ledger: desc => call('ledger', [desc]).then(show),
    state: () => call('state').then(show),
    timing: () => call('timing').then(show),
    diagnose: () => call('diagnose').then(show),
    marks: () => call('marks').then(show),
    version: () => call('version').then(show),
    capture: flag => call('capture', [flag !== false]).then(show),
    requests: what => call('requests', [what]).then(show)
  };

  Object.defineProperty(window, 'fiton', { value: api, configurable: true });
  console.log('%cFitOn debug beschikbaar — typ fiton.help()', 'color:#1d4ed8;font-weight:600');
})();
