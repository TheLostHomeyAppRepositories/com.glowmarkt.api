'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parsePayload } = require('../../lib/glow/parse');
const {
  emptyState, validateReading, validateState, GAS_KWH_PER_M3,
} = require('../../lib/glow/validate');
const {
  STATE, ELECTRICITY, GAS, clone,
} = require('./examples');

const NOW = Date.parse('2026-10-25T12:00:00Z');
const MINUTE = 60 * 1000;
const iso = (ms) => new Date(ms).toISOString();

const elec = (fields, ms = NOW) => ({ kind: 'electricitymeter', timestamp: iso(ms), fields });
const gas = (fields, ms = NOW) => ({ kind: 'gasmeter', timestamp: iso(ms), fields });
const validate = (reading, state) => validateReading(reading, state, { now: NOW });
const rulesOf = (result) => result.rejections.map((r) => `${r.field}:${r.rule}`);

// Feeds readings in order, returning every result and the final state.
function run(readings, state = emptyState()) {
  const results = [];
  for (const reading of readings) {
    const result = validate(reading, state);
    results.push(result);
    state = result.state;
  }
  return { results, state };
}

test('the example payloads pass every rule', () => {
  const now = Date.parse('2026-10-25T16:10:00Z');
  for (const [kind, payload] of [['electricitymeter', ELECTRICITY], ['gasmeter', GAS]]) {
    const { reading } = parsePayload(kind, JSON.stringify(payload));
    const result = validateReading(reading, emptyState(), { now });
    assert.equal(result.ok, true);
    assert.deepEqual(result.rejections, [], kind);
    assert.deepEqual(result.accepted, reading.fields);
  }
});

test('rule 2: bad timestamps reject the whole message and leave state alone', () => {
  const state = validate(elec({ importKwh: 100 }, NOW - MINUTE)).state;
  for (const timestamp of [undefined, null, 'not a date', '1970-01-01T00:00:00Z', '2019-12-31T23:59:59Z', iso(NOW + 25 * 60 * MINUTE)]) {
    const result = validate({ kind: 'electricitymeter', timestamp, fields: { importKwh: 101 } }, state);
    assert.equal(result.ok, false, String(timestamp));
    assert.deepEqual(rulesOf(result), ['null:2']);
    assert.equal(result.state, state);
  }
  assert.equal(validate(elec({ importKwh: 100 }, NOW + 23 * 60 * MINUTE)).ok, true);
});

test('rule 2: the 1970 garbage message with null readings is rejected (issue 90)', () => {
  const result = validate({
    kind: 'electricitymeter',
    timestamp: '1970-01-01T00:00:00Z',
    fields: { powerKw: null, importKwh: null, exportKwh: null, unitRate: null, standingCharge: null },
  });
  assert.equal(result.ok, false);
});

test('rule 3: null, missing and non-numeric fields are skipped one by one', () => {
  const result = validate(elec({
    powerKw: '0.951', importKwh: 6613.405, exportKwh: undefined, unitRate: null, standingCharge: 0.2403,
  }));
  assert.equal(result.ok, true);
  assert.deepEqual(rulesOf(result), ['powerKw:3', 'exportKwh:3', 'unitRate:3']);
  assert.deepEqual(result.accepted, { importKwh: 6613.405, standingCharge: 0.2403 });
});

test('rule 4: protocol "no reading" values are skipped', () => {
  const result = validate(elec({ powerKw: -8388.608, importKwh: 281474976710655, exportKwh: 281474976710.655 }));
  assert.deepEqual(rulesOf(result), ['powerKw:4', 'importKwh:4', 'exportKwh:4']);
  const gasResult = validate(gas({ gasVolumeM3: 281474976710655, gasEnergyKwh: 281474976710.655 }));
  assert.deepEqual(rulesOf(gasResult), ['gasVolumeM3:4', 'gasEnergyKwh:4']);
});

