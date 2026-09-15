#!/usr/bin/env node
/* FitOn boekrapporten - dashboard

   Takes the report the extension produces at the end of a booking run, stores
   it, and shows it to everybody on the same network. One file, no dependencies
   beyond Node itself, one SQLite file next to it.

   Run:   FITON_TOKEN=<shared secret> node server.js
   Then:  http://<this machine>:8099/

   Two things worth deciding before this goes anywhere near a colleague:

   1. STORE_DOCUMENTS. With it on, the invoice PDF is sent along and kept on
      disk. That is the point of "met het factuur erbij", but it also means
      supplier invoices now live in a second place. Off by default.

   2. The token is a shared secret in a header, which is enough to stop the
      wrong tab from posting - it is not authentication. On anything other than
      an internal network, put this behind whatever login the company already
      uses rather than inventing one here.
*/

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

/* Settings come from a .env file next to this one, so they survive a restart
   and nobody has to remember the token. Real environment variables win, which
   keeps `FITON_PORT=9000 node server.js` working for a quick test, and lets a
   systemd unit or container override the file. Node can do this itself with
   --env-file, but not every way of starting a service passes that flag. */
function loadEnvFile(file) {
  if (!fs.existsSync(file)) return false;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m || /^\s*#/.test(line)) continue;
    let value = m[2].trim();
    if (/^(".*"|'.*')$/.test(value)) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, '').trim();     // strip a trailing comment
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
  return true;
}
const envFile = process.env.FITON_ENV || path.join(__dirname, '.env');
const usedEnvFile = loadEnvFile(envFile);

const PORT = Number(process.env.FITON_PORT || 8099);
const HOST = process.env.FITON_HOST || '0.0.0.0';
const TOKEN = process.env.FITON_TOKEN || '';
const STORE_DOCUMENTS = process.env.FITON_STORE_DOCUMENTS === '1';
const DATA_DIR = process.env.FITON_DATA || __dirname;
const MAX_BODY = 8 * 1024 * 1024;                 // a PDF plus its report

const db = new DatabaseSync(path.join(DATA_DIR, 'fiton-runs.db'));
db.exec(`
  CREATE TABLE IF NOT EXISTS runs (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    received_at  INTEGER NOT NULL,
    booked_at    INTEGER,
    user         TEXT,
    machine      TEXT,
    invoice_no   TEXT,
    creditor     TEXT,
    creditor_seq TEXT,
    shipment     TEXT,
    container    TEXT,
    outcome      TEXT,
    lines_total  INTEGER,
    lines_booked INTEGER,
    amount       REAL,
    avg_ms       INTEGER,
    message      TEXT,
    detail       TEXT NOT NULL,
    doc_name     TEXT,
    doc_file     TEXT
  );
  CREATE INDEX IF NOT EXISTS runs_received ON runs (received_at DESC);
  CREATE INDEX IF NOT EXISTS runs_invoice  ON runs (invoice_no);
`);

const docsDir = path.join(DATA_DIR, 'documents');
if (STORE_DOCUMENTS && !fs.existsSync(docsDir)) fs.mkdirSync(docsDir, { recursive: true });

const send = (res, status, body, type) => {
  const payload = type ? body : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': type || 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    /* The extension posts from a FitOn page, so the browser asks first. */
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type, x-fiton-token',
    'access-control-allow-methods': 'GET, POST, OPTIONS'
  });
  res.end(payload);
};

