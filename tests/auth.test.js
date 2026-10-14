import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import {
  clearAccessCookie,
  hasAccess,
  isProtected,
  requireAccess,
  setAccessCookie,
  validateCode
} from '../lib/auth.js';
import login from '../api/login.js';

const originalCode = process.env.DASHBOARD_ACCESS_CODE;

beforeEach(() => {
  process.env.DASHBOARD_ACCESS_CODE = 'Honduras-test-access';
});

afterEach(() => {
  if (originalCode === undefined) delete process.env.DASHBOARD_ACCESS_CODE;
  else process.env.DASHBOARD_ACCESS_CODE = originalCode;
});

function response() {
  return {
    headers: {},
    statusCode: undefined,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    setHeader(name, value) { this.headers[name] = value; }
  };
}

function validCookie() {
  const res = response();
  setAccessCookie(res);
  return res.headers['Set-Cookie'].split(';')[0];
}

test('missing access configuration denies data access and code validation', () => {
  delete process.env.DASHBOARD_ACCESS_CODE;
  assert.equal(isProtected(), false);
  assert.equal(hasAccess({ headers: {} }), false);
  assert.equal(validateCode(''), false);
  assert.equal(validateCode('anything'), false);
  const res = response();
  assert.equal(requireAccess({ headers: {} }, res), false);
  assert.equal(res.statusCode, 503);
  assert.deepEqual(res.body, { error: 'Dashboard access code is not configured' });
});

test('configured access requires the issued cookie', () => {
  assert.equal(isProtected(), true);
  assert.equal(hasAccess({ headers: {} }), false);
  assert.equal(hasAccess({ headers: { cookie: 'ili_country_access=incorrect' } }), false);
  const req = { headers: { cookie: validCookie() } };
  assert.equal(hasAccess(req), true);
  const res = response();
  assert.equal(requireAccess(req, res), true);
  assert.equal(res.statusCode, undefined);
  assert.equal(res.body, undefined);
});

test('unauthenticated configured requests return 401', () => {
  const res = response();
  assert.equal(requireAccess({ headers: {} }, res), false);
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { error: 'Authentication required' });
});

test('malformed percent-encoded cookies do not throw or grant access', () => {
  for (const cookie of ['ili_country_access=%', 'ili_country_access=%E0%A4%A']) {
    assert.doesNotThrow(() => hasAccess({ headers: { cookie } }));
    assert.equal(hasAccess({ headers: { cookie } }), false);
  }
  assert.equal(hasAccess({ headers: { cookie: `other=%; ${validCookie()}` } }), true);
});

test('issued cookies keep secure attributes and clearing expires the cookie', () => {
  const res = response();
  setAccessCookie(res);
  assert.match(res.headers['Set-Cookie'], /^ili_country_access=[a-f0-9]{64}; /);
  for (const attribute of ['Path=/', 'HttpOnly', 'Secure', 'SameSite=Lax', 'Max-Age=2592000']) {
    assert.ok(res.headers['Set-Cookie'].includes(attribute));
  }
  clearAccessCookie(res);
  assert.match(res.headers['Set-Cookie'], /^ili_country_access=; /);
  assert.ok(res.headers['Set-Cookie'].includes('Max-Age=0'));
});

test('login fails with 503 and no cookie when configuration is missing', async () => {
  delete process.env.DASHBOARD_ACCESS_CODE;
  const res = response();
  await login({ method: 'POST', body: { code: '' } }, res);
  assert.equal(res.statusCode, 503);
  assert.deepEqual(res.body, { error: 'Dashboard access code is not configured' });
  assert.equal(res.headers['Set-Cookie'], undefined);
});

test('configured login accepts object and JSON bodies and issues a usable cookie', async () => {
  for (const body of [
    { code: 'Honduras-test-access' },
    JSON.stringify({ code: 'Honduras-test-access' })
  ]) {
    const res = response();
    await login({ method: 'POST', body }, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { ok: true, protected: true });
    assert.equal(hasAccess({ headers: { cookie: res.headers['Set-Cookie'].split(';')[0] } }), true);
  }
});

test('invalid or malformed login bodies return 401 without a cookie', async () => {
  for (const body of [{ code: 'wrong' }, {}, '{bad json']) {
    const res = response();
    await login({ method: 'POST', body }, res);
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.body, { error: 'Invalid access code' });
    assert.equal(res.headers['Set-Cookie'], undefined);
  }
});

test('login rejects methods other than POST', async () => {
  const res = response();
  await login({ method: 'GET' }, res);
  assert.equal(res.statusCode, 405);
  assert.deepEqual(res.body, { error: 'Method not allowed' });
});
