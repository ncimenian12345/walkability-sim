// Production server: serves the built app (dist/) behind an access-code page.
// Nothing — HTML, scripts or data — is sent until the visitor enters the code.
//
// Environment:
//   SITE_PASSWORD   required  the access code
//   SESSION_SECRET  optional  extra secret for signing sessions (Render can generate one)
//   PORT            set by the host (default 10000)
//   DIST_DIR        optional  folder to serve (default ./dist)
//
// Uses only Node built-ins, so there is nothing extra to install.

import http from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(process.env.DIST_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), 'dist'));
const COOKIE = 'ws_session';
const SESSION_DAYS = 30;
const MAX_FAILS = 5;            // wrong codes allowed per IP…
const FAIL_WINDOW_MS = 15 * 60e3; // …within this window
const LOCK_MS = 5 * 60e3;         // then locked out for this long

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.txt': 'text/plain; charset=utf-8', '.map': 'application/json',
};
const COMPRESSIBLE = /\.(html|js|mjs|css|json|svg|txt|map)$/;

// ---------------- sessions ----------------
function signingKey() {
  // Changing the access code (or the secret) signs everyone out.
  return createHmac('sha256', process.env.SESSION_SECRET || 'walkability-sim').update(process.env.SITE_PASSWORD || '').digest();
}
function sign(value) {
  return createHmac('sha256', signingKey()).update(value).digest('base64url');
}
export function makeSessionToken(now = Date.now()) {
  const exp = String(now + SESSION_DAYS * 86400e3);
  return `${exp}.${sign(exp)}`;
}
export function isValidSession(token, now = Date.now()) {
  if (!token || !process.env.SITE_PASSWORD) return false;
  const [exp, mac] = token.split('.');
  if (!exp || !mac || !/^\d+$/.test(exp) || Number(exp) < now) return false;
  const a = Buffer.from(mac), b = Buffer.from(sign(exp));
  return a.length === b.length && timingSafeEqual(a, b);
}
export function codeMatches(given) {
  const want = process.env.SITE_PASSWORD;
  if (!want || typeof given !== 'string') return false;
  const a = createHmac('sha256', 'cmp').update(given).digest();
  const b = createHmac('sha256', 'cmp').update(want).digest();
  return timingSafeEqual(a, b);
}

