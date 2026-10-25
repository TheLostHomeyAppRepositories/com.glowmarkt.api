'use strict';

const { Device } = require('homey');
const { apiGet, tokenExpiry } = require('../../lib/cloud/glowmarkt');

// renew the token when less than this much of its life remains
const TOKEN_RENEW_BEFORE_MS = 24 * 60 * 60 * 1000;
// how long to wait before trying again when access is refused even after a fresh login
const ACCESS_REFUSED_RETRY_MS = 60 * 60 * 1000;

class GlowmarktUKSmartMeter_device extends Device {

  /**
   * onInit is called when the device is initialized.
   */
  async onInit() {
    this.log('Display and CAD (API) initialized');

    if (!this.hasCapability('meter_power.imported')) {
      await this.addCapability('meter_power.imported');
    }

    const elec_cons_res = this.getStoreValue('elec_cons_res');

    // Set device unavailable until first successful poll
    this.setUnavailable().catch(this.error);

    const updateDevice = async () => {
      if (this.isAccessRefused()) return;
      try {
        const powerRes = await this.request(`/resource/${elec_cons_res}/current`);
        if (!powerRes.data?.[0]) throw new Error(`Power API returned no data: ${JSON.stringify(powerRes)}`);
        this.accessRefusedUntil = null;
        if (!this.getAvailable()) this.setAvailable().catch(this.error);
        this.setCapabilityValue('measure_power', powerRes.data[0][1]).catch(this.error);

        const energyRes = await this.request(`/resource/${elec_cons_res}/meterread`);
        if (!energyRes.data?.[0]) throw new Error(`Meter read API returned no data: ${JSON.stringify(energyRes)}`);
        if (!this.getAvailable()) this.setAvailable().catch(this.error);
        const kWh = energyRes.data[0][1] / 1000;
        this.setCapabilityValue('meter_power.imported', kWh).catch(this.error);
      } catch (error) {
        this.error('updateDevice failed:', error.message);
        // an access refusal has already set the device unavailable with its own message
        if (!error.accessRefused && this.getAvailable()) {
          this.log('Device set as unavailable');
          this.setUnavailable().catch(this.error);
        }
      }
    };

    // updateTariff does not control device availability — a missing/failed tariff
    // should not mark the device unavailable if the power API is working.
    const updateTariff = async () => {
      if (this.isAccessRefused()) return;
      try {
        const resource = await this.request(`/resource/${elec_cons_res}/tariff`);
        const tariff = Number(resource.data[0].currentRates.rate);
        if (!Number.isFinite(tariff)) throw new Error(`Tariff API returned no rate: ${JSON.stringify(resource.data[0])}`);
        const previous = this.getCapabilityValue('tariff');
        await this.setCapabilityValue('tariff', tariff);
        if (previous !== null && previous !== tariff) {
          this.log(`Tariff changed from ${previous} to ${tariff}`);
          this.driver.tariffChangedTrigger.trigger(this, { tariff }).catch(this.error);
        }
      } catch (error) {
        this.error('updateTariff failed:', error.message);
      }
    };

    // Fire initial polls without awaiting — awaiting setAvailable() inside onInit
    // breaks the Homey pairing wizard (device state must not be set before onAdded fires).
    updateDevice();
    updateTariff();

    // if pollFrequency not already set, get poll frequency from device settings or default to 10
    const settings = this.getSettings();
    if (!this.pollFrequency) {
      if (settings.pollFrequency) {
        this.pollFrequency = (settings.pollFrequency * 1000);
        this.log(`Poll frequency read from settings as ${this.pollFrequency}`);
      } else {
        this.log('Could not get poll frequency from settings; defaulting to 10000');
        this.pollFrequency = 10000;
      }
    }

    this.log(`Initiating power polling with frequency ${this.pollFrequency}`);
    this.poll = this.homey.setInterval(updateDevice, this.pollFrequency);

    this.log('Initiating tariff polling');
    this.tariffPoll = this.homey.setInterval(updateTariff, 60000);
  }

