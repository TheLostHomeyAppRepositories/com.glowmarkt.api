'use strict';

// Runs the cloud driver and device against a fake Glowmarkt API, with node-fetch
// replaced before anything loads it.

const test = require('node:test');
const assert = require('node:assert/strict');

const calls = [];
let routes = {};
async function fakeFetch(url, options = {}) {
  const path = url.replace('https://api.glowmarkt.com/api/v0-1', '');
  calls.push({ path, method: options.method, token: options.headers && options.headers.token });
  const route = routes[`${options.method} ${path}`];
  if (!route) throw new Error(`No fake route for ${options.method} ${path}`);
  const { status = 200, body } = typeof route === 'function' ? route(options) : route;
  return {
    status,
    json: async () => {
      if (body === undefined) throw new SyntaxError('Unexpected end of JSON input');
      return body;
    },
  };
}
require.cache[require.resolve('node-fetch')] = {
  id: 'node-fetch', filename: require.resolve('node-fetch'), loaded: true, exports: fakeFetch,
};

require('../helpers/homey-stub');
const Driver = require('../../drivers/smart-meter/driver');
const Device = require('../../drivers/smart-meter/device');
const { summarise, apiError } = require('../../lib/cloud/glowmarkt');

const DAY = 24 * 60 * 60 * 1000;
const jwt = (expMs) => `h.${Buffer.from(JSON.stringify({ exp: Math.floor(expMs / 1000) })).toString('base64url')}.s`;
const FRESH_TOKEN = jwt(Date.now() + 7 * DAY);
const USERNAME = 'someone@example.com';

function resetApi(extra = {}) {
  calls.length = 0;
  routes = {
    'POST /auth': { body: { valid: true, token: FRESH_TOKEN } },
    'GET /virtualentity': {
      body: [
        { veId: 've-good-0001', name: 'Smart Meter', postalCode: 'YO10 3DD' },
        { veId: 've-stale-0002', name: 'DCC Sourced', postalCode: 'YO10 3DD' },
        { veId: 've-empty-0003', name: 'Empty entry', postalCode: 'YO10 3DD' },
        { veId: 've-broken-0004', name: 'Broken entry', postalCode: 'YO10 3DD' },
      ],
    },
    'GET /virtualentity/ve-good-0001/resources': { body: { resources: [{ resourceId: 'res-gas-0001', name: 'gas consumption' }, { resourceId: 'res-good-0001', name: 'electricity consumption' }] } },
    // The stale entry lists its resources normally and only fails on /current.
    'GET /virtualentity/ve-stale-0002/resources': { body: { resources: [{ resourceId: 'res-stale-0002', name: 'electricity consumption' }] } },
    'GET /virtualentity/ve-empty-0003/resources': { body: { resources: [] } },
    'GET /virtualentity/ve-broken-0004/resources': { status: 500 },
    'GET /resource/res-good-0001/current': { body: { data: [[1761400000, 512]] } },
    'GET /resource/res-stale-0002/current': { status: 401, body: { error: 'Unauthorized' } },
    ...extra,
  };
}

function makeDriver(devices = []) {
  const driver = new Driver();
  driver.homey = { flow: { getDeviceTriggerCard: () => ({ trigger: async () => {} }) } };
  driver.log = () => {};
  driver.error = () => {};
  driver.getDevices = () => devices;
  driver.onInit();
  return driver;
}

function makeDevice(driver, { token = FRESH_TOKEN, name = 'Smart Meter for YO10 3DD', username = USERNAME } = {}) {
  const device = new Device();
  const store = { token, elec_cons_res: 'res-good-0001' };
  Object.assign(device, {
    driver,
    homey: { __: (key) => key },
    log: () => {},
    error: () => {},
    getStoreValue: (key) => store[key],
    setStoreValue: async (key, value) => { store[key] = value; },
    getName: () => name,
    getAvailable: () => true,
    getSetting: (key) => ({ username, password: 'pw' })[key],
    getSettings: () => ({ username, password: 'pw' }),
    setUnavailable: async () => {},
    cloudStatus: { lastSuccessAt: null, lastError: null },
  });
  return { device, store };
}

async function pair(driver) {
  const handlers = {};
  await driver.onPair({ setHandler: (name, handler) => { handlers[name] = handler; } });
  assert.equal(await handlers.login({ username: USERNAME, password: 'pw' }), true);
  return handlers.list_devices();
}

test('pairing lists working entries and leaves out failing ones with a reason', async () => {
  resetApi();
  const driver = makeDriver();
  const devices = await pair(driver);

  assert.deepEqual(devices.map((d) => d.store.elec_cons_res), ['res-good-0001']);
  const [account] = driver.getCloudStatus();
  assert.equal(account.number, 1);
  assert.deepEqual(account.skipped.map((s) => [s.name, s.reason]), [
    ['DCC Sourced', { code: 'read_failed', status: 401 }],
    ['Empty entry', { code: 'no_resources' }],
    ['Broken entry', { code: 'resources_failed', status: 500 }],
  ]);
});

test('a network error while checking an entry is a skip, not a pairing failure', async () => {
  resetApi({
    'GET /resource/res-stale-0002/current': () => {
      throw Object.assign(new Error('request to https://api.glowmarkt.com/api/v0-1/resource/res-stale-0002/current failed, reason: getaddrinfo ENOTFOUND'), { type: 'system', code: 'ENOTFOUND' });
    },
  });
  const driver = makeDriver();
  const devices = await pair(driver);
  assert.equal(devices.length, 1);
  const skip = driver.getCloudStatus()[0].skipped.find((s) => s.name === 'DCC Sourced');
  assert.deepEqual(skip.reason, { code: 'error', message: 'Network error (ENOTFOUND)' });
});