test('rule 5: zero totals and tariffs are skipped, zero power and export are kept', () => {
  const result = validate(elec({
    powerKw: 0, importKwh: 0, exportKwh: 0, unitRate: 0, standingCharge: 0,
  }));
  assert.deepEqual(rulesOf(result), ['importKwh:5', 'unitRate:5', 'standingCharge:5']);
  assert.deepEqual(result.accepted, { powerKw: 0, exportKwh: 0 });
  const gasResult = validate(gas({ gasVolumeM3: 0, gasEnergyKwh: 0 }));
  assert.deepEqual(rulesOf(gasResult), ['gasVolumeM3:5', 'gasEnergyKwh:5']);
});

test('rule 5: a nightly drop to zero does not disturb the last good total', () => {
  const { results, state } = run([
    elec({ importKwh: 6613.405 }, NOW - 2 * MINUTE),
    elec({ importKwh: 0 }, NOW - MINUTE),
    elec({ importKwh: 6613.41 }, NOW),
  ]);
  assert.deepEqual(rulesOf(results[1]), ['importKwh:5']);
  assert.deepEqual(results[2].accepted, { importKwh: 6613.41 });
  assert.equal(state.lastGood.importKwh.value, 6613.41);
});

test('rule 6: power beyond ±30 kW, unit rates outside −£1 to £5 and standing charges outside 0 to £5 are skipped', () => {
  const result = validate(elec({ powerKw: 30.001, unitRate: 5.01, standingCharge: -0.1 }));
  assert.deepEqual(rulesOf(result), ['powerKw:6', 'unitRate:6', 'standingCharge:6']);
  assert.deepEqual(rulesOf(validate(elec({ powerKw: -30.5, unitRate: -1.01 }))), ['powerKw:6', 'unitRate:6']);
  const ok = validate(elec({ powerKw: -30, unitRate: 5, standingCharge: 0.0001 }));
  assert.deepEqual(ok.rejections, []);
});

test('rule 6: negative unit rates down to −£1 are kept', () => {
  assert.deepEqual(validate(elec({ unitRate: -0.05 })).accepted, { unitRate: -0.05 });
  assert.deepEqual(validate(elec({ unitRate: -1 })).accepted, { unitRate: -1 });
});

test('rule 6: negative export power within range is kept, signed', () => {
  assert.deepEqual(validate(elec({ powerKw: -2.5 })).accepted, { powerKw: -2.5 });
});

test('rule 7: totals lower than the last good value are skipped, export included', () => {
  const { results, state } = run([
    elec({ importKwh: 100, exportKwh: 50 }, NOW - MINUTE),
    elec({ importKwh: 99.999, exportKwh: 49 }, NOW),
  ]);
  assert.deepEqual(rulesOf(results[1]), ['importKwh:7', 'exportKwh:7']);
  assert.equal(state.lastGood.importKwh.value, 100);
  assert.equal(state.lastGood.exportKwh.value, 50);
});

test('rule 7: an unchanged total is accepted', () => {
  const { results } = run([gas({ gasVolumeM3: 3177.49 }, NOW - 30 * MINUTE), gas({ gasVolumeM3: 3177.49 })]);
  assert.deepEqual(results[1].rejections, []);
});

test('rule 8: electricity rises beyond 30 kW × hours + 0.1 kWh are skipped', () => {
  // 10 minutes allows 30 × 1/6 + 0.1 = 5.1 kWh.
  const start = elec({ importKwh: 100, exportKwh: 10 }, NOW - 10 * MINUTE);
  const ok = run([start, elec({ importKwh: 105.09, exportKwh: 15.09 })]).results[1];
  assert.deepEqual(ok.rejections, []);
  const bad = run([start, elec({ importKwh: 105.2, exportKwh: 15.2 })]);
  assert.deepEqual(rulesOf(bad.results[1]), ['importKwh:8', 'exportKwh:8']);
  assert.equal(bad.state.lastGood.importKwh.value, 100);
});

test('rule 8: a re-send with the same timestamp may only move by the slack', () => {
  const start = elec({ importKwh: 100 });
  assert.deepEqual(run([start, elec({ importKwh: 100.1 })]).results[1].rejections, []);
  assert.deepEqual(rulesOf(run([start, elec({ importKwh: 100.2 })]).results[1]), ['importKwh:8']);
});