const readBody = req => new Promise((resolve, reject) => {
  let size = 0;
  const chunks = [];
  req.on('data', c => {
    size += c.length;
    if (size > MAX_BODY) { reject(new Error('te groot')); req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', () => resolve(Buffer.concat(chunks)));
  req.on('error', reject);
});

const str = v => (v === null || v === undefined ? null : String(v));
const num = v => (v === null || v === undefined || v === '' || isNaN(Number(v)) ? null : Number(v));

function saveRun(report) {
  let docName = null, docFile = null;
  if (STORE_DOCUMENTS && report.document && report.document.base64) {
    const safe = String(report.document.name || 'factuur.pdf').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80);
    docFile = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safe}`;
    fs.writeFileSync(path.join(docsDir, docFile), Buffer.from(report.document.base64, 'base64'));
    docName = safe;
  }

  const detail = Object.assign({}, report);
  delete detail.document;                        // the bytes live on disk, not in the row

  const row = db.prepare(`
    INSERT INTO runs (received_at, booked_at, user, machine, invoice_no, creditor, creditor_seq,
                      shipment, container, outcome, lines_total, lines_booked, amount, avg_ms,
                      message, detail, doc_name, doc_file)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(Date.now(), num(report.at), str(report.user), str(report.machine), str(report.invoiceNo),
         str(report.creditor), str(report.creditorSeq), str(report.shipment), str(report.container),
         str(report.outcome), num(report.lines), num(report.booked), num(report.amount), num(report.avgMs),
         str(report.message), JSON.stringify(detail), docName, docFile);
  return Number(row.lastInsertRowid);
}

/* One definition of what a run's result is, for the filter and the figures:
   everything booked, part of it, or nothing. */
const STATUS_SQL = {
  done: "outcome = 'done'",
  partial: "COALESCE(outcome, '') <> 'done' AND COALESCE(lines_booked, 0) > 0",
  failed: "COALESCE(outcome, '') <> 'done' AND COALESCE(lines_booked, 0) = 0"
};

const listQuery = `
  SELECT id, received_at, booked_at, user, invoice_no, creditor, shipment, container,
         outcome, lines_total, lines_booked, amount, avg_ms, message, doc_file IS NOT NULL AS has_doc
  FROM runs`;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const route = url.pathname;

  if (req.method === 'OPTIONS') return send(res, 204, '', 'text/plain');

  try {
    if (req.method === 'POST' && route === '/api/runs') {
      if (TOKEN && req.headers['x-fiton-token'] !== TOKEN) return send(res, 401, { error: 'token klopt niet' });
      let report;
      try { report = JSON.parse((await readBody(req)).toString('utf8')); }
      catch (e) { return send(res, 400, { error: 'geen geldige JSON' }); }
      if (!report || typeof report !== 'object') return send(res, 400, { error: 'leeg rapport' });
      const id = saveRun(report);
      return send(res, 201, { id, storedDocument: STORE_DOCUMENTS && !!(report.document && report.document.base64) });
    }

    if (req.method === 'GET' && route === '/api/runs') {
      const q = (url.searchParams.get('q') || '').trim();
      const user = (url.searchParams.get('user') || '').trim();
      const status = url.searchParams.get('status') || '';
      const limit = Math.min(Number(url.searchParams.get('limit') || 100), 500);

      const where = [], params = [];
      if (q) {
        where.push('(invoice_no LIKE ? OR creditor LIKE ? OR shipment LIKE ? OR container LIKE ? OR user LIKE ?)');
        params.push(...Array(5).fill(`%${q}%`));
      }
      if (user) { where.push('user = ?'); params.push(user); }
      if (status in STATUS_SQL) where.push(STATUS_SQL[status]);

      const rows = db.prepare(`${listQuery} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                               ORDER BY received_at DESC LIMIT ?`).all(...params, limit);
      return send(res, 200, { runs: rows, storeDocuments: STORE_DOCUMENTS });
    }

    /* The figures above the list: the last 30 days, and who has been booking. */
    if (req.method === 'GET' && route === '/api/stats') {
      const since = Date.now() - 30 * 24 * 3600 * 1000;
      const totals = db.prepare(`
        SELECT COUNT(*) AS runs,
               COALESCE(SUM(${STATUS_SQL.done}), 0) AS done,
               COALESCE(SUM(${STATUS_SQL.partial}), 0) AS partial,
               COALESCE(SUM(${STATUS_SQL.failed}), 0) AS failed,
               ROUND(COALESCE(SUM(CASE WHEN ${STATUS_SQL.done} THEN amount ELSE 0 END), 0), 2) AS amount,
               COUNT(DISTINCT NULLIF(user, '')) AS userCount
        FROM runs WHERE received_at >= ?`).get(since);
      const users = db.prepare(`
        SELECT user, COUNT(*) AS runs, MAX(received_at) AS last
        FROM runs WHERE user IS NOT NULL AND user <> ''
        GROUP BY user ORDER BY last DESC`).all();
      return send(res, 200, Object.assign({ since, users }, totals));
    }

    let m = route.match(/^\/api\/runs\/(\d+)$/);
    if (req.method === 'GET' && m) {
      const row = db.prepare('SELECT * FROM runs WHERE id = ?').get(Number(m[1]));
      if (!row) return send(res, 404, { error: 'niet gevonden' });
      row.detail = JSON.parse(row.detail);
      delete row.doc_file;
      return send(res, 200, row);
    }

    m = route.match(/^\/api\/runs\/(\d+)\/document$/);
    if (req.method === 'GET' && m) {
      const row = db.prepare('SELECT doc_name, doc_file FROM runs WHERE id = ?').get(Number(m[1]));
      if (!row || !row.doc_file) return send(res, 404, { error: 'geen document bewaard' });
      const file = path.join(docsDir, row.doc_file);
      if (!fs.existsSync(file)) return send(res, 404, { error: 'document staat niet meer op schijf' });
      const pdf = fs.readFileSync(file);
      res.writeHead(200, {
        'content-type': 'application/pdf',
        'content-length': pdf.length,
        'content-disposition': `inline; filename="${row.doc_name || 'factuur.pdf'}"`
      });
      return res.end(pdf);
    }

    if (req.method === 'GET' && (route === '/' || route === '/index.html')) {
      const page = fs.readFileSync(path.join(__dirname, 'dashboard.html'), 'utf8');
      return send(res, 200, page, 'text/html; charset=utf-8');
    }

    return send(res, 404, { error: 'onbekend pad' });
  } catch (e) {
    console.error('fout bij', route, e);
    return send(res, 500, { error: String(e.message || e) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`FitOn boekrapporten op http://${HOST}:${PORT}/`);
  console.log(usedEnvFile ? `Instellingen uit ${envFile}` : `Geen .env gevonden (${envFile}) — alleen omgevingsvariabelen.`);
  console.log(TOKEN ? 'Token is ingesteld.' : 'LET OP: geen FITON_TOKEN gezet — iedereen mag posten.');
  console.log(STORE_DOCUMENTS ? `Facturen worden bewaard in ${docsDir}` : 'Facturen worden niet bewaard (FITON_STORE_DOCUMENTS=1 zet dat aan).');
});

module.exports = server;
