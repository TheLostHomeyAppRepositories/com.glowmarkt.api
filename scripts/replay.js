'use strict';

// Publishes Glow display messages to an MQTT broker, for testing the local
// devices on a development Homey.
//
// Replay the capture (shifted so it starts now, at 60× speed):
//   node scripts/replay.js --host 192.168.1.100 --speed 60
//
// Publish synthetic cases, 10 s apart (see --list):
//   node scripts/replay.js --host 192.168.1.100 --case all
//   node scripts/replay.js --host 192.168.1.100 --case tariff
//
// Options:
//   --host, --port (1883), --username, --password   the broker; the credentials can
//                                                    also come from MQTT_USERNAME and
//                                                    MQTT_PASSWORD, keeping them out of
//                                                    shell history
//   --prefix (glow)                                  topic prefix to publish under
//   --unit (REPLAY000001)                            unit ID to publish as, so the
//                                                    replay never mixes with a real display
//   --file (test/fixtures/glow-capture.jsonl.gz)     fixture to replay
//   --speed (60)                                     replay speed; 0 sends as fast as possible
//   --from, --to                                     only messages received in this window
//                                                    (ISO prefixes, e.g. 2026-10-26T05:00)
//   --case <name|all>                                synthetic cases instead of the fixture
//   --interval (10)                                  seconds between synthetic messages
//   --list                                           list the synthetic cases and exit
//
// Payload timestamps are moved to the present and compressed by the replay
// speed, so they keep pace with when the messages actually arrive.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const DEFAULT_FILE = path.join(__dirname, '..', 'test', 'fixtures', 'glow-capture.jsonl.gz');

// The last values in the capture, so synthetic cases follow on from a replay.
const BASELINE = {
  importKwh: 10340.273,
  exportKwh: 2012.246,
  powerKw: 0.28,
  unitRate: 0.2563,
  standingCharge: 0.607,
  gasVolumeM3: 3182.49,
  gasEnergyKwh: 35709.559,
  gasUnitRate: 0.0792,
  gasStandingCharge: 0.2884,
};

function stateMessage({ unitId, timestamp, han = {} }) {
  return {
    timestamp,
    software: 'v2.0.2',
    hardware: 'GLOW-IHD-02-1v4-SMETS2',
    wifistamac: unitId,
    smetsversion: 'SMETS2',
    eui: '00:00:00:00:00:00:00:01',
    zigbee: '1.2.5',
    han: {
      rssi: -32, status: 'joined', lqi: 255, ...han,
    },
  };
}

function electricityMessage({ timestamp, values = {} }) {
  const v = { ...BASELINE, ...values };
  return {
    electricitymeter: {
      timestamp,
      energy: {
        export: { cumulative: v.exportKwh, units: 'kWh' },
        import: {
          cumulative: v.importKwh,
          day: 1.234,
          week: 12.345,
          month: 123.456,
          units: 'kWh',
          mpan: '9900000000001',
          supplier: 'Supplier 1',
          price: { unitrate: v.unitRate, standingcharge: v.standingCharge },
        },
      },
      power: { value: v.powerKw, units: 'kW' },
    },
  };
}

function gasMessage({ timestamp, values = {} }) {
  const v = { ...BASELINE, ...values };
  const imp = {
    cumulative: v.gasEnergyKwh,
    day: 0,
    week: 0,
    month: 0,
    units: 'kWh',
    cumulativevol: v.gasVolumeM3,
    cumulativevolunits: 'm3',
    dayvol: 0,
    weekvol: 0,
    monthvol: 0,
    dayweekmonthvolunits: 'kWh',
    mprn: 'not available',
    supplier: '---',
    price: { unitrate: v.gasUnitRate, standingcharge: v.gasStandingCharge },
  };
  if (v.gasVolumeM3 === undefined) delete imp.cumulativevol;
  return { gasmeter: { timestamp, energy: { import: imp } } };
}

/**
 * Synthetic cases. Each step is [kind, build], where build(timestamp) returns
 * the payload (an object, or a string sent as-is). Every case starts with a
 * good round, so the device has a baseline. `expect` says what the app should
 * do, for the person testing.
 */