test('rule 8: gas rises beyond 10 m³/h × hours + 0.05 m³, and the kWh equivalent, are skipped', () => {
  // 30 minutes allows 5.05 m³, or 5.05 × 11.2 = 56.56 kWh.
  const start = gas({ gasVolumeM3: 3177.49, gasEnergyKwh: 35570 }, NOW - 30 * MINUTE);
  const ok = run([start, gas({ gasVolumeM3: 3182.53, gasEnergyKwh: 35570 + 5.04 * GAS_KWH_PER_M3 })]).results[1];
  assert.deepEqual(ok.rejections, []);
  const bad = run([start, gas({ gasVolumeM3: 3182.6, gasEnergyKwh: 35570 + 5.1 * GAS_KWH_PER_M3 })]).results[1];
  assert.deepEqual(rulesOf(bad), ['gasVolumeM3:8', 'gasEnergyKwh:8']);
});

test('rules 7–9 do not apply to the first reading', () => {
  const result = validate(elec({ importKwh: 999999, exportKwh: 0.001 }));
  assert.deepEqual(result.rejections, []);
});

test('rule 9: six consistent lower gas readings become a new baseline', () => {
  const readings = [gas({ gasVolumeM3: 3177.49 }, NOW - 7 * 30 * MINUTE)];
  for (let i = 1; i <= 6; i++) readings.push(gas({ gasVolumeM3: 1 + i * 0.1 }, NOW - (7 - i) * 30 * MINUTE));
  const { results, state } = run(readings);
  for (let i = 1; i <= 5; i++) assert.deepEqual(rulesOf(results[i]), ['gasVolumeM3:7'], `reading ${i}`);
  assert.deepEqual(results[6].rejections, []);
  assert.deepEqual(results[6].baselineResets, ['gasVolumeM3']);
  assert.equal(state.lastGood.gasVolumeM3.value, 1.6);
  assert.equal(state.series.gasVolumeM3, undefined);

  // The new series carries on as normal.
  const next = validate(gas({ gasVolumeM3: 1.7 }, NOW + 30 * MINUTE), state);
  assert.deepEqual(next.rejections, []);
});

test('rule 9: electricity needs 30 consistent readings', () => {
  const readings = [elec({ importKwh: 6613 }, NOW - 31 * MINUTE)];
  for (let i = 1; i <= 30; i++) readings.push(elec({ importKwh: 10 + i * 0.01 }, NOW - (31 - i) * MINUTE));
  const { results } = run(readings);
  assert.deepEqual(rulesOf(results[29]), ['importKwh:7']);
  assert.deepEqual(results[30].baselineResets, ['importKwh']);
});

test('rule 9: an inconsistent reading restarts the series', () => {
  const readings = [gas({ gasVolumeM3: 3177.49 }, NOW - 10 * 30 * MINUTE)];
  const values = [1.1, 1.2, 1.3, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0];
  values.forEach((v, i) => readings.push(gas({ gasVolumeM3: v }, NOW - (9 - i) * 30 * MINUTE)));
  const { results } = run(readings);
  // 0.5 falls below 1.3, so the series restarts there and completes six later at 1.0.
  for (let i = 1; i <= 8; i++) assert.deepEqual(results[i].baselineResets, [], `reading ${i}`);
  assert.deepEqual(results[9].baselineResets, ['gasVolumeM3']);
});

test('rule 9: an implausible rise within the series restarts it', () => {
  const readings = [gas({ gasVolumeM3: 3177.49 }, NOW - 7 * 30 * MINUTE)];
  const values = [1.1, 1.2, 100, 100.1, 100.2, 100.3, 100.4];
  values.forEach((v, i) => readings.push(gas({ gasVolumeM3: v }, NOW - (6 - i) * 30 * MINUTE)));
  const { results } = run(readings);
  assert.deepEqual(results[6].baselineResets, []);
  assert.deepEqual(results[7].baselineResets, []);
  assert.equal(results[7].state.series.gasVolumeM3.length, 5);
});

test('rule 9: re-sends with no newer timestamp do not count towards the series', () => {
  const readings = [gas({ gasVolumeM3: 3177.49 }, NOW - 60 * MINUTE)];
  for (let i = 0; i < 10; i++) readings.push(gas({ gasVolumeM3: 1 }, NOW));
  const { results, state } = run(readings);
  assert.ok(results.slice(1).every((r) => rulesOf(r)[0] === 'gasVolumeM3:7'));
  assert.equal(state.series.gasVolumeM3.length, 1);
});

