'use strict';

// Replays every fixture file in test/fixtures through the parser and validator,
// keeping validation state per unit and meter kind as a device would.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { parseTopic, parsePayload } = require('../../lib/glow/parse');
const { emptyState, validateReading, validateState } = require('../../lib/glow/validate');

const FIXTURES = path.join(__dirname, '..', 'fixtures');

function replay(file) {
  const counts = { messages: 0, ignored: 0, accepted: 0 };
  const rejections = {};
  const states = new Map();
  const count = (key) => { rejections[key] = (rejections[key] || 0) + 1; };

  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const { received, topic, payload } = JSON.parse(line);
    counts.messages++;

    const route = parseTopic(topic, 'glow');
    if (!route) {
      counts.ignored++;
      continue;
    }
    const parsed = parsePayload(route.kind, payload);
    if (!parsed.ok) {
      count(`${route.kind} rule ${parsed.rule} ${parsed.reason}`);
      continue;
    }

    if (route.kind === 'STATE') {
      validateState(parsed.reading).rejections.forEach((r) => count(`STATE ${r.field} rule ${r.rule} ${r.reason}`));
      continue;
    }

    const key = `${route.unitId}/${route.kind}`;
    const result = validateReading(parsed.reading, states.get(key) || emptyState(), { now: Date.parse(received) });
    states.set(key, result.state);
    result.rejections.forEach((r) => count(`${route.kind} ${r.field ?? 'message'} rule ${r.rule} ${r.reason}`));
    if (result.ok) counts.accepted++;
  }
  return { counts, rejections };
}

const files = fs.existsSync(FIXTURES) ? fs.readdirSync(FIXTURES).filter((f) => f.endsWith('.jsonl')) : [];

for (const file of files) {
  test(`replay ${file} without exceptions`, (t) => {
    const { counts, rejections } = replay(path.join(FIXTURES, file));
    t.diagnostic(`messages ${counts.messages}, ignored topics ${counts.ignored}, meter readings accepted ${counts.accepted}`);
    const reasons = Object.entries(rejections).sort();
    if (!reasons.length) t.diagnostic('no rejections');
    for (const [reason, n] of reasons) t.diagnostic(`rejected: ${reason} × ${n}`);
    assert.ok(counts.messages > 0);
  });
}
