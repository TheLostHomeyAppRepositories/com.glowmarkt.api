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
const HOUR = 60 * MINUTE;
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

test('rule 8: electricity allows at least 1 minute, even for a re-send', () => {
  // 1 minute allows 30 × 1/60 + 0.1 = 0.6 kWh.
  for (const ms of [NOW, NOW + 10 * 1000]) {
    const start = elec({ importKwh: 100 });
    assert.deepEqual(run([start, elec({ importKwh: 100.59 }, ms)]).results[1].rejections, []);
    assert.deepEqual(rulesOf(run([start, elec({ importKwh: 100.7 }, ms)]).results[1]), ['importKwh:8']);
  }
});

test('rule 8: gas rises beyond 10 m³/h × hours + 0.05 m³, and the kWh equivalent, are skipped', () => {
  // 1 hour allows 10.05 m³, or 10.05 × 11.2 = 112.56 kWh.
  const start = gas({ gasVolumeM3: 3177.49, gasEnergyKwh: 35570 }, NOW - HOUR);
  const ok = run([start, gas({ gasVolumeM3: 3177.49 + 10.04, gasEnergyKwh: 35570 + 10.04 * GAS_KWH_PER_M3 })]).results[1];
  assert.deepEqual(ok.rejections, []);
  const bad = run([start, gas({ gasVolumeM3: 3177.49 + 10.1, gasEnergyKwh: 35570 + 10.1 * GAS_KWH_PER_M3 })]).results[1];
  assert.deepEqual(rulesOf(bad), ['gasVolumeM3:8', 'gasEnergyKwh:8']);
});

test('rule 8: gas allows at least 35 minutes, so a half-hourly step after re-stamped readings is accepted', () => {
  // As in the capture: flat readings re-stamped every ~30 s, then the 0.309 m³
  // step 33 s after the last of them.
  const readings = [];
  for (let s = 0; s <= 30 * 60; s += 30) readings.push(gas({ gasVolumeM3: 3182.181, gasEnergyKwh: 35706.086 }, NOW - HOUR + s * 1000));
  const lastFlat = NOW - HOUR + 30 * 60 * 1000;
  readings.push(gas({ gasVolumeM3: 3182.49, gasEnergyKwh: 35709.559 }, lastFlat + 33 * 1000));
  const { results, state } = run(readings);
  assert.deepEqual(results.at(-1).rejections, []);
  assert.equal(state.lastGood.gasVolumeM3.value, 3182.49);

  // 35 minutes allows 10 × 35/60 + 0.05 = 5.883 m³ per step.
  const start = gas({ gasVolumeM3: 100 });
  assert.deepEqual(run([start, gas({ gasVolumeM3: 105.88 }, NOW + 1000)]).results[1].rejections, []);
  assert.deepEqual(rulesOf(run([start, gas({ gasVolumeM3: 105.9 }, NOW + 1000)]).results[1]), ['gasVolumeM3:8']);
});

test('rules 7–9 do not apply to the first reading', () => {
  const result = validate(elec({ importKwh: 999999, exportKwh: 0.001 }));
  assert.deepEqual(result.rejections, []);
});

// Gas readings every 30 s, as the display re-stamps them, from `startMs`.
function gasRun(startMs, values, field = 'gasVolumeM3') {
  return values.map((value, i) => gas({ [field]: value }, startMs + i * 30 * 1000));
}

test('rule 9: lower gas readings become a new baseline after 3 hours of fresh readings', () => {
  const start = NOW - 4 * HOUR;
  const steps = 3 * 60 * 2; // 30 s readings over 3 hours
  const readings = [gas({ gasVolumeM3: 3177.49 }, start - 30 * 1000), ...gasRun(start, Array(steps + 1).fill(1.5))];
  const { results, state } = run(readings);
  assert.deepEqual(rulesOf(results[1]), ['gasVolumeM3:7']);
  assert.deepEqual(rulesOf(results[steps]), ['gasVolumeM3:7'], 'still rejected 30 s before 3 hours');
  assert.deepEqual(results[steps + 1].rejections, []);
  assert.deepEqual(results[steps + 1].baselineResets, ['gasVolumeM3']);
  assert.equal(state.lastGood.gasVolumeM3.value, 1.5);
  assert.equal(state.series.gasVolumeM3, undefined);

  // The new baseline carries on as normal.
  assert.deepEqual(validate(gas({ gasVolumeM3: 1.6 }, start + 4 * HOUR), state).rejections, []);
});

test('rule 9: electricity needs 5 minutes of fresh readings', () => {
  const start = NOW - HOUR;
  const readings = [elec({ importKwh: 6613 }, start - 10 * 1000)];
  for (let i = 0; i <= 30; i++) readings.push(elec({ importKwh: 10 + i * 0.01 }, start + i * 10 * 1000));
  const { results } = run(readings);
  assert.deepEqual(rulesOf(results[30]), ['importKwh:7'], 'still rejected at 4 min 50 s');
  assert.deepEqual(results[31].baselineResets, ['importKwh']);
});

