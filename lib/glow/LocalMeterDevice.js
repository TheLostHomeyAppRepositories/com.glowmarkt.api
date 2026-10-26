'use strict';

const { Device } = require('homey');

const { emptyState, validateReading } = require('./validate');
const { mask } = require('./mask');
const StalenessTracker = require('./StalenessTracker');
const LinkStatusTracker = require('./LinkStatusTracker');

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

/**
 * Shared behaviour of the local gas and electricity meters. The app routes
 * messages from the MQTT layer to onGlowArrival, onGlowReading and
 * onGlowState; subclasses map accepted fields to capabilities in applyFields.
 *
 * The store keeps the validation state (last good values and payload
 * timestamps), staleness and link status, so they survive a restart.
 */
class LocalMeterDevice extends Device {

  async onInit() {
    const { unitId, kind } = this.getData();
    this.unitId = unitId;
    this.kind = kind;

    this.validation = this.getStoreValue('validation') || emptyState();
    this.validationDirty = false;
    this.hasVolume = this.getStoreValue('hasVolume');

    // The clock restarts at init unless the meter was already stale, so time
    // the app spent stopped doesn't count as silence from the display.
    const staleness = this.getStoreValue('staleness') || {};
    this.staleness = new StalenessTracker({
      staleAfterMinutes: this.getSetting('stale_after') || StalenessTracker.DEFAULT_STALE_AFTER_MINUTES,
      lastArrival: staleness.stale ? staleness.lastArrival : null,
      stale: staleness.stale,
      now: Date.now(),
    });
    this.link = new LinkStatusTracker(this.getStoreValue('link') || {});

    this.rejections = {};
    this.lastLoggedAt = {};
    this.pendingSignal = {};
    this.signalWrittenAt = 0;

    const cardId = (name) => `${this.driver.id}_${name}`;
    this.cards = {
      tariffChanged: this.homey.flow.getDeviceTriggerCard(cardId('tariff_changed')),
      linkChanged: this.homey.flow.getDeviceTriggerCard(cardId('link_changed')),
      stopped: this.homey.flow.getDeviceTriggerCard(cardId('stopped_reporting')),
      resumed: this.homey.flow.getDeviceTriggerCard(cardId('resumed_reporting')),
    };

    if (this.getSetting('unit_id') !== unitId) await this.setSettings({ unit_id: unitId }).catch(this.error);
    await this.updateWarning(true);

    this.minuteTimer = this.homey.setInterval(() => this.everyMinute().catch(this.error), MINUTE_MS);
    this.homey.app.updateLayer().catch(this.error);
    this.log(`Local ${kind} device initialised for unit ${unitId}`);
  }

  async onAdded() {
    this.homey.app.updateLayer().catch(this.error);
  }

  async onSettings({ newSettings, changedKeys }) {
    if (changedKeys.includes('stale_after')) {
      this.staleness.setStaleAfter(newSettings.stale_after);
      // Apply the new limit straight away rather than at the next minute.
      this.homey.setTimeout(() => this.everyMinute().catch(this.error), 0);
    }
  }

  async onDeleted() {
    this.stopTimers();
    this.homey.app.updateLayer().catch(this.error);
  }

  async onUninit() {
    this.stopTimers();
    await this.saveValidation();
  }

  stopTimers() {
    if (this.minuteTimer) this.homey.clearInterval(this.minuteTimer);
    this.minuteTimer = null;
  }

  // Messages from the app

  /**
   * Any message on this meter's topic, valid or not, shows the display is alive.
   */
  async onGlowArrival() {
    const change = this.staleness.arrived(Date.now());
    if (!change) return;
    this.log(`Resumed reporting after ${change.minutesWithout} minutes`);
    await this.saveStaleness();
    await this.updateWarning();
    await this.cards.resumed.trigger(this, { minutes: change.minutesWithout }).catch(this.error);
  }

  async onGlowReading({ reading, receivedAt }) {
    const result = validateReading(reading, this.validation, { now: receivedAt });
    result.rejections.forEach((rejection) => this.countRejection(rejection));
    if (!result.ok) return;

    this.validation = result.state;
    this.validationDirty = true;
    if (result.baselineResets.length) {
      this.log(`Meter total reset, new baseline: ${result.baselineResets.join(', ')}`);
      await this.saveValidation();
    }

    if (this.kind === 'gasmeter' && reading.hasVolume !== this.hasVolume) {
      this.hasVolume = reading.hasVolume;
      await this.setStoreValue('hasVolume', this.hasVolume).catch(this.error);
      await this.updateWarning();
    }

    await this.applyFields(result.accepted);
    await this.applyTariff(result.accepted);
    await this.updateLabels({ meter_id: mask(this.kind === 'gasmeter' ? reading.meta.mprn : reading.meta.mpan) });
  }

