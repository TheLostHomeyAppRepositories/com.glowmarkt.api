'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const StalenessTracker = require('../../lib/glow/StalenessTracker');
const LinkStatusTracker = require('../../lib/glow/LinkStatusTracker');

const SECOND = 1000;
const MINUTE = 60 * SECOND;

test('staleness: defaults to 5 minutes for both meters', () => {
  assert.equal(StalenessTracker.DEFAULT_STALE_AFTER_MINUTES, 5);
  assert.equal(new StalenessTracker({ now: 0 }).staleAfterMinutes, 5);
});

test('staleness: a meter goes stale after 5 minutes without a message, once', () => {
  const tracker = new StalenessTracker({ now: 0 });
  tracker.arrived(10 * SECOND);
  assert.equal(tracker.check(10 * SECOND + 5 * MINUTE), null, 'exactly 5 minutes is not stale');
  assert.deepEqual(tracker.check(10 * SECOND + 6 * MINUTE), { event: 'stopped', minutesSince: 6 });
  assert.equal(tracker.check(10 * SECOND + 7 * MINUTE), null, 'stopped fires once');
  assert.equal(tracker.stale, true);
  assert.equal(tracker.minutesSince(10 * SECOND + 12 * MINUTE), 12);
});

test('staleness: the next message resumes the meter with the minutes it was silent', () => {
  const tracker = new StalenessTracker({ now: 0 });
  tracker.check(6 * MINUTE);
  assert.deepEqual(tracker.arrived(20 * MINUTE + 30 * SECOND), { event: 'resumed', minutesWithout: 20 });
  assert.equal(tracker.stale, false);
  assert.equal(tracker.arrived(20 * MINUTE + 40 * SECOND), null, 'resumed fires once');
});

test('staleness: any arriving message counts, re-sends included, so a flat gas meter never goes stale', () => {
  // The display re-sends gas every 10 s with the same values while the house uses none.
  const tracker = new StalenessTracker({ now: 0 });
  for (let t = 0; t <= 16 * 60 * MINUTE; t += 10 * SECOND) {
    tracker.arrived(t);
    if (t % MINUTE === 0) assert.equal(tracker.check(t), null);
  }
});

test('staleness: the clock starts at creation with no message yet, and the setting can change', () => {
  const tracker = new StalenessTracker({ now: 100 * MINUTE });
  assert.equal(tracker.check(104 * MINUTE), null);
  tracker.setStaleAfter(2);
  assert.deepEqual(tracker.check(104 * MINUTE), { event: 'stopped', minutesSince: 4 });
});

test('staleness: state survives a JSON round trip, as in a device store', () => {
  const tracker = new StalenessTracker({ now: 0 });
  tracker.check(10 * MINUTE);
  const restored = new StalenessTracker({ ...JSON.parse(JSON.stringify(tracker)), now: 30 * MINUTE });
  assert.equal(restored.stale, true);
  assert.equal(restored.lastArrival, 0);
  assert.deepEqual(restored.arrived(31 * MINUTE), { event: 'resumed', minutesWithout: 31 });
});

test('link status: the first status settles at once without a change', () => {
  const tracker = new LinkStatusTracker();
  assert.equal(tracker.update('joined', 0), null);
  assert.equal(tracker.settled, 'joined');
  assert.equal(tracker.isConnected(), true);
});

test('link status: a 10 s blip, as in the capture, changes nothing', () => {
  const tracker = new LinkStatusTracker();
  const changes = [];
  const statuses = { 0: 'joined', 10: 'joined', 20: 'service discovery', 30: 'joined', 40: 'joined' };
  for (let s = 0; s <= 200; s += 10) {
    const change = tracker.update(statuses[s] || 'joined', s * SECOND);
    if (change) changes.push(change);
  }
  assert.deepEqual(changes, []);
  assert.equal(tracker.isConnected(), true);
});

test('link status: a status that lasts 60 s settles and reports the previous one', () => {
  const tracker = new LinkStatusTracker();
  tracker.update('joined', 0);
  const changes = [];
  for (let s = 10; s <= 200; s += 10) {
    const change = tracker.update('service discovery', s * SECOND);
    if (change) changes.push({ at: s, ...change });
  }
  assert.deepEqual(changes, [{ at: 70, status: 'service discovery', previous: 'joined' }]);
  assert.equal(tracker.isConnected(), false);
});

test('link status: a different status restarts the 60 s', () => {
  const tracker = new LinkStatusTracker();
  tracker.update('joined', 0);
  tracker.update('service discovery', 10 * SECOND);
  assert.equal(tracker.update('rejoining', 50 * SECOND), null);
  assert.equal(tracker.update('rejoining', 100 * SECOND), null);
  assert.deepEqual(tracker.update('rejoining', 110 * SECOND), { status: 'rejoining', previous: 'joined' });
});

test('link status: check() settles a pending status without a new message', () => {
  const tracker = new LinkStatusTracker();
  tracker.update('joined', 0);
  tracker.update('service discovery', 10 * SECOND);
  assert.equal(tracker.check(69 * SECOND), null);
  assert.deepEqual(tracker.check(70 * SECOND), { status: 'service discovery', previous: 'joined' });
});

test('link status: state survives a JSON round trip, as in a device store', () => {
  const tracker = new LinkStatusTracker();
  tracker.update('joined', 0);
  tracker.update('service discovery', 10 * SECOND);
  const restored = new LinkStatusTracker(JSON.parse(JSON.stringify(tracker)));
  assert.deepEqual(restored.update('service discovery', 70 * SECOND), { status: 'service discovery', previous: 'joined' });
});