const CASES = {
  'invalid-json': {
    expect: 'Electricity: rule 1 invalid_json; no capability changes',
    steps: [['electricitymeter', () => '{"electricitymeter":']],
  },
  'missing-object': {
    expect: 'Gas: rule 1 missing_object; no capability changes',
    steps: [['gasmeter', (timestamp) => electricityMessage({ timestamp })]],
  },
  'epoch-1970': {
    expect: 'Electricity: rule 2 bad_timestamp; no capability changes',
    steps: [['electricitymeter', () => electricityMessage({
      timestamp: '1970-01-01T00:00:00Z',
      values: {
        importKwh: null, exportKwh: null, powerKw: null, unitRate: null, standingCharge: null,
      },
    })]],
  },
  nulls: {
    expect: 'Electricity: rule 3 not_a_number × 2 (unit rate, standing charge); tariff unchanged',
    steps: [['electricitymeter', (timestamp) => electricityMessage({ timestamp, values: { unitRate: null, standingCharge: null } })]],
  },
  'no-reading': {
    expect: 'Electricity: rule 4 no_reading_value × 2 (power, import); power and import unchanged',
    steps: [['electricitymeter', (timestamp) => electricityMessage({ timestamp, values: { powerKw: -8388.608, importKwh: 281474976710.655 } })]],
  },
  zero: {
    expect: 'Electricity and gas: rule 5 zero (import; gas volume and kWh); totals unchanged',
    steps: [
      ['electricitymeter', (timestamp) => electricityMessage({ timestamp, values: { importKwh: 0 } })],
      ['gasmeter', (timestamp) => gasMessage({ timestamp, values: { gasVolumeM3: 0, gasEnergyKwh: 0 } })],
    ],
  },
  'out-of-range': {
    expect: 'Electricity: rule 6 out_of_range × 2 (power 45 kW, unit rate £6.50); power and tariff unchanged',
    steps: [['electricitymeter', (timestamp) => electricityMessage({ timestamp, values: { powerKw: 45, unitRate: 6.5 } })]],
  },
  decrease: {
    expect: 'Electricity: rule 7 decreased (import 1 kWh lower); import unchanged',
    steps: [['electricitymeter', (timestamp) => electricityMessage({ timestamp, values: { importKwh: BASELINE.importKwh - 1 } })]],
  },
  'big-rise': {
    expect: 'Electricity: rule 8 implausible_rise (import +50 kWh in 10 s); import unchanged',
    steps: [['electricitymeter', (timestamp) => electricityMessage({ timestamp, values: { importKwh: BASELINE.importKwh + 50 } })]],
  },
  rssi: {
    expect: 'STATE: rule 6 out_of_range (RSSI +73); signal strength unchanged',
    steps: [['STATE', (timestamp, unitId) => stateMessage({ unitId, timestamp, han: { rssi: 73 } })]],
  },
  'han-blip': {
    expect: 'One 10 s "service discovery": Display link status changed does not fire; Display link stays joined',
    steps: [
      ['STATE', (timestamp, unitId) => stateMessage({ unitId, timestamp, han: { status: 'service discovery' } })],
      ['STATE', (timestamp, unitId) => stateMessage({ unitId, timestamp })],
    ],
  },
  'han-outage': {
    expect: '"service discovery" for 110 s: Display link status changed fires (joined → service discovery) about 60 s in, and again (→ joined) 60 s after it recovers',
    steps: [
      ...Array.from({ length: 11 }, () => ['STATE', (timestamp, unitId) => stateMessage({ unitId, timestamp, han: { status: 'service discovery' } })]),
      ...Array.from({ length: 8 }, () => ['STATE', (timestamp, unitId) => stateMessage({ unitId, timestamp })]),
    ],
  },
  'no-volume': {
    expect: 'Gas: no cumulativevol; meter_gas unchanged and the device warns it can\'t feed Homey Energy; the next good round clears it',
    steps: [['gasmeter', (timestamp) => gasMessage({ timestamp, values: { gasVolumeM3: undefined } })]],
  },
  tariff: {
    expect: 'Tariff changed fires on both devices (25.63 → 15.00 p/kWh, 7.92 → 6.50 p/kWh), then again 60 s later when the rates go back',
    steps: [
      ['electricitymeter', (timestamp) => electricityMessage({ timestamp, values: { unitRate: 0.15 } })],
      ['gasmeter', (timestamp) => gasMessage({ timestamp, values: { gasUnitRate: 0.065 } })],
      ...Array.from({ length: 5 }, () => ['electricitymeter', (timestamp) => electricityMessage({ timestamp, values: { unitRate: 0.15 } })]),
      ['electricitymeter', (timestamp) => electricityMessage({ timestamp })],
      ['gasmeter', (timestamp) => gasMessage({ timestamp })],
    ],
  },
};

const GOOD_ROUND = [
  ['STATE', (timestamp, unitId) => stateMessage({ unitId, timestamp })],
  ['electricitymeter', (timestamp) => electricityMessage({ timestamp })],
  ['gasmeter', (timestamp) => gasMessage({ timestamp })],
];

function topicFor(prefix, unitId, kind) {
  return kind === 'STATE' ? `${prefix}/${unitId}/STATE` : `${prefix}/${unitId}/SENSOR/${kind}`;
}

/**
 * The messages for a synthetic case: a good round, the case's steps, then a
 * good round, each `intervalMs` apart starting at `start`. Returns
 * [{ at, topic, payload }], `at` in ms from the start.
 */
