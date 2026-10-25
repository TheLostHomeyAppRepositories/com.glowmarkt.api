'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalisePrefix, normaliseUnitId, parseTopic, parsePayload,
} = require('../../lib/glow/parse');
const {
  STATE, ELECTRICITY, GAS, clone,
} = require('./examples');

test('normalisePrefix trims, drops # and spaces, and strips trailing slashes', () => {
  assert.equal(normalisePrefix(' glow '), 'glow');
  assert.equal(normalisePrefix('glow/#'), 'glow');
  assert.equal(normalisePrefix('home/glow/'), 'home/glow');
  assert.equal(normalisePrefix('my glow'), 'myglow');
  assert.equal(normalisePrefix(undefined), '');
});

test('normaliseUnitId uppercases and removes colons and spaces', () => {
  assert.equal(normaliseUnitId('12:34:56:78:90:ab'), '1234567890AB');
  assert.equal(normaliseUnitId(' 1234 5678 90ab '), '1234567890AB');
});

test('parseTopic recognises the three Glow topics', () => {
  assert.deepEqual(parseTopic('glow/1234567890AB/STATE', 'glow'), { unitId: '1234567890AB', kind: 'STATE' });
  assert.deepEqual(parseTopic('glow/1234567890ab/SENSOR/electricitymeter', 'glow'), { unitId: '1234567890AB', kind: 'electricitymeter' });
  assert.deepEqual(parseTopic('glow/1234567890AB/SENSOR/gasmeter', 'glow/'), { unitId: '1234567890AB', kind: 'gasmeter' });
});

test('parseTopic handles a multi-level prefix', () => {
  assert.deepEqual(parseTopic('home/glow/ABC/STATE', 'home/glow'), { unitId: 'ABC', kind: 'STATE' });
});

test('parseTopic ignores everything else', () => {
  assert.equal(parseTopic('other/ABC/STATE', 'glow'), null);
  assert.equal(parseTopic('glowing/ABC/STATE', 'glow'), null);
  assert.equal(parseTopic('glow/ABC/SENSOR/watermeter', 'glow'), null);
  assert.equal(parseTopic('glow/ABC/SENSOR/STATE', 'glow'), null);
  assert.equal(parseTopic('glow/ABC/STATE/extra', 'glow'), null);
  assert.equal(parseTopic('glow/ABC', 'glow'), null);
  assert.equal(parseTopic('glow//STATE', 'glow'), null);
  assert.equal(parseTopic('$SYS/broker/uptime', 'glow'), null);
  assert.equal(parseTopic('glow/ABC/STATE', ''), null);
});

test('parsePayload normalises an electricity payload', () => {
  const result = parsePayload('electricitymeter', JSON.stringify(ELECTRICITY));
  assert.equal(result.ok, true);
  assert.deepEqual(result.reading, {
    kind: 'electricitymeter',
    timestamp: '2026-10-25T16:08:12Z',
    fields: {
      powerKw: -3.873,
      importKwh: 10326.628,
      exportKwh: 2004.682,
      unitRate: 0.2563,
      standingCharge: 0.607,
    },
    meta: { mpan: '1234567890123', supplier: 'ABC ENERGY' },
  });
});

test('parsePayload normalises a gas payload and never uses gas power', () => {
  const withPower = clone(GAS);
  withPower.gasmeter.power = { value: 1.2, units: 'kW' };
  const result = parsePayload('gasmeter', Buffer.from(JSON.stringify(withPower)));
  assert.equal(result.ok, true);
  assert.deepEqual(result.reading, {
    kind: 'gasmeter',
    timestamp: '2026-10-25T16:07:59Z',
    hasVolume: true,
    fields: {
      gasVolumeM3: 3182.181,
      gasEnergyKwh: 35706.086,
      unitRate: 0.0792,
      standingCharge: 0.2884,
    },
    meta: { mprn: 'not available', supplier: '---' },
  });
});

test('parsePayload flags gas payloads without cumulativevol', () => {
  const gas = clone(GAS);
  delete gas.gasmeter.energy.import.cumulativevol;
  const result = parsePayload('gasmeter', JSON.stringify(gas));
  assert.equal(result.reading.hasVolume, false);
  assert.equal(result.reading.fields.gasVolumeM3, undefined);
});

test('parsePayload normalises STATE', () => {
  const result = parsePayload('STATE', JSON.stringify(STATE));
  assert.equal(result.ok, true);
  assert.equal(result.reading.mac, '1234567890AB');
  assert.equal(result.reading.software, 'v2.0.2');
  assert.deepEqual(result.reading.han, { status: 'joined', rssi: -32, lqi: 255 });
});

test('parsePayload takes the MAC from ethmac on Ethernet CADs', () => {
  const state = clone(STATE);
  delete state.wifistamac;
  state.ethmac = 'ABCDEF123456';
  assert.equal(parsePayload('STATE', JSON.stringify(state)).reading.mac, 'ABCDEF123456');
});

test('parsePayload tolerates missing nested objects', () => {
  const result = parsePayload('electricitymeter', JSON.stringify({ electricitymeter: { timestamp: '2022-06-11T20:38:00Z' } }));
  assert.equal(result.ok, true);
  assert.equal(result.reading.fields.importKwh, undefined);
  assert.equal(result.reading.fields.powerKw, undefined);
});

test('rule 1: invalid JSON is a rejection, not an exception', () => {
  const result = parsePayload('electricitymeter', '{"electricitymeter":');
  assert.equal(result.ok, false);
  assert.equal(result.rule, 1);
  assert.equal(result.reason, 'invalid_json');
});

test('rule 1: missing top-level object is a rejection', () => {
  for (const [kind, payload] of [
    ['gasmeter', JSON.stringify(ELECTRICITY)],
    ['electricitymeter', 'null'],
    ['electricitymeter', '[1,2]'],
    ['electricitymeter', '{"electricitymeter":"x"}'],
    ['STATE', '42'],
  ]) {
    const result = parsePayload(kind, payload);
    assert.equal(result.ok, false, `${kind} ${payload}`);
    assert.equal(result.rule, 1);
    assert.equal(result.reason, 'missing_object');
  }
});
