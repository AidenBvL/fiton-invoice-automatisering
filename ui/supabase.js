/* Supabase access for the extension. The service worker posts reports, the
   settings page tests the connection and the dashboard reads everything back.
   Plain REST, no library: PostgREST for the runs table, the Storage API for the
   PDFs. supabase/setup.sql creates what this expects. */

(function (root) {
  'use strict';

  const BUCKET = 'facturen';

  const clean = cfg => ({
    url: String((cfg && (cfg.supabaseUrl || cfg.url)) || '').trim().replace(/\/+$/, ''),
    key: String((cfg && (cfg.supabaseKey || cfg.key)) || '').trim()
  });

  /* A publishable key (sb_publishable_...) belongs in the apikey header only.
     The older anon key is a JWT and also goes along as the bearer token. */
  function headers(cfg, extra) {
    const h = Object.assign({ apikey: cfg.key }, extra || {});
    if (/^eyJ/.test(cfg.key)) h.Authorization = 'Bearer ' + cfg.key;
    return h;
  }

  async function call(cfg, path, opts) {
    const options = Object.assign({}, opts, { headers: headers(cfg, opts && opts.headers) });
    const res = await fetch(cfg.url + path, options);
    if (!res.ok) {
      let detail = '';
      try {
        const body = await res.json();
        detail = body.message || body.error_description || body.error || body.hint || '';
      } catch (e) {}
      throw new Error(`Supabase antwoordde ${res.status}${detail ? ': ' + detail : ''}`);
    }
    return res;
  }

  const encodePath = path => String(path).split('/').map(encodeURIComponent).join('/');

  function base64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  async function uploadDocument(cfg, doc) {
    const name = String(doc.name || 'factuur.pdf').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80);
    const now = new Date();
    const path = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}/`
               + `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${name}`;
    await call(cfg, `/storage/v1/object/${BUCKET}/${encodePath(path)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/pdf', 'x-upsert': 'false' },
      body: base64ToBytes(doc.base64)
    });
    return { path, name };
  }

  const str = v => (v === null || v === undefined ? null : String(v));
  const num = v => (v === null || v === undefined || v === '' || isNaN(Number(v)) ? null : Number(v));
  const int = v => { const n = num(v); return n === null ? null : Math.round(n); };

  /* One report as a row: the columns the list searches and filters on, and
     the whole report in detail. The PDF goes up first and the report keeps
     where it went, so a report waiting in the queue never uploads it twice. */
  async function insertRun(cfgIn, report) {
    const cfg = clean(cfgIn);
    if (report.document && report.document.base64 && !report.docPath) {
      const up = await uploadDocument(cfg, report.document);
      report.docPath = up.path;
      report.docName = up.name;
      delete report.document;
    }
    const detail = Object.assign({}, report);
    delete detail.document;

    const row = {
      booked_at: report.at ? new Date(report.at).toISOString() : null,
      user: str(report.user), machine: str(report.machine),
      invoice_no: str(report.invoiceNo), creditor: str(report.creditor), creditor_seq: str(report.creditorSeq),
      shipment: str(report.shipment), container: str(report.container), outcome: str(report.outcome),
      lines_total: int(report.lines), lines_booked: int(report.booked),
      amount: num(report.amount), avg_ms: int(report.avgMs), message: str(report.message),
      detail, doc_path: report.docPath || null, doc_name: report.docName || null
    };
    await call(cfg, '/rest/v1/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify(row)
    });
  }

  const LIST_COLUMNS = 'id,received_at,booked_at,user,invoice_no,creditor,shipment,container,'
                     + 'outcome,status,lines_total,lines_booked,amount,avg_ms,message,doc_name';

  async function listRuns(cfgIn, filters) {
    const cfg = clean(cfgIn);
    const f = filters || {};
    const p = new URLSearchParams({ select: LIST_COLUMNS, order: 'received_at.desc', limit: String(f.limit || 200) });
    // quoted, so a "B.V." or a comma in the search cannot break the filter
    const term = String(f.q || '').replace(/["\\]/g, '').trim();
    if (term) {
      p.set('or', '(' + ['invoice_no', 'creditor', 'shipment', 'container', 'user']
        .map(c => `${c}.ilike."*${term}*"`).join(',') + ')');
    }
    if (f.status) p.set('status', 'eq.' + f.status);
    if (f.user) p.set('user', 'eq.' + f.user);
    return (await call(cfg, '/rest/v1/runs?' + p)).json();
  }

  async function getRun(cfgIn, id) {
    const cfg = clean(cfgIn);
    const res = await call(cfg, `/rest/v1/runs?id=eq.${encodeURIComponent(id)}&select=*`, {
      headers: { Accept: 'application/vnd.pgrst.object+json' }
    });
    return res.json();
  }

  async function stats(cfgIn) {
    const cfg = clean(cfgIn);
    const res = await call(cfg, '/rest/v1/rpc/fiton_stats', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}'
    });
    return res.json();
  }

  /* Which version the department should be on. setup.sql answers from the
     releases table, or failing that from the version the reports themselves
     carry. A project that has not had setup.sql re-run yet does not have the
     function, and says so rather than breaking the check. */
  async function latestVersion(cfgIn) {
    const cfg = clean(cfgIn);
    const res = await call(cfg, '/rest/v1/rpc/fiton_latest_version', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}'
    });
    const body = await res.json();
    return {
      version: body && body.version ? String(body.version) : '',
      notes: (body && body.notes) || '',
      url: (body && body.url) || '',
      source: (body && body.source) || ''
    };
  }

  async function downloadDocument(cfgIn, path) {
    const cfg = clean(cfgIn);
    const res = await call(cfg, `/storage/v1/object/authenticated/${BUCKET}/${encodePath(path)}`);
    return res.blob();
  }

  /* Every part the extension relies on, each with a result of its own, so a
     missing step in setup.sql is named rather than guessed at. */
  async function test(cfgIn) {
    const cfg = clean(cfgIn);
    if (!cfg.url || !cfg.key) throw new Error('Vul de Project URL en de key in.');
    const steps = [
      ['Rapporten (tabel runs)', () => call(cfg, '/rest/v1/runs?select=id&limit=1')],
      ['Kengetallen (fiton_stats)', () => stats(cfg)],
      ['Facturen (opslag facturen)', () => call(cfg, `/storage/v1/object/list/${BUCKET}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prefix: '', limit: 1 })
      })],
      ['Versiecontrole (fiton_latest_version)', () => latestVersion(cfg)]
    ];
    const results = [];
    for (const [label, run] of steps) {
      try { await run(); results.push({ label, ok: true }); }
      catch (e) { results.push({ label, ok: false, error: e.message }); }
    }
    return results;
  }

  root.FitonSupabase = { BUCKET, clean, insertRun, listRuns, getRun, stats, latestVersion, downloadDocument, test };
})(typeof self !== 'undefined' ? self : this);
