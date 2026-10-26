'use strict';

// Holds the display's HAN link status steady: a new status takes effect only
// once it has lasted HOLD_MS, so a brief blip (10 s of "service discovery" in
// the capture) doesn't fire Display link status changed twice. The settled
// status also drives the "Display link is connected" condition. Pure: the
// caller passes the time.

const HOLD_MS = 60 * 1000;
const CONNECTED = 'joined';

class LinkStatusTracker {

  /**
   * `settled`, `pending` and `pendingSince` can be restored from the device store.
   */
  constructor({ settled = null, pending = null, pendingSince = null } = {}) {
    this.settled = settled;
    this.pending = pending;
    this.pendingSince = pendingSince;
  }

  /**
   * Records a status from a STATE message. Returns { status, previous } when
   * the settled status changes, otherwise null. The first status ever seen
   * settles at once without a change, like a device's first tariff reading.
   */
  update(status, now) {
    if (this.settled === null) {
      this.settled = status;
      return null;
    }
    if (status === this.settled) {
      this.pending = null;
      this.pendingSince = null;
      return null;
    }
    if (status !== this.pending) {
      this.pending = status;
      this.pendingSince = now;
    }
    return this.check(now);
  }

  /**
   * Settles a pending status that has lasted HOLD_MS. Callers may also run
   * this from a timer, in case STATE messages stop arriving.
   */
  check(now) {
    if (this.pending === null || now - this.pendingSince < HOLD_MS) return null;
    const change = { status: this.pending, previous: this.settled };
    this.settled = this.pending;
    this.pending = null;
    this.pendingSince = null;
    return change;
  }

  isConnected() {
    return this.settled === CONNECTED;
  }

  toJSON() {
    return { settled: this.settled, pending: this.pending, pendingSince: this.pendingSince };
  }

}

LinkStatusTracker.HOLD_MS = HOLD_MS;

module.exports = LinkStatusTracker;
