'use strict';

// Example payloads in the shape of the Phase 0 partial capture (a Wi-Fi display
// on firmware v2.0.2), with made-up values and identifiers.

const STATE = {
  timestamp: '2026-10-25T16:08:22Z',
  software: 'v2.0.2',
  hardware: 'GLOW-IHD-02-1v4-SMETS2',
  wifistamac: '1234567890AB',
  smetsversion: 'SMETS2',
  eui: '12:34:56:78:91:23:45:67',
  zigbee: '1.2.5',
  han: { rssi: -32, status: 'joined', lqi: 255 },
};

const ELECTRICITY = {
  electricitymeter: {
    timestamp: '2026-10-25T16:08:12Z',
    energy: {
      export: { cumulative: 2004.682, units: 'kWh' },
      import: {
        cumulative: 10326.628,
        day: 12.767,
        week: 140.274,
        month: 491.434,
        units: 'kWh',
        mpan: '1234567890123',
        supplier: 'ABC ENERGY',
        price: { unitrate: 0.25630, standingcharge: 0.60700 },
      },
    },
    power: { value: -3.873, units: 'kW' },
  },
};

// No export or power object; the volume counters repeat the kWh counters and are
// labelled kWh.
const GAS = {
  gasmeter: {
    timestamp: '2026-10-25T16:07:59Z',
    energy: {
      import: {
        cumulative: 35706.086,
        day: 0.000,
        week: 262.460,
        month: 848.356,
        units: 'kWh',
        cumulativevol: 3182.181,
        cumulativevolunits: 'm3',
        dayvol: 0.000,
        weekvol: 262.460,
        monthvol: 848.356,
        dayweekmonthvolunits: 'kWh',
        mprn: 'not available',
        supplier: '---',
        price: { unitrate: 0.07920, standingcharge: 0.28840 },
      },
    },
  },
};

const clone = (value) => JSON.parse(JSON.stringify(value));

module.exports = { STATE, ELECTRICITY, GAS, clone };
