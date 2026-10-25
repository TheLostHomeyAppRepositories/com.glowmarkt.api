'use strict';

const { EventEmitter } = require('events');

const { parseTopic, parsePayload, normalisePrefix } = require('./parse');
const { emptyState, validateReading, validateState } = require('./validate');
const { mask, maskPayload } = require('./mask');

const DEBUG_LOG_SIZE = 50;
const MAX_LOGGED_PAYLOAD = 2000;

/**
 * Keeps track of every Glow unit seen since the MQTT layer started: device
 * info, HAN link status, per-topic message times and counts, rejection counts,
 * and a debug log of the latest messages. No Homey dependencies.
 *
 * Validation here runs on in-memory state per unit, for the status panel and
 * pairing. Devices validate again against their own stored last good values.
 *
 * Events:
 *   'state'   ({ unitId, reading, accepted })                  each valid STATE message
 *   'reading' ({ unitId, kind, reading, receivedAt })          each parsed meter message
 *   'unit'    (unitId)                                         first message from a new unit
 */
class UnitRegistry extends EventEmitter {

  constructor({ prefix = 'glow', now = Date.now } = {}) {
    super();
    this.now = now;
    this.setPrefix(prefix);
    this.clear();
  }

  setPrefix(prefix) {
    this.prefix = normalisePrefix(prefix) || 'glow';
  }

  clear() {
    this.units = new Map();
    this.debugLog = [];
    this.ignored = 0;
  }

  /**
   * Handles one MQTT message. Never throws on bad input.
   */
  handleMessage(topic, payload) {
    const receivedAt = this.now();
    const text = Buffer.isBuffer(payload) ? payload.toString('utf8') : String(payload ?? '');
    const route = parseTopic(topic, this.prefix);
    if (!route) {
      this.ignored++;
      this.log(receivedAt, topic, text, ['unrecognised topic']);
      return null;
    }

    const unit = this.getOrCreateUnit(route.unitId, receivedAt);
    const topicStats = unit.topics[route.kind];
    topicStats.count++;
    topicStats.lastAt = receivedAt;

    const parsed = parsePayload(route.kind, text);
    if (!parsed.ok) {
      this.countRejection(unit, route.kind, parsed.reason);
      this.log(receivedAt, topic, text, [`rule ${parsed.rule}: ${parsed.reason}`]);
      return route;
    }

    if (route.kind === 'STATE') this.handleState(unit, parsed.reading, receivedAt, topic, text);
    else this.handleMeter(unit, route.kind, parsed.reading, receivedAt, topic, text);
    return route;
  }

  handleState(unit, reading, receivedAt, topic, text) {
    const result = validateState(reading);
    const previousStatus = unit.han.status;
    unit.info = {
      mac: reading.mac,
      hardware: reading.hardware,
      software: reading.software,
      smetsVersion: reading.smetsVersion,
      zigbee: reading.zigbee,
      eui: mask(reading.eui),
    };
    unit.han = {
      status: result.accepted.hanStatus ?? unit.han.status,
      rssi: result.accepted.rssi ?? unit.han.rssi,
      lqi: result.accepted.lqi ?? unit.han.lqi,
    };
    if (previousStatus !== unit.han.status) unit.han.changedAt = receivedAt;

    result.rejections.forEach((r) => this.countRejection(unit, 'STATE', r.reason));
    this.log(receivedAt, topic, text, result.rejections.map(describe));
    this.emit('state', { unitId: unit.unitId, reading, accepted: result.accepted });
  }

  handleMeter(unit, kind, reading, receivedAt, topic, text) {
    const meter = unit.meters[kind];
    const result = validateReading(reading, meter.state, { now: receivedAt });
    meter.state = result.state;
    result.rejections.forEach((r) => this.countRejection(unit, kind, r.reason));

    if (result.ok) {
      Object.assign(meter.latest, result.accepted);
      meter.timestamp = result.timestamp;
      meter.meta = {
        mpan: mask(reading.meta.mpan),
        mprn: mask(reading.meta.mprn),
        supplier: mask(reading.meta.supplier),
      };
      if (kind === 'gasmeter') meter.hasVolume = reading.hasVolume;
    }

    this.log(receivedAt, topic, text, result.rejections.map(describe));
    this.emit('reading', {
      unitId: unit.unitId, kind, reading, receivedAt,
    });
  }

  getOrCreateUnit(unitId, receivedAt) {
    let unit = this.units.get(unitId);
    if (unit) return unit;

    const topic = () => ({ count: 0, lastAt: null });
    const meter = () => ({
      state: emptyState(), latest: {}, timestamp: null, meta: {}, hasVolume: null,
    });
    unit = {
      unitId,
      firstSeen: receivedAt,
      info: {},
      han: {},
      topics: { STATE: topic(), electricitymeter: topic(), gasmeter: topic() },
      meters: { electricitymeter: meter(), gasmeter: meter() },
      rejections: { STATE: {}, electricitymeter: {}, gasmeter: {} },
    };
    this.units.set(unitId, unit);
    this.emit('unit', unitId);
    return unit;
  }

  countRejection(unit, kind, reason) {
    unit.rejections[kind][reason] = (unit.rejections[kind][reason] || 0) + 1;
  }

  log(time, topic, payload, rejections) {
    const masked = maskPayload(payload);
    this.debugLog.unshift({
      time,
      topic,
      payload: masked.length > MAX_LOGGED_PAYLOAD ? `${masked.slice(0, MAX_LOGGED_PAYLOAD)}…` : masked,
      rejections,
    });
    if (this.debugLog.length > DEBUG_LOG_SIZE) this.debugLog.length = DEBUG_LOG_SIZE;
  }

  /**
   * Units that have sent the given meter kind, for pairing.
   */
  unitsWithKind(kind) {
    return [...this.units.values()].filter((unit) => unit.topics[kind] && unit.topics[kind].count > 0);
  }

  getUnit(unitId) {
    return this.units.get(unitId) || null;
  }

  /**
   * A JSON-safe summary of every unit, without validation state.
   */
  getUnits() {
    return [...this.units.values()].map((unit) => ({
      unitId: unit.unitId,
      firstSeen: unit.firstSeen,
      info: unit.info,
      han: unit.han,
      topics: unit.topics,
      rejections: unit.rejections,
      meters: Object.fromEntries(Object.entries(unit.meters).map(([kind, meter]) => [kind, {
        latest: meter.latest,
        timestamp: meter.timestamp,
        meta: meter.meta,
        hasVolume: meter.hasVolume,
      }])),
    }));
  }

  getDebugLog() {
    return this.debugLog.slice();
  }

}

function describe(rejection) {
  return `rule ${rejection.rule}: ${rejection.reason}${rejection.field ? ` (${rejection.field})` : ''}`;
}

module.exports = UnitRegistry;