test('rule 9: re-sends do not count towards the run, however many arrive', () => {
  const start = NOW - 5 * HOUR;
  const readings = [gas({ gasVolumeM3: 3177.49 }, start)];
  // 500 messages with the same payload timestamp, then one older.
  for (let i = 0; i < 500; i++) readings.push(gas({ gasVolumeM3: 1 }, start + MINUTE));
  readings.push(gas({ gasVolumeM3: 1 }, start + 30 * 1000));
  const { results, state } = run(readings);
  assert.ok(results.slice(1).every((r) => rulesOf(r)[0] === 'gasVolumeM3:7'));
  assert.equal(state.series.gasVolumeM3.startTs, start + MINUTE);
  assert.equal(state.series.gasVolumeM3.lastTs, start + MINUTE);
});

test('rule 9: an inconsistent reading restarts the run', () => {
  const start = NOW - 6 * HOUR;
  const readings = [
    gas({ gasVolumeM3: 3177.49 }, start - 30 * 1000),
    ...gasRun(start, Array(2 * 60 * 2).fill(1.3)), // 2 hours at 1.3
    ...gasRun(start + 2 * HOUR, Array(3 * 60 * 2 + 1).fill(0.5)), // drops: restarts, then 3 hours at 0.5
  ];
  const { results } = run(readings);
  const resets = results.map((r, i) => (r.baselineResets.length ? i : null)).filter((i) => i !== null);
  assert.deepEqual(resets, [readings.length - 1]);
  assert.equal(results.at(-1).state.lastGood.gasVolumeM3.value, 0.5);
});

test('rule 9: an implausible rise within the run restarts it', () => {
  const start = NOW - 5 * HOUR;
  const readings = [
    gas({ gasVolumeM3: 3177.49 }, start - 30 * 1000),
    ...gasRun(start, Array(2 * 60 * 2).fill(1.2)),
    // 1.2 → 100 in 30 s is beyond even the 35-minute allowance of 5.883 m³.
    ...gasRun(start + 2 * HOUR, Array(2 * 60 * 2).fill(100)),
  ];
  const { results, state } = run(readings);
  assert.ok(results.every((r) => r.baselineResets.length === 0));
  assert.equal(state.series.gasVolumeM3.startTs, start + 2 * HOUR);
});

test('rule 9: a consistent run above the rise limit (rule 8) becomes a new baseline once it has risen', () => {
  // A replacement meter reading higher than the old one, creeping up.
  const start = NOW - 4 * HOUR;
  const values = Array.from({ length: 3 * 60 * 2 + 1 }, (_, i) => 5000 + Math.floor(i / 60) * 0.1);
  const readings = [gas({ gasVolumeM3: 100 }, start - 30 * 1000), ...gasRun(start, values)];
  const { results, state } = run(readings);
  assert.deepEqual(rulesOf(results[1]), ['gasVolumeM3:8']);
  assert.deepEqual(results.at(-1).baselineResets, ['gasVolumeM3']);
  assert.equal(state.lastGood.gasVolumeM3.value, values.at(-1));
});

test('rule 9: a stuck high value (rule 8) never becomes a baseline', () => {
  const start = NOW - 7 * HOUR;
  const readings = [gas({ gasVolumeM3: 100 }, start - 30 * 1000), ...gasRun(start, Array(6 * 60 * 2).fill(5000))];
  const { results, state } = run(readings);
  assert.ok(results.slice(1).every((r) => rulesOf(r)[0] === 'gasVolumeM3:8'));
  assert.equal(state.lastGood.gasVolumeM3.value, 100);
  assert.deepEqual({ rule8: state.series.gasVolumeM3.rule8, rose: state.series.gasVolumeM3.rose }, { rule8: true, rose: false });

  // One rise is enough once the run has lasted 3 hours.
  const next = validate(gas({ gasVolumeM3: 5000.1 }, start + 6 * HOUR), state);
  assert.deepEqual(next.baselineResets, ['gasVolumeM3']);
});

test('rule 9: a rule 7 run needs no rise', () => {
  const start = NOW - 4 * HOUR;
  const readings = [gas({ gasVolumeM3: 3177.49 }, start - 30 * 1000), ...gasRun(start, Array(3 * 60 * 2 + 1).fill(1))];
  assert.deepEqual(run(readings).results.at(-1).baselineResets, ['gasVolumeM3']);
});

test('rule 9: an accepted reading clears a partial run', () => {
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

test('validateState skips RSSI outside −120 to 0 dBm and LQI outside 0–255 (rule 6)', () => {
  const state = (han) => validateState({ han: { status: 'joined', ...han } });
  // The capture's one impossible reading.
  assert.deepEqual(state({ rssi: 73, lqi: 255 }).rejections, [{ field: 'rssi', rule: 6, reason: 'out_of_range', value: 73 }]);
  assert.deepEqual(state({ rssi: -121, lqi: 256 }).rejections.map((r) => `${r.field}:${r.rule}`), ['rssi:6', 'lqi:6']);
  assert.deepEqual(state({ rssi: -1, lqi: -1 }).rejections.map((r) => `${r.field}:${r.rule}`), ['lqi:6']);
  assert.deepEqual(state({ rssi: -120, lqi: 0 }).accepted, { hanStatus: 'joined', rssi: -120, lqi: 0 });
  assert.deepEqual(state({ rssi: 0, lqi: 255 }).accepted, { hanStatus: 'joined', rssi: 0, lqi: 255 });
});
