#!/usr/bin/env node
// Fake MinerU server (self-hosted FastAPI + official mineru.net v4 emulation). Node built-ins only.
// Usage: node test/fake-mineru.mjs [--port 18765]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const argv = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const PORT = Number(argv('port', 18765));
const here = path.dirname(fileURLToPath(import.meta.url));
const ZIP = path.join(here, 'fixtures', 'demo', 'mineru-result.zip');
if (!fs.existsSync(ZIP)) { console.error('Missing ' + ZIP + ' - run: python3 test/build-fixture.py'); process.exit(1); }
const zipBuf = fs.readFileSync(ZIP);
const base = `http://127.0.0.1:${PORT}`;
const polls = {}; // batch_id -> poll count

function json(res, code, obj) {
  const b = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(b) });
  res.end(b);
}
function drain(req) { return new Promise((r) => { let n = 0; req.on('data', (c) => (n += c.length)); req.on('end', () => r(n)); req.on('error', () => r(n)); }); }

http.createServer(async (req, res) => {
  const url = new URL(req.url, base);
  const p = url.pathname;
  const bytes = await drain(req);
  let note = '';
  const done = (code) => console.log(`${new Date().toISOString()} ${req.method} ${p} -> ${code} body=${bytes}B ${note}`);
  const reply = (code, fn) => { fn(); done(code); };

  if (req.method === 'POST' && p === '/file_parse') {
    return reply(200, () => { res.writeHead(200, { 'content-type': 'application/zip', 'content-length': zipBuf.length }); res.end(zipBuf); });
  }
  if (req.method === 'GET' && p === '/docs') return reply(200, () => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html><title>Fake MinerU API</title><body>Fake MinerU</body></html>'); });
  if (req.method === 'GET' && p === '/openapi.json') return reply(200, () => json(res, 200, { openapi: '3.0.0', info: { title: 'Fake MinerU', version: '0' }, paths: { '/file_parse': { post: {} } } }));

  if (req.method === 'POST' && p === '/api/v4/file-urls/batch') {
    if ((req.headers.authorization || '') !== 'Bearer test-token') { note = 'bad token'; return reply(200, () => json(res, 200, { code: -10002, msg: 'token invalid' })); }
    polls.b1 = 0;
    return reply(200, () => json(res, 200, { code: 0, msg: 'ok', data: { batch_id: 'b1', file_urls: [`${base}/upload/b1`] } }));
  }
  if (req.method === 'PUT' && p.startsWith('/upload/')) return reply(200, () => { res.writeHead(200); res.end(); });
  const m = p.match(/^\/api\/v4\/extract-results\/batch\/([^/]+)$/);
  if (req.method === 'GET' && m) {
    const id = m[1];
    const n = (polls[id] = (polls[id] ?? 0) + 1);
    let r;
    if (n === 1) r = { state: 'waiting-file' };
    else if (n === 2) r = { state: 'pending' };
    else if (n === 3) r = { state: 'running', extract_progress: { extracted_pages: 3, total_pages: 15, start_time: '2026-01-01 00:00:00' } };
    else if (n === 4) r = { state: 'running', extract_progress: { extracted_pages: 12, total_pages: 15, start_time: '2026-01-01 00:00:00' } };
    else r = { state: 'done', full_zip_url: `${base}/zip/${id}` };
    note = `poll#${n} state=${r.state}`;
    return reply(200, () => json(res, 200, { code: 0, msg: 'ok', data: { batch_id: id, extract_result: [{ file_name: 'paper.pdf', data_id: 'd1', ...r }] } }));
  }
  if (req.method === 'GET' && p.startsWith('/zip/')) return reply(200, () => { res.writeHead(200, { 'content-type': 'application/zip', 'content-length': zipBuf.length }); res.end(zipBuf); });

  note = 'not found';
  reply(404, () => json(res, 404, { detail: 'not found' }));
}).listen(PORT, '127.0.0.1', () => console.log(`fake-mineru listening on ${base}`));
