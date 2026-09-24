import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dist = mkdtempSync(path.join(tmpdir(), 'dist-'));
mkdirSync(path.join(dist, 'assets'));
writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>APP</title><div id="root"></div>');
writeFileSync(path.join(dist, 'assets', 'app.js'), 'console.log("app");'.repeat(200));
writeFileSync(path.join(dist, 'secret.txt'), 'nope');
process.env.DIST_DIR = dist;
process.env.SITE_PASSWORD = 'kennebunk 2026';
process.env.SESSION_SECRET = 'test-secret';

const { createServer, makeSessionToken, isValidSession } = await import('../server.mjs');
let server, base;
before(async () => { server = createServer(); await new Promise((r) => server.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${server.address().port}`; });
after(() => server.close());

const get = (p, headers = {}) => fetch(base + p, { redirect: 'manual', headers });
const login = (code, next = '/', ip = '1.1.1.1') => fetch(base + '/login', {
  method: 'POST', redirect: 'manual',
  headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': ip },
  body: new URLSearchParams({ code, next }),
});
const cookieFrom = (r) => r.headers.get('set-cookie')?.split(';')[0];

test('nothing is served without the code', async () => {
  const page = await get('/', { accept: 'text/html' });
  assert.equal(page.status, 303);
  assert.match(page.headers.get('location'), /^\/login\?next=%2F/);
  assert.equal((await get('/assets/app.js')).status, 401);
  assert.equal((await get('/index.html')).status, 401);
  assert.equal((await get('/healthz')).status, 200, 'health check stays open for the host');
});

test('login page renders; wrong code is rejected', async () => {
  const p = await get('/login');
  assert.equal(p.status, 200);
  const html = await p.text();
  assert.match(html, /Access code/);
  assert.doesNotMatch(html, /kennebunk 2026/, 'the code never appears in the page');
  const bad = await login('guess');
  assert.equal(bad.status, 401);
  assert.equal(bad.headers.get('set-cookie'), null);
  assert.match(await bad.text(), /isn&#39;t right/);
});

test('right code sets a session and unlocks the app and its files', async () => {
  const ok = await login('kennebunk 2026', '/?view=score', '2.2.2.2');
  assert.equal(ok.status, 303);
  assert.equal(ok.headers.get('location'), '/?view=score');
  const setCookie = ok.headers.get('set-cookie');
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/);
  const cookie = cookieFrom(ok);
  const app = await get('/', { cookie });
  assert.equal(app.status, 200);
  assert.match(await app.text(), /APP/);
  const js = await get('/assets/app.js', { cookie, 'accept-encoding': 'gzip' });
  assert.equal(js.status, 200);
  assert.equal(js.headers.get('content-encoding'), 'gzip');
  assert.match(js.headers.get('cache-control'), /immutable/);
  assert.match(await js.text(), /console\.log/);
  assert.equal((await get('/some/deep/link', { cookie })).status, 200, 'SPA fallback');
  // raw request (fetch would normalise the ..) must not escape the dist folder
  const http = await import('node:http');
  const raw = await new Promise((resolve) => http.get({ host: '127.0.0.1', port: server.address().port, path: '/assets/../../../../etc/passwd', headers: { cookie } }, (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => resolve(b)); }));
  assert.ok(!raw.includes('root:'), 'dot-dot traversal blocked (falls back to the app page)');
  const enc = await new Promise((resolve) => http.get({ host: '127.0.0.1', port: server.address().port, path: '/%2e%2e/%2e%2e/etc/passwd', headers: { cookie } }, (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => resolve([r.statusCode, b])); }));
  assert.ok(!enc[1].includes('root:'), 'encoded traversal blocked');
});

test('forged, expired and tampered sessions are refused', async () => {
  assert.equal(isValidSession('123.abc'), false);
  assert.equal(isValidSession(makeSessionToken(Date.now() - 40 * 86400e3)), false, 'expired');
  const t = makeSessionToken();
  assert.equal(isValidSession(t), true);
  const [exp, mac] = t.split('.');
  assert.equal(isValidSession(`${Number(exp) + 1}.${mac}`), false, 'tampered expiry');
  assert.equal((await get('/', { cookie: `ws_session=${exp}.${mac}x` })).status, 401);
  // changing the code signs everyone out
  process.env.SITE_PASSWORD = 'new code';
  assert.equal(isValidSession(t), false);
  process.env.SITE_PASSWORD = 'kennebunk 2026';
});

test('open redirects are blocked', async () => {
  for (const next of ['//evil.com', 'https://evil.com', '/\\evil.com']) {
    const r = await login('kennebunk 2026', next, '3.3.3.3');
    assert.equal(r.headers.get('location'), '/');
  }
});

test('repeated wrong codes lock that visitor out for a while', async () => {
  const ip = '9.9.9.9';
  for (let i = 0; i < 5; i++) assert.equal((await login('nope', '/', ip)).status, 401);
  const locked = await login('kennebunk 2026', '/', ip);
  assert.equal(locked.status, 429, 'even the right code waits out the lock');
  assert.match(await locked.text(), /Too many attempts/);
  assert.equal((await login('kennebunk 2026', '/', '4.4.4.4')).status, 303, 'other visitors unaffected');
});

test('logout clears the session', async () => {
  const r = await get('/logout');
  assert.equal(r.status, 303);
  assert.match(r.headers.get('set-cookie'), /Max-Age=0/);
});

test('no password configured → locked, not open', async () => {
  delete process.env.SITE_PASSWORD;
  assert.equal((await get('/')).status, 503);
  assert.equal((await login('')).status, 503);
  process.env.SITE_PASSWORD = 'kennebunk 2026';
});