test('cloud status groups devices by account without showing identifiers', async () => {
  resetApi();
  const driver = makeDriver();
  await pair(driver);
  const devices = [
    makeDevice(driver).device,
    makeDevice(driver, { name: 'DCC Sourced for YO10 3DD', token: jwt(Date.now() + 3 * DAY) }).device,
    makeDevice(driver, { name: 'Other home', username: 'other@example.com' }).device,
  ];
  driver.getDevices = () => devices;

  const accounts = driver.getCloudStatus();
  assert.equal(accounts.length, 2);
  assert.deepEqual(accounts.map((a) => a.number), [1, 2]);
  assert.deepEqual(accounts[0].devices.map((d) => d.name), ['Smart Meter for ••••', 'DCC Sourced for ••••']);
  assert.equal(accounts[0].skipped.length, 3);
  assert.equal(accounts[1].skipped.length, 0);

  // The account's renewal time is the earliest of its devices'.
  const threeDays = jwt(Date.now() + 3 * DAY);
  const expected = JSON.parse(Buffer.from(threeDays.split('.')[1], 'base64url')).exp * 1000 - DAY;
  assert.equal(accounts[0].tokenRenewsAt, expected);

  const text = JSON.stringify(accounts);
  for (const identifier of ['example.com', 'YO10', '3DD', 've-', 'res-', FRESH_TOKEN]) {
    assert.ok(!text.includes(identifier), `status contains ${identifier}`);
  }
});

test('an entry still refused after a fresh login backs off for an hour with a message', async () => {
  resetApi();
  const driver = makeDriver();
  const { device } = makeDevice(driver);
  let unavailableMessage;
  device.setUnavailable = async (message) => { unavailableMessage = message; };

  const error = await device.request('/resource/res-stale-0002/current').catch((e) => e);
  assert.equal(error.accessRefused, true);
  assert.equal(summarise(error), 'HTTP 401 after a fresh login');
  assert.equal(unavailableMessage, 'cloud.accessRefused');
  assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), [
    'GET /resource/res-stale-0002/current', 'POST /auth', 'GET /resource/res-stale-0002/current',
  ]);

  const status = device.getCloudStatus();
  assert.ok(status.accessRefusedUntil > Date.now() + 59 * 60 * 1000);
  assert.equal(device.isAccessRefused(), true);
});

test('concurrent polls that hit an expired token share one login', async () => {
  resetApi({
    'GET /resource/res-good-0001/current': (options) => (options.headers.token === FRESH_TOKEN
      ? { body: { data: [[1, 2]] } } : { status: 401, body: { error: 'expired' } }),
    'GET /resource/res-good-0001/tariff': (options) => (options.headers.token === FRESH_TOKEN
      ? { body: { data: [{ currentRates: { rate: 24.5 } }] } } : { status: 401, body: { error: 'expired' } }),
  });
  const driver = makeDriver();
  const { device, store } = makeDevice(driver, { token: 'old-token' });
  await Promise.all([
    device.request('/resource/res-good-0001/current'),
    device.request('/resource/res-good-0001/tariff'),
  ]);
  assert.equal(calls.filter((c) => c.path === '/auth').length, 1);
  assert.equal(store.token, FRESH_TOKEN);
});

test('a token expiring within a day is renewed before the request', async () => {
  resetApi();
  const driver = makeDriver();
  const { device, store } = makeDevice(driver, { token: jwt(Date.now() + 12 * 60 * 60 * 1000) });
  await device.request('/resource/res-good-0001/current');
  assert.deepEqual(calls.map((c) => c.path), ['/auth', '/resource/res-good-0001/current']);
  assert.equal(calls[1].token, FRESH_TOKEN);
  assert.equal(store.token, FRESH_TOKEN);
});

test('other API errors are summarised without bodies or IDs', async () => {
  resetApi({ 'GET /resource/res-good-0001/meterread': { status: 503, body: { message: 'resource res-good-0001 busy' } } });
  const driver = makeDriver();
  const { device } = makeDevice(driver);
  const error = await device.request('/resource/res-good-0001/meterread').catch((e) => e);
  device.recordError('power', error);
  assert.equal(device.getCloudStatus().lastError.message, 'HTTP 503 from /meterread');
  assert.equal(device.getCloudStatus().lastError.poll, 'power');
  assert.match(error.message, /res-good-0001 busy/);
});

test('summarise strips IDs, URLs and bodies from unexpected errors', () => {
  assert.equal(summarise(apiError('Power API returned no data', '{"id":"abc"}')), 'Power API returned no data');
  assert.equal(summarise(new Error('Cannot read properties of undefined (reading 0)')), 'Cannot read properties of undefined (reading 0)');
  assert.equal(summarise(new Error('Bad thing: {"resourceId":"0123456789abcdef0123"}')), 'Bad thing');
  assert.equal(summarise(new Error('failed for 0123456789abcdef0123')), 'failed for …');
  assert.equal(summarise(new Error('request to https://api.glowmarkt.com/x failed')), 'request to');
  assert.equal(summarise(undefined), 'Unknown error');
});
