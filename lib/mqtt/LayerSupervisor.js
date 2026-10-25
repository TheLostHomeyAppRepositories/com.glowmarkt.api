'use strict';

// Decides whether the MQTT layer should be running. Pure: the caller passes in
// the time and the number of local devices, and acts on the answer.
//
// The layer is wanted while the user's Start now flag is set, any local device
// exists, or a pairing session is open. Once none of those holds, it stops
// after IDLE_STOP_MS. A pairing session counts as open until it disconnects or
// goes IDLE_STOP_MS without activity, in case a disconnect never arrives.

const IDLE_STOP_MS = 10 * 60 * 1000;

class LayerSupervisor {

  constructor() {
    this.startNow = false;
    this.sessions = new Map();
    this.nextSessionId = 1;
    this.unwantedSince = null;
  }

  setStartNow(value) {
    this.startNow = Boolean(value);
  }

  openSession(now) {
    const id = this.nextSessionId++;
    this.sessions.set(id, now);
    return id;
  }

  touchSession(id, now) {
    if (this.sessions.has(id)) this.sessions.set(id, now);
  }

  closeSession(id) {
    this.sessions.delete(id);
  }

  openSessions(now) {
    for (const [id, lastActive] of this.sessions) {
      if (now - lastActive >= IDLE_STOP_MS) this.sessions.delete(id);
    }
    return this.sessions.size;
  }

  isWanted(now, localDevices) {
    return this.startNow || localDevices > 0 || this.openSessions(now) > 0;
  }

  /**
   * Returns 'start', 'stop' or 'keep' for a layer that is or isn't running.
   * With `immediate`, an unwanted layer stops now rather than after the idle
   * period (used for the Stop button).
   */
  decide({ now, localDevices, running, immediate = false }) {
    if (this.isWanted(now, localDevices)) {
      this.unwantedSince = null;
      return running ? 'keep' : 'start';
    }
    if (!running) {
      this.unwantedSince = null;
      return 'keep';
    }
    if (this.unwantedSince === null) this.unwantedSince = now;
    return immediate || now - this.unwantedSince >= IDLE_STOP_MS ? 'stop' : 'keep';
  }

}

LayerSupervisor.IDLE_STOP_MS = IDLE_STOP_MS;

module.exports = LayerSupervisor;