  /**
   * GETs an API path and returns the response body. Renews the token when it's
   * close to expiry, and logs in again once on a 401 or error response. If it's
   * still a 401 after a fresh login, marks the device unavailable and stops
   * trying for an hour.
   */
  async request(path) {
    let token = await this.currentToken();
    let res = await apiGet(path, token);
    if (res.authFailed) {
      this.log(`${path} returned HTTP ${res.status}, logging in again`);
      token = await this.refreshToken();
      if (!token) throw new Error('Token refresh failed');
      res = await apiGet(path, token);
      if (res.status === 401) {
        this.refuseAccess(res);
        const error = new Error(`Access refused after token refresh: HTTP ${res.status} ${JSON.stringify(res.body)}`);
        error.accessRefused = true;
        throw error;
      }
    }
    if (!res.ok) throw new Error(`API error: HTTP ${res.status} ${JSON.stringify(res.body)}`);
    return res.body;
  }

  /**
   * Returns the stored token, renewing it first if it expires within a day.
   */
  async currentToken() {
    const token = this.getStoreValue('token');
    const expiry = tokenExpiry(token);
    if (expiry !== null && expiry - Date.now() < TOKEN_RENEW_BEFORE_MS) {
      this.log('Token expires within a day, renewing');
      return (await this.refreshToken()) || token;
    }
    return token;
  }

  /**
   * Refreshes the API token using stored credentials. Returns the new token or null on failure.
   * Concurrent calls share one login through the driver, across every device on the account.
   */
  async refreshToken() {
    const settings = this.getSettings();
    const token = await this.driver.login(settings.username, settings.password);
    if (!token) {
      this.error('Token refresh failed');
      return null;
    }
    await this.setStoreValue('token', token);
    this.log('Token refreshed successfully');
    return token;
  }

  isAccessRefused() {
    return Boolean(this.accessRefusedUntil && Date.now() < this.accessRefusedUntil);
  }

  refuseAccess(res) {
    this.accessRefusedUntil = Date.now() + ACCESS_REFUSED_RETRY_MS;
    this.error(`Access refused after a fresh login (HTTP ${res.status}); retrying in an hour`);
    this.setUnavailable(this.homey.__('cloud.accessRefused')).catch(this.error);
  }

  /**
   * onAdded is called when the user adds the device, called just after pairing.
   */
  async onAdded() {
    this.log('Display and CAD (API) device added');
  }

  /**
   * onSettings is called when the user updates the device's settings.
   * @param {object} event the onSettings event data
   * @param {object} event.oldSettings The old settings object
   * @param {object} event.newSettings The new settings object
   * @param {string[]} event.changedKeys An array of keys changed since the previous version
   * @returns {Promise<string|void>} return a custom message that will be displayed
   */
  async onSettings({ oldSettings, newSettings, changedKeys }) {
    this.log('Display and CAD (API) settings changed');

    // if username or password changed, get new token from API and write it to token in device store
    if (changedKeys.includes('username') || changedKeys.includes('password')) {
      this.log('Credentials changed - getting new token from API');
      const token = await this.driver.login(newSettings.username, newSettings.password);
      await this.setStoreValue('token', token || 'VOID');
      this.accessRefusedUntil = null;
    }

    // if poll frequency changed, update variable
    if (changedKeys.includes('pollFrequency')) {
      this.pollFrequency = (newSettings.pollFrequency * 1000);
    }

    // for all changes, cancel existing polling and re-initialise device
    this.log('Re-initialising device');
    if (this.poll) this.homey.clearInterval(this.poll);
    if (this.tariffPoll) this.homey.clearInterval(this.tariffPoll);
    this.onInit();
  }

  /**
   * onRenamed is called when the user updates the device's name.
   * @param {string} name The new name
   */
  async onRenamed(name) {
    this.log('Display and CAD (API) was renamed');
  }

  /**
   * onDeleted is called when the user deleted the device.
   */
  async onDeleted() {
    this.log('Display and CAD (API) has been deleted');
    if (this.poll) {
      this.homey.clearInterval(this.poll);
      this.homey.clearInterval(this.tariffPoll);
    }
  }
}

module.exports = GlowmarktUKSmartMeter_device;