function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
const isHttps = (req) => (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
function sessionCookie(req, value, maxAgeSec) {
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${isHttps(req) ? '; Secure' : ''}`;
}

// ---------------- brute-force protection ----------------
const attempts = new Map(); // ip -> {fails: [timestamps], lockedUntil}
const clientIp = (req) => (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '?';
function lockRemaining(ip, now = Date.now()) {
  const a = attempts.get(ip);
  return a && a.lockedUntil > now ? a.lockedUntil - now : 0;
}
function recordFail(ip, now = Date.now()) {
  const a = attempts.get(ip) || { fails: [], lockedUntil: 0 };
  a.fails = a.fails.filter((t) => now - t < FAIL_WINDOW_MS);
  a.fails.push(now);
  if (a.fails.length >= MAX_FAILS) { a.lockedUntil = now + LOCK_MS; a.fails = []; }
  attempts.set(ip, a);
  if (attempts.size > 5000) attempts.clear(); // keep memory bounded
}

// ---------------- access-code page ----------------
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export function loginPage({ error = '', next = '/' } = {}) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>Walkability Sim — Access</title>
<style>
  :root { --bg:#1b1f24; --panel:#23282f; --panel2:#2b3138; --border:#363d46; --text:#e8eaed; --muted:#9aa3ad; --accent:#4fc3f7; --bad:#ef5350; }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body { font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; color: var(--text);
    background: radial-gradient(1200px 600px at 70% 20%, #24405a 0%, transparent 60%), radial-gradient(900px 500px at 10% 90%, #1f3a2c 0%, transparent 60%), var(--bg);
    display: grid; place-items: center; padding: 16px; }
  .card { width: 100%; max-width: 380px; background: var(--panel); border: 1px solid var(--border); border-radius: 14px; padding: 28px 26px 24px; box-shadow: 0 20px 60px #0008; }
  .mark { width: 44px; height: 44px; border-radius: 10px; display: grid; place-items: center; background: #14202b; border: 1px solid var(--border); margin-bottom: 16px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  p { color: var(--muted); font-size: 14px; margin: 0 0 20px; line-height: 1.45; }
  label { display: block; font-size: 12px; color: var(--muted); margin-bottom: 6px; text-transform: uppercase; letter-spacing: .06em; }
  input { width: 100%; font: inherit; font-size: 16px; color: var(--text); background: var(--panel2); border: 1px solid var(--border); border-radius: 8px; padding: 11px 12px; outline: none; }
  input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px #4fc3f733; }
  button { width: 100%; margin-top: 14px; font: inherit; font-weight: 600; font-size: 15px; color: #062033; background: var(--accent); border: 0; border-radius: 8px; padding: 11px; cursor: pointer; }
  button:hover { filter: brightness(1.08); }
  .error { color: #ffab91; background: #3a2422; border: 1px solid #6d3a33; border-radius: 8px; padding: 9px 11px; font-size: 13px; margin-bottom: 14px; }
  .foot { margin-top: 18px; font-size: 12px; color: var(--muted); text-align: center; }
</style>
</head>
<body>
  <main class="card">
    <div class="mark" aria-hidden="true">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#4fc3f7" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21h18"/><path d="M5 21V10l4-3v14"/><path d="M9 21V4l6 3v14"/><path d="M15 21v-9l4 2v7"/></svg>
    </div>
    <h1>Walkability Sim</h1>
    <p>This project is private. Enter the access code to continue.</p>
    ${error ? `<div class="error" role="alert">${esc(error)}</div>` : ''}
    <form method="post" action="/login" autocomplete="on">
      <input type="hidden" name="next" value="${esc(next)}" />
      <label for="code">Access code</label>
      <input id="code" name="code" type="password" autocomplete="current-password" required autofocus />
      <button type="submit">Enter</button>
    </form>
    <div class="foot">You'll stay signed in on this device for ${SESSION_DAYS} days.</div>
  </main>
</body>
</html>`;
}

function safeNext(n) {
  return typeof n === 'string' && n.startsWith('/') && !n.startsWith('//') && !n.startsWith('/\\') ? n : '/';
}
function readBody(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// ---------------- static files ----------------
const cache = new Map(); // absolute path -> {raw, gz, type, mtime}
async function loadFile(abs) {
  const st = await stat(abs);
  if (!st.isFile()) return null;
  const hit = cache.get(abs);
  if (hit && hit.mtime === st.mtimeMs) return hit;
  const raw = await readFile(abs);
  const entry = { raw, gz: COMPRESSIBLE.test(abs) && raw.length > 1024 ? gzipSync(raw) : null, type: TYPES[path.extname(abs).toLowerCase()] || 'application/octet-stream', mtime: st.mtimeMs };
  cache.set(abs, entry);
  return entry;
}
async function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const abs = path.resolve(ROOT, '.' + rel);
  if (!abs.startsWith(ROOT + path.sep) && abs !== ROOT) return send(res, 400, 'Bad path');
  let file = await loadFile(abs).catch(() => null);
  let target = abs;
  if (!file && !path.extname(rel)) { target = path.join(ROOT, 'index.html'); file = await loadFile(target).catch(() => null); } // SPA fallback
  if (!file) return send(res, 404, 'Not found');
  const immutable = target.includes(`${path.sep}assets${path.sep}`);
  const headers = {
    'Content-Type': file.type,
    'Cache-Control': immutable ? 'private, max-age=31536000, immutable' : 'private, no-cache',
    'Vary': 'Accept-Encoding, Cookie',
    'X-Content-Type-Options': 'nosniff',
  };
  const gz = file.gz && /\bgzip\b/.test(req.headers['accept-encoding'] || '');
  if (gz) headers['Content-Encoding'] = 'gzip';
  const body = gz ? file.gz : file.raw;
  headers['Content-Length'] = body.length;
  res.writeHead(200, headers);
  res.end(req.method === 'HEAD' ? undefined : body);
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}
function sendHtml(res, status, html, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', ...headers });
  res.end(html);
}

// ---------------- request handling ----------------
export async function handle(req, res) {
  const url = new URL(req.url, 'http://local');
  const { pathname } = url;

  if (pathname === '/healthz') return send(res, 200, 'ok');

  if (!process.env.SITE_PASSWORD) {
    return send(res, 503, 'Site locked: set the SITE_PASSWORD environment variable and redeploy.');
  }

  if (pathname === '/logout') {
    return sendHtml(res, 303, '', { Location: '/login', 'Set-Cookie': sessionCookie(req, '', 0) });
  }

  if (pathname === '/login') {
    const ip = clientIp(req);
    if (req.method === 'POST') {
      let form;
      try { form = new URLSearchParams(await readBody(req)); } catch { return send(res, 413, 'Too large'); }
      const next = safeNext(form.get('next'));
      const locked = lockRemaining(ip);
      if (locked) return sendHtml(res, 429, loginPage({ next, error: `Too many attempts. Try again in ${Math.ceil(locked / 60e3)} minute${locked > 60e3 ? 's' : ''}.` }));
      if (codeMatches(form.get('code') || '')) {
        attempts.delete(ip);
        return sendHtml(res, 303, '', { Location: next, 'Set-Cookie': sessionCookie(req, makeSessionToken(), SESSION_DAYS * 86400) });
      }
      recordFail(ip);
      return sendHtml(res, 401, loginPage({ next, error: 'That code isn\'t right.' }));
    }
    if (isValidSession(cookies(req)[COOKIE])) return sendHtml(res, 303, '', { Location: safeNext(url.searchParams.get('next')) });
    return sendHtml(res, 200, loginPage({ next: safeNext(url.searchParams.get('next')) }));
  }

  if (!isValidSession(cookies(req)[COOKIE])) {
    const wantsPage = req.method === 'GET' && (req.headers.accept || '').includes('text/html');
    if (wantsPage) return sendHtml(res, 303, '', { Location: `/login?next=${encodeURIComponent(pathname + url.search)}` });
    return send(res, 401, 'Access code required');
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
  return serveStatic(req, res, pathname);
}

export function createServer() {
  return http.createServer((req, res) => {
    handle(req, res).catch((e) => { console.error(e); if (!res.headersSent) send(res, 500, 'Server error'); else res.end(); });
  });
}

// Start when run directly (not when imported by tests)
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 10000);
  if (!process.env.SITE_PASSWORD) console.warn('SITE_PASSWORD is not set — every page will answer 503 until it is.');
  createServer().listen(port, '0.0.0.0', () => console.log(`Walkability Sim serving ${ROOT} on :${port}`));
}
