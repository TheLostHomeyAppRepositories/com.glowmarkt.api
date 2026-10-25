'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const UnitRegistry = require('../../lib/glow/UnitRegistry');
const { mask, maskPayload, maskPostcodes } = require('../../lib/glow/mask');
const {
  STATE, ELECTRICITY, GAS, clone,
} = require('./examples');

const NOW = Date.parse('2026-10-25T16:08:30Z');

function registry() {
  return new UnitRegistry({ prefix: 'glow', now: () => NOW });
}

test('mask keeps the last four characters and leaves placeholders alone', () => {
  assert.equal(mask('1234567890123'), '••••0123');
  assert.equal(mask('Octopus Energy'), '••••ergy');
  assert.equal(mask('not available'), 'not available');
  assert.equal(mask('---'), '---');
  assert.equal(mask('12'), '12');
  assert.equal(mask(undefined), undefined);
});

test('maskPostcodes masks UK postcodes in names', () => {
  assert.equal(maskPostcodes('Smart Meter for YO10 3DD'), 'Smart Meter for ••••');
  assert.equal(maskPostcodes('Flat for SW1A1AA and EC1A 1BB'), 'Flat for •••• and ••••');
  assert.equal(maskPostcodes('Kitchen meter'), 'Kitchen meter');
  assert.equal(maskPostcodes(undefined), '');
});

test('maskPayload masks identifiers in valid and invalid JSON', () => {
  assert.equal(maskPayload('{"mpan":"1234567890123","eui":"12:34:56:78:91:23:45:67"}'), '{"mpan":"••••0123","eui":"••••5:67"}');
  assert.equal(maskPayload('{"supplier":"ABC ENERGY","mprn":"9876543210'), '{"supplier":"••••ERGY","mprn":"9876543210');
});

test('a unit is recorded from its first message, with per-topic counts', () => {
  const reg = registry();
  const units = [];
  reg.on('unit', (id) => units.push(id));
  reg.handleMessage('glow/1234567890ab/STATE', JSON.stringify(STATE));
  reg.handleMessage('glow/1234567890AB/SENSOR/electricitymeter', Buffer.from(JSON.stringify(ELECTRICITY)));
  reg.handleMessage('glow/1234567890AB/SENSOR/electricitymeter', JSON.stringify(ELECTRICITY));

  assert.deepEqual(units, ['1234567890AB']);
  const [unit] = reg.getUnits();
  assert.equal(unit.info.hardware, 'GLOW-IHD-02-1v4-SMETS2');
  assert.equal(unit.info.software, 'v2.0.2');
  assert.equal(unit.info.eui, '••••5:67');
  assert.deepEqual({ status: unit.han.status, rssi: unit.han.rssi, lqi: unit.han.lqi }, { status: 'joined', rssi: -32, lqi: 255 });
  assert.equal(unit.topics.STATE.count, 1);
  assert.equal(unit.topics.electricitymeter.count, 2);
  assert.equal(unit.topics.electricitymeter.lastAt, NOW);
  assert.equal(unit.topics.gasmeter.count, 0);
  assert.equal(unit.meters.electricitymeter.latest.importKwh, 10326.628);
  assert.equal(unit.meters.electricitymeter.meta.mpan, '••••0123');
});

test('meter readings are emitted for devices, STATE separately', () => {
  const reg = registry();
  const readings = [];
  const states = [];
  reg.on('reading', (r) => readings.push(r));
  reg.on('state', (s) => states.push(s));
  reg.handleMessage('glow/ABC/SENSOR/gasmeter', JSON.stringify(GAS));
  reg.handleMessage('glow/ABC/STATE', JSON.stringify(STATE));
  assert.equal(readings.length, 1);
  assert.equal(readings[0].unitId, 'ABC');
  assert.equal(readings[0].kind, 'gasmeter');
  assert.equal(readings[0].reading.fields.gasVolumeM3, 3182.181);
  assert.equal(states.length, 1);
  assert.equal(states[0].accepted.hanStatus, 'joined');
});

test('rejections are counted by kind and reason, and logged', () => {
  const reg = registry();
  reg.handleMessage('glow/ABC/SENSOR/electricitymeter', 'not json');
  const bad = clone(ELECTRICITY);
  bad.electricitymeter.power.value = -8388.608;
  bad.electricitymeter.energy.import.price.unitrate = null;
  reg.handleMessage('glow/ABC/SENSOR/electricitymeter', JSON.stringify(bad));
  const old = clone(ELECTRICITY);
  old.electricitymeter.timestamp = '1970-01-01T00:00:00Z';
  reg.handleMessage('glow/ABC/SENSOR/electricitymeter', JSON.stringify(old));

  const [unit] = reg.getUnits();
  assert.deepEqual(unit.rejections.electricitymeter, {
    invalid_json: 1, no_reading_value: 1, not_a_number: 1, bad_timestamp: 1,
  });
  const log = reg.getDebugLog();
  assert.deepEqual(log.map((e) => e.rejections), [
    ['rule 2: bad_timestamp'],
    ['rule 4: no_reading_value (powerKw)', 'rule 3: not_a_number (unitRate)'],
    ['rule 1: invalid_json'],
  ]);
  assert.ok(!log[1].payload.includes('1234567890123'));
});

test('unrecognised topics are counted and logged but create no unit', () => {
  const reg = registry();
  assert.equal(reg.handleMessage('glow/ABC/SENSOR/watermeter', '{}'), null);
  assert.equal(reg.ignored, 1);
  assert.equal(reg.getUnits().length, 0);
  assert.deepEqual(reg.getDebugLog()[0].rejections, ['unrecognised topic']);
});

test('the debug log keeps the newest 50 entries, newest first', () => {
  const reg = registry();
  for (let i = 0; i < 60; i++) reg.handleMessage(`glow/ABC/STATE`, JSON.stringify({ ...STATE, software: `v${i}` }));
  const log = reg.getDebugLog();
  assert.equal(log.length, 50);
  assert.match(log[0].payload, /"software":"v59"/);
  assert.match(log[49].payload, /"software":"v10"/);
});

test('unitsWithKind lists units that have sent that meter kind', () => {
  const reg = registry();
  reg.handleMessage('glow/AAA/SENSOR/gasmeter', JSON.stringify(GAS));
  reg.handleMessage('glow/BBB/STATE', JSON.stringify(STATE));
  assert.deepEqual(reg.unitsWithKind('gasmeter').map((u) => u.unitId), ['AAA']);
  assert.deepEqual(reg.unitsWithKind('electricitymeter'), []);
});

test('a gas payload without volume is flagged', () => {
  const reg = registry();
  const gas = clone(GAS);
  delete gas.gasmeter.energy.import.cumulativevol;
  reg.handleMessage('glow/AAA/SENSOR/gasmeter', JSON.stringify(gas));
  assert.equal(reg.getUnits()[0].meters.gasmeter.hasVolume, false);
});

test('the prefix can change', () => {
  const reg = registry();
  reg.setPrefix('home/glow/#');
  assert.equal(reg.handleMessage('glow/AAA/STATE', JSON.stringify(STATE)), null);
  assert.deepEqual(reg.handleMessage('home/glow/AAA/STATE', JSON.stringify(STATE)), { unitId: 'AAA', kind: 'STATE' });
});
