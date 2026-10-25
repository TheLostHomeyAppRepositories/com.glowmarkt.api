'use strict';

// Pure parsing of the Glow display's local MQTT feed. No Homey dependencies.
// Topics: <prefix>/<unitId>/STATE, <prefix>/<unitId>/SENSOR/electricitymeter,
// <prefix>/<unitId>/SENSOR/gasmeter. Payload `units` strings are ignored: field
// meanings are fixed here.

const METER_KINDS = ['electricitymeter', 'gasmeter'];
const KINDS = ['STATE', ...METER_KINDS];

function normalisePrefix(prefix) {
  return String(prefix ?? '').trim().replace(/[#\s]/g, '').replace(/\/+$/, '');
}

function normaliseUnitId(unitId) {
  return String(unitId ?? '').toUpperCase().replace(/[:\s]/g, '');
}

/**
 * Splits a topic into unit ID and kind. Returns null for any topic that isn't
 * one of the three Glow topics under the given prefix.
 */
function parseTopic(topic, prefix) {
  const base = normalisePrefix(prefix);
  if (typeof topic !== 'string' || !base || !topic.startsWith(`${base}/`)) return null;
  const parts = topic.slice(base.length + 1).split('/');

  let kind = null;
  if (parts.length === 2 && parts[1] === 'STATE') kind = 'STATE';
  if (parts.length === 3 && parts[1] === 'SENSOR' && METER_KINDS.includes(parts[2])) kind = parts[2];
  if (!kind) return null;

  const unitId = normaliseUnitId(parts[0]);
  if (!unitId) return null;
  return { unitId, kind };
}

function reject(rule, reason, detail) {
  return { ok: false, rule, reason, detail };
}

/**
 * Parses a payload for a kind into a normalised reading, or a rejection
 * (rule 1). Field values are copied as found; validate.js decides whether each
 * is usable.
 */
function parsePayload(kind, payload) {
  let json;
  try {
    json = JSON.parse(Buffer.isBuffer(payload) ? payload.toString('utf8') : String(payload));
  } catch (error) {
    return reject(1, 'invalid_json', error.message);
  }

  if (kind === 'STATE') {
    if (!isObject(json)) return reject(1, 'missing_object', 'STATE payload is not an object');
    const han = isObject(json.han) ? json.han : {};
    return {
      ok: true,
      reading: {
        kind,
        timestamp: json.timestamp,
        software: json.software,
        hardware: json.hardware,
        // Ethernet CADs send ethmac; Wi-Fi displays send wifistamac.
        mac: json.ethmac ?? json.wifistamac,
        smetsVersion: json.smetsversion,
        eui: json.eui,
        zigbee: json.zigbee,
        han: { status: han.status, rssi: han.rssi, lqi: han.lqi },
      },
    };
  }

  const meter = isObject(json) ? json[kind] : undefined;
  if (!isObject(meter)) return reject(1, 'missing_object', `no "${kind}" object`);

  const energy = isObject(meter.energy) ? meter.energy : {};
  const imp = isObject(energy.import) ? energy.import : {};
  const exp = isObject(energy.export) ? energy.export : {};
  const price = isObject(imp.price) ? imp.price : {};

  if (kind === 'electricitymeter') {
    return {
      ok: true,
      reading: {
        kind,
        timestamp: meter.timestamp,
        fields: {
          powerKw: isObject(meter.power) ? meter.power.value : undefined,
          importKwh: imp.cumulative,
          exportKwh: exp.cumulative,
          unitRate: price.unitrate,
          standingCharge: price.standingcharge,
        },
        meta: { mpan: imp.mpan, supplier: imp.supplier },
      },
    };
  }

  return {
    ok: true,
    reading: {
      kind,
      timestamp: meter.timestamp,
      hasVolume: 'cumulativevol' in imp,
      fields: {
        gasVolumeM3: imp.cumulativevol,
        gasEnergyKwh: imp.cumulative,
        unitRate: price.unitrate,
        standingCharge: price.standingcharge,
      },
      meta: { mprn: imp.mprn, supplier: imp.supplier },
    },
  };
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

module.exports = {
  KINDS,
  normalisePrefix,
  normaliseUnitId,
  parseTopic,
  parsePayload,
};
