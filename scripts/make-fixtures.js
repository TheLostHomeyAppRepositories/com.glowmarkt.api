'use strict';

// Turns a raw Glow capture into a fixture file that's safe to commit.
//
//   node scripts/make-fixtures.js test/fixtures/raw/glow-capture.log [output.jsonl]
//
// The input is `mosquitto_sub -v -F '%I %t %p'` output: an ISO time, the topic
// and the payload on each line. The output defaults to test/fixtures/<input
// name>.jsonl, one { received, topic, payload } object per line, with the
// payload kept as the original string. MPAN, MPRN, EUI, supplier and unit ID
// (the display MAC) are replaced by stand-ins numbered in order of first
// appearance, so the same value always gets the same stand-in. Placeholders the
// display sends instead of a value, such as "not available" or "---", are kept.

const fs = require('fs');
const path = require('path');

const { isPlaceholder } = require('../lib/glow/mask');

const [input, outputArg] = process.argv.slice(2);
if (!input) {
  console.error('Usage: node scripts/make-fixtures.js <capture.log> [output.jsonl]');
  process.exit(1);
}
const output = outputArg || path.join(__dirname, '..', 'test', 'fixtures', `${path.basename(input, path.extname(input))}.jsonl`);

const standIns = {
  unit: { map: new Map(), make: (n) => n.toString(16).toUpperCase().padStart(12, '0') },
  mpan: { map: new Map(), make: (n) => `99${String(n).padStart(11, '0')}` },
  mprn: { map: new Map(), make: (n) => `88${String(n).padStart(8, '0')}` },
  eui: { map: new Map(), make: (n) => `00:00:00:00:00:00:00:${n.toString(16).toUpperCase().padStart(2, '0')}` },
  supplier: { map: new Map(), make: (n) => `Supplier ${n}` },
};

function standIn(kind, value) {
  const { map, make } = standIns[kind];
  if (!map.has(value)) map.set(value, make(map.size + 1));
  return map.get(value);
}

const KEY_KINDS = {
  mpan: 'mpan', mprn: 'mprn', eui: 'eui', supplier: 'supplier', ethmac: 'unit', wifistamac: 'unit',
};

function maskPayload(payload, unitIds) {
  let masked = payload.replace(/"(mpan|mprn|eui|supplier|ethmac|wifistamac)"\s*:\s*"([^"]*)"/g, (match, key, value) => {
    if (isPlaceholder(value)) return match;
    const kind = KEY_KINDS[key];
    const replacement = kind === 'unit' ? standIn('unit', value.toUpperCase()) : standIn(kind, value);
    return `"${key}":"${replacement}"`;
  });
  // Catch the unit ID anywhere else it appears.
  for (const [unitId, replacement] of unitIds) masked = masked.split(unitId).join(replacement);
  return masked;
}

// mosquitto's %I gives +0000-style offsets; make them ISO 8601 with a colon.
function toIso(time) {
  const ms = Date.parse(time.replace(/([+-]\d\d)(\d\d)$/, '$1:$2'));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

const lines = fs.readFileSync(input, 'utf8').split(/\r?\n/);
const out = [];
let skipped = 0;

for (const line of lines) {
  if (!line.trim()) continue;
  const match = line.match(/^(\S+) (\S+) (.*)$/);
  const received = match && toIso(match[1]);
  if (!received) {
    skipped++;
    continue;
  }
  const [, , topic, payload] = match;

  const parts = topic.split('/');
  const unitIndex = parts.length >= 3 ? parts.length - (parts[parts.length - 1] === 'STATE' ? 2 : 3) : -1;
  if (unitIndex >= 0) parts[unitIndex] = standIn('unit', parts[unitIndex].toUpperCase());

  out.push(JSON.stringify({ received, topic: parts.join('/'), payload: maskPayload(payload, standIns.unit.map) }));
}

fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${out.join('\n')}\n`);

const counts = Object.entries(standIns).map(([kind, { map }]) => `${map.size} ${kind}`).join(', ');
console.log(`Wrote ${out.length} messages to ${path.relative(process.cwd(), output)}; skipped ${skipped} unreadable lines; masked ${counts}.`);
