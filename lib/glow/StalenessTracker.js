'use strict';

// Tracks whether a meter is still reporting, from when its messages arrive.
// Payload timestamps aren't used: the gas timestamp is the display's clock, so
// a newer one doesn't mean a new meter reading. Pure: the caller passes the
// time, checks once a minute, and acts on the events.
//
// What it can't detect: a gas meter or hub mirror that has stopped while the
// display keeps re-sending its last value looks exactly like a house using no
// gas, so there's deliberately no "no change for N hours" check.

const MINUTE_MS = 60 * 1000;
const DEFAULT_STALE_AFTER_MINUTES = 5;

class StalenessTracker {

  /**
   * `lastArrival` and `stale` can be restored from the device store; with no
   * arrival yet, the clock starts at `now`.
   */
  constructor({
    staleAfterMinutes = DEFAULT_STALE_AFTER_MINUTES, lastArrival = null, stale = false, now = Date.now(),
  } = {}) {
    this.staleAfterMinutes = staleAfterMinutes;
    this.lastArrival = lastArrival === null ? now : lastArrival;
    this.stale = Boolean(stale);
  }

  setStaleAfter(minutes) {
    this.staleAfterMinutes = minutes;
  }

  /**
   * Records a message for this meter. Returns { event: 'resumed', minutesWithout }
   * if the meter had been marked stale, otherwise null.
   */
  arrived(now) {
    const wasStale = this.stale;
    const minutesWithout = Math.floor((now - this.lastArrival) / MINUTE_MS);
    this.lastArrival = now;
    this.stale = false;
    return wasStale ? { event: 'resumed', minutesWithout } : null;
  }

  /**
   * Called once a minute. Returns { event: 'stopped', minutesSince } the first
   * time no message has arrived for longer than the stale-after setting,
   * otherwise null.
   */
  check(now) {
    if (this.stale) return null;
    if (now - this.lastArrival <= this.staleAfterMinutes * MINUTE_MS) return null;
    this.stale = true;
    return { event: 'stopped', minutesSince: Math.floor((now - this.lastArrival) / MINUTE_MS) };
  }

  /**
   * Whole minutes since the last message, for the device warning.
   */
  minutesSince(now) {
    return Math.floor((now - this.lastArrival) / MINUTE_MS);
  }

  toJSON() {
    return { lastArrival: this.lastArrival, stale: this.stale };
  }

}

StalenessTracker.DEFAULT_STALE_AFTER_MINUTES = DEFAULT_STALE_AFTER_MINUTES;

module.exports = StalenessTracker;
