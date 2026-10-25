'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { classify, tokenExpiry } = require('../../lib/cloud/glowmarkt');

const jwt = (payload) => `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`;

test('tokenExpiry reads the exp claim in ms', () => {
  assert.equal(tokenExpiry(jwt({ exp: 1793000000 })), 1793000000 * 1000);
});

test('tokenExpiry returns null for anything it cannot read', () => {
  assert.equal(tokenExpiry(undefined), null);
  assert.equal(tokenExpiry('VOID'), null);
  assert.equal(tokenExpiry('a.b.c'), null);
  assert.equal(tokenExpiry(jwt({ sub: 'x' })), null);
});

test('classify treats a 401 or an error body as an auth failure', () => {
  assert.deepEqual(classify(200, { data: [] }), {
    status: 200, body: { data: [] }, ok: true, authFailed: false,
  });
  assert.equal(classify(401, null).authFailed, true);
  assert.equal(classify(401, null).ok, false);
  assert.equal(classify(200, { error: 'expired' }).authFailed, true);
  assert.equal(classify(200, { error: 'expired' }).ok, false);
});

test('classify treats other failures as errors without an auth failure', () => {
  assert.deepEqual(classify(500, null), {
    status: 500, body: null, ok: false, authFailed: false,
  });
  assert.equal(classify(200, null).ok, false);
});