test('rule 9: a consistent run above the rise limit (rule 8) becomes a new baseline once it rises', () => {
  // A replacement meter reading higher than the old one.
  const readings = [gas({ gasVolumeM3: 100 }, NOW - 7 * 30 * MINUTE)];
  for (let i = 1; i <= 6; i++) readings.push(gas({ gasVolumeM3: 5000 + i * 0.1 }, NOW - (7 - i) * 30 * MINUTE));
  const { results, state } = run(readings);
  for (let i = 1; i <= 5; i++) assert.deepEqual(rulesOf(results[i]), ['gasVolumeM3:8'], `reading ${i}`);
  assert.deepEqual(results[6].baselineResets, ['gasVolumeM3']);
  assert.equal(state.lastGood.gasVolumeM3.value, 5000.6);
});

test('rule 9: a stuck high value (rule 8) never becomes a baseline', () => {
  const readings = [gas({ gasVolumeM3: 100 }, NOW - 20 * 30 * MINUTE)];
  for (let i = 1; i <= 20; i++) readings.push(gas({ gasVolumeM3: 5000 }, NOW - (20 - i) * 30 * MINUTE));
  const { results, state } = run(readings);
  assert.ok(results.slice(1).every((r) => rulesOf(r)[0] === 'gasVolumeM3:8'));
  assert.equal(state.lastGood.gasVolumeM3.value, 100);
  assert.equal(state.series.gasVolumeM3.length, 6);

  // One rise at the end of the window is enough.
  const next = validate(gas({ gasVolumeM3: 5000.1 }, NOW + 30 * MINUTE), state);
  assert.deepEqual(next.baselineResets, ['gasVolumeM3']);
});

test('rule 9: a rule 7 run needs no rise', () => {
  const readings = [gas({ gasVolumeM3: 3177.49 }, NOW - 7 * 30 * MINUTE)];
  for (let i = 1; i <= 6; i++) readings.push(gas({ gasVolumeM3: 1 }, NOW - (7 - i) * 30 * MINUTE));
  assert.deepEqual(run(readings).results[6].baselineResets, ['gasVolumeM3']);
});

test('rule 9: an accepted reading clears a partial series', () => {
  const { state } = run([
    elec({ importKwh: 100 }, NOW - 3 * MINUTE),
    elec({ importKwh: 1 }, NOW - 2 * MINUTE),
    elec({ importKwh: 100.01 }, NOW - MINUTE),
  ]);
  assert.equal(state.series.importKwh, undefined);
});

test('fresh is true only when the payload timestamp is newer', () => {
  const { results } = run([
    elec({ powerKw: 1 }, NOW - MINUTE),
    elec({ powerKw: 1 }, NOW - MINUTE),
    elec({ powerKw: 1 }, NOW - 2 * MINUTE),
    elec({ powerKw: 1 }, NOW),
  ]);
  assert.deepEqual(results.map((r) => r.fresh), [true, false, false, true]);
});

test('state survives a JSON round trip, as in a device store', () => {
  const first = validate(elec({ importKwh: 100 }, NOW - MINUTE));
  const restored = JSON.parse(JSON.stringify(first.state));
  assert.deepEqual(rulesOf(validate(elec({ importKwh: 99 }), restored)), ['importKwh:7']);
});

test('validateState accepts the example and skips bad link fields', () => {
  const { reading } = parsePayload('STATE', JSON.stringify(STATE));
  assert.deepEqual(validateState(reading), { ok: true, accepted: { hanStatus: 'joined', rssi: -32, lqi: 255 }, rejections: [] });

  const bad = clone(STATE);
  bad.han = { status: '', rssi: null };
  const result = validateState(parsePayload('STATE', JSON.stringify(bad)).reading);
  assert.deepEqual(result.accepted, {});
  assert.deepEqual(result.rejections.map((r) => r.field), ['hanStatus', 'rssi', 'lqi']);
});
