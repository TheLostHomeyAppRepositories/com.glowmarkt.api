'use strict';

// Pure validation of parsed Glow readings (see parse.js). Each field is checked
// separately and never throws: a bad field is skipped and reported, and only a
// bad timestamp discards the whole message. Cumulative totals must only rise,
// since Homey Energy depends on that.
//
// State is a plain JSON-serialisable object, so a device can keep it in its
// store and pass it back in with the next reading:
//   { lastTimestamp, lastGood: { field: { value, ts } }, series: { field: [{ value, ts, rule }] } }

const EARLIEST_TIMESTAMP = Date.UTC(2020, 0, 1);
const MAX_FUTURE_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

const POWER_NO_READING = -8388.608;
const CUMULATIVE_NO_READING = [281474976710655, 281474976710.655];

// Assumed calorific conversion for "the same proportions" in gas kWh, roughly
// 39.5 MJ/m³ × 1.02264 ÷ 3.6.
const GAS_KWH_PER_M3 = 11.2;

const RISE_LIMITS = {
  electricity: { perHour: 30, slack: 0.1, resetAfter: 30 },
  gasVolume: { perHour: 10, slack: 0.05, resetAfter: 6 },
  gasEnergy: { perHour: 10 * GAS_KWH_PER_M3, slack: 0.05 * GAS_KWH_PER_M3, resetAfter: 6 },
};

const FIELD_RULES = {
  powerKw: { noReading: [POWER_NO_READING], min: -30, max: 30 },
  importKwh: { noReading: CUMULATIVE_NO_READING, rejectZero: true, cumulative: RISE_LIMITS.electricity },
  exportKwh: { noReading: CUMULATIVE_NO_READING, cumulative: RISE_LIMITS.electricity },
  gasVolumeM3: { noReading: CUMULATIVE_NO_READING, rejectZero: true, cumulative: RISE_LIMITS.gasVolume },
  gasEnergyKwh: { noReading: CUMULATIVE_NO_READING, rejectZero: true, cumulative: RISE_LIMITS.gasEnergy },
  // Unit rates can go negative on tariffs such as Octopus Agile.
  unitRate: { rejectZero: true, min: -1, max: 5 },
  standingCharge: { rejectZero: true, min: 0, max: 5 },
};

const REASONS = {
  1: 'invalid_payload',
  2: 'bad_timestamp',
  3: 'not_a_number',
  4: 'no_reading_value',
  5: 'zero',
  6: 'out_of_range',
  7: 'decreased',
  8: 'implausible_rise',
};

function emptyState() {
  return { lastTimestamp: null, lastGood: {}, series: {} };
}

/**
 * Rule 2. Returns the timestamp in ms, or null if it's missing, unparseable,
 * before 2020 or more than a day ahead of `now`.
 */
function checkTimestamp(timestamp, now) {
  if (typeof timestamp !== 'string') return null;
  const ms = Date.parse(timestamp);
  if (!Number.isFinite(ms) || ms < EARLIEST_TIMESTAMP || ms > now + MAX_FUTURE_MS) return null;
  return ms;
}

function maxRise(limits, fromTs, toTs) {
  const hours = Math.max(0, toTs - fromTs) / HOUR_MS;
  return limits.perHour * hours + limits.slack;
}

/**
 * Validates a meter reading (electricitymeter or gasmeter) against the
 * device's previous state.
 *
 * Returns { ok, timestamp, fresh, accepted, rejections, baselineResets, state }.
 * `ok` is false only when the whole message is rejected (rule 2); `state` is
 * then unchanged. `fresh` is true when the payload timestamp is newer than the
 * last one seen.
 */