  async onGlowState({ reading, accepted }) {
    if (accepted.hanStatus !== undefined) {
      const before = JSON.stringify(this.link);
      const change = this.link.update(accepted.hanStatus, Date.now());
      if (JSON.stringify(this.link) !== before) await this.setStoreValue('link', this.link.toJSON()).catch(this.error);
      await this.applyLink(change);
    }

    for (const capability of ['signal_strength', 'link_quality']) {
      const value = accepted[capability === 'signal_strength' ? 'rssi' : 'lqi'];
      if (value !== undefined) this.pendingSignal[capability] = value;
    }
    await this.flushSignal();

    await this.updateLabels({ hardware: reading.hardware, software: reading.software });
  }

  // Implemented by subclasses: write accepted readings to capabilities.
  async applyFields() {
    throw new Error('applyFields not implemented');
  }

  // Shared parts

  async everyMinute() {
    const now = Date.now();

    const stopped = this.staleness.check(now);
    if (stopped) {
      this.log(`Stopped reporting: no data for ${stopped.minutesSince} minutes`);
      await this.saveStaleness();
      await this.cards.stopped.trigger(this, { minutes: stopped.minutesSince }).catch(this.error);
    }
    await this.updateWarning();

    const settled = this.link.check(now);
    if (settled) {
      await this.setStoreValue('link', this.link.toJSON()).catch(this.error);
      await this.applyLink(settled);
    }

    await this.flushSignal();
    if (this.validationDirty) await this.saveValidation();
  }

  async applyTariff(accepted) {
    if (accepted.unitRate !== undefined) {
      const tariff = toPence(accepted.unitRate);
      const previous = this.getCapabilityValue('tariff');
      // Not on the device's first tariff reading.
      if (await this.setIfChanged('tariff', tariff) && previous !== null) {
        this.log(`Tariff changed from ${previous} to ${tariff} p/kWh`);
        await this.cards.tariffChanged.trigger(this, { tariff, previous_tariff: previous }).catch(this.error);
      }
    }
    if (accepted.standingCharge !== undefined) {
      await this.setIfChanged('standing_charge', toPence(accepted.standingCharge));
    }
  }

  async applyLink(change) {
    // The first status settles at once with no change; show it without a trigger.
    if (this.link.settled !== null) await this.setIfChanged('display_link', this.link.settled);
    if (!change) return;
    this.log(`Display link changed from ${change.previous} to ${change.status}`);
    await this.cards.linkChanged.trigger(this, { status: change.status, previous_status: change.previous }).catch(this.error);
  }

  // RSSI and LQI keep Insights but change constantly, so they're written at
  // most once a minute, with the latest value.
  async flushSignal() {
    if (Date.now() - this.signalWrittenAt < MINUTE_MS) return;
    const pending = this.pendingSignal;
    this.pendingSignal = {};
    let wrote = false;
    for (const [capability, value] of Object.entries(pending)) {
      wrote = (await this.setIfChanged(capability, value)) || wrote;
    }
    if (wrote) this.signalWrittenAt = Date.now();
  }

  async setIfChanged(capability, value) {
    if (!this.hasCapability(capability) || this.getCapabilityValue(capability) === value) return false;
    await this.setCapabilityValue(capability, value).catch(this.error);
    return true;
  }

  // Read-only labels, written only when they change.
  async updateLabels(labels) {
    const changed = {};
    for (const [key, value] of Object.entries(labels)) {
      if (value !== undefined && value !== null && this.getSetting(key) !== String(value)) changed[key] = String(value);
    }
    if (Object.keys(changed).length) await this.setSettings(changed).catch(this.error);
  }

  async updateWarning(force = false) {
    let message = null;
    if (this.staleness.stale) {
      message = this.homey.__('device.stale', { minutes: this.staleness.minutesSince(Date.now()) });
    } else if (this.kind === 'gasmeter' && this.hasVolume === false) {
      message = this.homey.__('device.noGasVolume');
    }
    if (!force && message === this.warning) return;
    this.warning = message;
    if (message) await this.setWarning(message).catch(this.error);
    else await this.unsetWarning().catch(this.error);
  }

  countRejection({ field, reason, value }) {
    this.rejections[reason] = (this.rejections[reason] || 0) + 1;
    // The app log gets each reason at most once an hour.
    const now = Date.now();
    if (now - (this.lastLoggedAt[reason] || 0) < HOUR_MS) return;
    this.lastLoggedAt[reason] = now;
    this.log(`Rejected ${field || 'message'}: ${reason} (value ${JSON.stringify(value)}); ${this.rejections[reason]} so far`);
  }

  async saveValidation() {
    this.validationDirty = false;
    await this.setStoreValue('validation', this.validation).catch(this.error);
  }

  async saveStaleness() {
    await this.setStoreValue('staleness', this.staleness.toJSON()).catch(this.error);
  }

  // For flow conditions and the settings page.

  isReporting() {
    return !this.staleness.stale;
  }

  isLinkConnected() {
    return this.link.isConnected();
  }

  getStatusSummary() {
    return {
      name: this.getName(),
      kind: this.kind,
      reporting: this.isReporting(),
      rejections: { ...this.rejections },
    };
  }

}

// The display reports £; the capabilities are in pence.
function toPence(pounds) {
  return Math.round(pounds * 100 * 10000) / 10000;
}

LocalMeterDevice.toPence = toPence;

module.exports = LocalMeterDevice;
