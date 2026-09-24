import { test } from 'node:test';
import assert from 'node:assert/strict';
import middleware from '../middleware.js';

const req = (auth) => new Request('https://example.com/', { headers: auth ? { authorization: auth } : {} });
const basic = (u, p) => 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64');

test('fails closed when no password is configured', () => {
  delete process.env.SITE_PASSWORD;
  assert.equal(middleware(req(basic('a', 'b'))).status, 503);
});

test('asks for a password, rejects wrong ones, lets the right one through', () => {
  process.env.SITE_PASSWORD = 'kennebunk';
  delete process.env.SITE_USER;
  const r = middleware(req());
  assert.equal(r.status, 401);
  assert.match(r.headers.get('www-authenticate'), /^Basic realm=/);
  assert.equal(middleware(req(basic('anyone', 'nope'))).status, 401);
  assert.equal(middleware(req('Bearer xyz')).status, 401);
  assert.equal(middleware(req('Basic %%%')).status, 401);
  assert.equal(middleware(req(basic('anyone', 'kennebunk'))), undefined);
  assert.equal(middleware(req(basic('x', 'pass:with:colons'))).status, 401);
  process.env.SITE_PASSWORD = 'pass:with:colons';
  assert.equal(middleware(req(basic('x', 'pass:with:colons'))), undefined);
});

test('checks the username when SITE_USER is set', () => {
  process.env.SITE_PASSWORD = 'pw';
  process.env.SITE_USER = 'noah';
  assert.equal(middleware(req(basic('someone', 'pw'))).status, 401);
  assert.equal(middleware(req(basic('noah', 'pw'))), undefined);
  delete process.env.SITE_USER;
  delete process.env.SITE_PASSWORD;
});