function validateReading(reading, previousState, { now = Date.now() } = {}) {
  const prev = previousState || emptyState();
  const ts = checkTimestamp(reading.timestamp, now);
  if (ts === null) {
    return {
      ok: false,
      rejections: [{ field: null, rule: 2, reason: REASONS[2], value: reading.timestamp }],
      state: prev,
    };
  }

  const state = {
    lastTimestamp: prev.lastTimestamp === null ? ts : Math.max(prev.lastTimestamp, ts),
    lastGood: { ...prev.lastGood },
    series: { ...prev.series },
  };
  const accepted = {};
  const rejections = [];
  const baselineResets = [];

  for (const [field, value] of Object.entries(reading.fields || {})) {
    const rules = FIELD_RULES[field];
    if (!rules) continue;
    const rule = checkField(field, value, ts, rules, state, baselineResets);
    if (rule) {
      rejections.push({ field, rule, reason: REASONS[rule], value });
    } else {
      accepted[field] = value;
    }
  }

  return {
    ok: true,
    timestamp: ts,
    fresh: prev.lastTimestamp === null || ts > prev.lastTimestamp,
    accepted,
    rejections,
    baselineResets,
    state,
  };
}

/**
 * Applies rules 3–9 to one field, updating `state` for accepted values.
 * Returns the number of the rule that rejected the field, or 0 if accepted.
 */
function checkField(field, value, ts, rules, state, baselineResets) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 3;
  if (rules.noReading && rules.noReading.includes(value)) return 4;
  if (rules.rejectZero && value === 0) return 5;
  if (rules.min !== undefined && (value < rules.min || value > rules.max)) return 6;

  const limits = rules.cumulative;
  const last = state.lastGood[field];
  if (limits && last) {
    let rule = 0;
    if (value < last.value) rule = 7;
    else if (value - last.value > maxRise(limits, last.ts, ts)) rule = 8;
    if (rule) {
      if (!extendSeries(field, value, ts, rule, limits, state)) return rule;
      baselineResets.push(field);
    }
  }

  state.lastGood[field] = { value, ts };
  delete state.series[field];
  return 0;
}

/**
 * Rule 9. Records a reading that rule 7 or 8 rejected. Readings that keep
 * rising plausibly from the previous rejected one extend the series; anything
 * else starts a new one. Re-sends with no newer timestamp don't count. Returns
 * true once the latest `resetAfter` readings can become the new baseline: a
 * series with any rule 8 rejection must also include at least one rise, so a
 * stuck high value never becomes a baseline.
 */
function extendSeries(field, value, ts, rule, limits, state) {
  const series = state.series[field] || [];
  const tail = series[series.length - 1];
  if (tail && ts <= tail.ts) return false;

  const consistent = tail && value >= tail.value && value - tail.value <= maxRise(limits, tail.ts, ts);
  const next = (consistent ? [...series, { value, ts, rule }] : [{ value, ts, rule }]).slice(-limits.resetAfter);
  state.series[field] = next;
  if (next.length < limits.resetAfter) return false;

  const needsRise = next.some((entry) => entry.rule === 8);
  return !needsRise || next.some((entry, i) => i > 0 && entry.value > next[i - 1].value);
}

/**
 * Validates a STATE reading. Only the display-link fields are checked; the
 * timestamp isn't, since STATE carries no meter values.
 */
function validateState(reading) {
  const accepted = {};
  const rejections = [];
  const { status, rssi, lqi } = reading.han || {};

  if (typeof status === 'string' && status) accepted.hanStatus = status;
  else rejections.push({ field: 'hanStatus', rule: 3, reason: REASONS[3], value: status });

  for (const [field, value] of [['rssi', rssi], ['lqi', lqi]]) {
    if (typeof value === 'number' && Number.isFinite(value)) accepted[field] = value;
    else rejections.push({ field, rule: 3, reason: REASONS[3], value });
  }

  return { ok: true, accepted, rejections };
}

module.exports = {
  REASONS,
  FIELD_RULES,
  GAS_KWH_PER_M3,
  emptyState,
  checkTimestamp,
  validateReading,
  validateState,
};