function syntheticMessages(name, {
  unitId = 'REPLAY000001', prefix = 'glow', start = Date.now(), intervalMs = 10 * 1000,
} = {}) {
  const testCase = CASES[name];
  if (!testCase) throw new Error(`Unknown case ${name}; use --list`);
  const steps = [...GOOD_ROUND, ...testCase.steps, ...GOOD_ROUND];
  return steps.map(([kind, build], i) => {
    const at = i * intervalMs;
    const payload = build(new Date(start + at).toISOString().replace(/\.\d{3}Z$/, 'Z'), unitId);
    return { at, topic: topicFor(prefix, unitId, kind), payload: typeof payload === 'string' ? payload : JSON.stringify(payload) };
  });
}

/**
 * Reads a fixture (.jsonl or .jsonl.gz) and moves it to the present: topics get
 * the chosen prefix and unit ID, and arrival and payload times are compressed
 * by `speed` from `start` (speed 0: all at once). Returns
 * [{ at, topic, payload }], `at` in ms from the first message.
 */
function fixtureMessages(file, {
  unitId = 'REPLAY000001', prefix = 'glow', start = Date.now(), speed = 60, from, to,
} = {}) {
  const raw = fs.readFileSync(file);
  const text = file.endsWith('.gz') ? zlib.gunzipSync(raw).toString('utf8') : raw.toString('utf8');
  const lines = text.split('\n').filter(Boolean).map((line) => JSON.parse(line))
    .filter((m) => (!from || m.received >= from) && (!to || m.received < to));
  if (!lines.length) return [];

  const first = Date.parse(lines[0].received);
  const scale = (ms) => (speed ? (ms - first) / speed : 0);
  const moveTime = (iso) => {
    const ms = Date.parse(iso);
    return Number.isFinite(ms) ? new Date(start + scale(ms)).toISOString().replace(/\.\d{3}Z$/, 'Z') : iso;
  };

  return lines.map((m) => {
    const parts = m.topic.split('/');
    const kind = parts[parts.length - 1];
    let { payload } = m;
    try {
      const json = JSON.parse(payload);
      if (json.timestamp) json.timestamp = moveTime(json.timestamp);
      if (json.wifistamac) json.wifistamac = unitId;
      if (json.ethmac) json.ethmac = unitId;
      for (const meter of ['electricitymeter', 'gasmeter']) {
        if (json[meter] && json[meter].timestamp) json[meter].timestamp = moveTime(json[meter].timestamp);
      }
      payload = JSON.stringify(json);
    } catch (error) {
      // Not JSON: send as it was.
    }
    return { at: scale(Date.parse(m.received)), topic: topicFor(prefix, unitId, kind), payload };
  });
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, '');
    if (key === 'list') args.list = true;
    else args[key] = argv[++i];
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.list) {
    for (const [name, { expect }] of Object.entries(CASES)) console.log(`${name.padEnd(15)} ${expect}`);
    return;
  }
  if (!args.host) {
    console.error('Usage: node scripts/replay.js --host <broker> [--case <name|all>] [--speed 60]; see the comment at the top');
    process.exit(1);
  }

  const options = { unitId: args.unit || 'REPLAY000001', prefix: args.prefix || 'glow' };
  const speed = args.speed === undefined ? 60 : Number(args.speed);
  let messages;
  if (args.case) {
    const names = args.case === 'all' ? Object.keys(CASES) : [args.case];
    const intervalMs = Number(args.interval || 10) * 1000;
    messages = [];
    let offset = 0;
    for (const name of names) {
      const start = Date.now() + offset;
      const caseMessages = syntheticMessages(name, { ...options, start, intervalMs })
        .map((m) => ({ ...m, at: m.at + offset, label: name }));
      messages.push(...caseMessages);
      offset = caseMessages[caseMessages.length - 1].at + intervalMs;
    }
  } else {
    messages = fixtureMessages(args.file || DEFAULT_FILE, {
      ...options, speed, from: args.from, to: args.to,
    });
  }
  console.log(`Publishing ${messages.length} messages as unit ${options.unitId} to ${args.host}:${args.port || 1883}${args.case ? '' : ` at ${speed || 'full'}× speed`}`);

  const mqtt = require('mqtt');
  const client = await mqtt.connectAsync({
    host: args.host,
    port: Number(args.port || 1883),
    username: args.username || process.env.MQTT_USERNAME,
    password: args.password || process.env.MQTT_PASSWORD,
    reconnectPeriod: 0,
  });

  const started = Date.now();
  let lastLabel = null;
  for (const message of messages) {
    const wait = started + message.at - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    if (message.label && message.label !== lastLabel) {
      console.log(`\n${message.label}: ${CASES[message.label].expect}`);
      lastLabel = message.label;
    }
    await client.publishAsync(message.topic, message.payload);
  }
  await client.endAsync();
  console.log('\nDone.');
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    if (/not authori[sz]ed|bad user ?name or password/i.test(error.message)) {
      console.error('The broker wants a username and password: set MQTT_USERNAME and MQTT_PASSWORD, or pass --username and --password.');
    }
    process.exit(1);
  });
}

module.exports = {
  CASES, BASELINE, syntheticMessages, fixtureMessages,
};
