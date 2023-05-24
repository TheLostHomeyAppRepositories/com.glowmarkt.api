'use strict';

const { Device } = require('homey');
const { get } = require('https');
const fetch = require('node-fetch');
const { json } = require('stream/consumers');
// fixed app ID for Glowmarkt Bright app
const APP_ID = 'b0f1b774-a586-4f72-9edd-27ead8aa7a8d';
let poll;
let pollFrequency;
let settings;

class GlowmarktUKSmartMeter_device extends Device {

  /**
   * onInit is called when the device is initialized.
   */
  async onInit() {
    this.log('Display and CAD (API) initialized');

    // get IDs from store
    let token = this.getStoreValue('token');
    let elec_cons_res = this.getStoreValue('elec_cons_res');

    // set device as initially unavailable
    this.setUnavailable().catch(this.error);

    // define helper function to get current value for a resource
    async function getCurrentResourceValue(resourceId) {
      let response;
      try {
        response  = await fetch(`https://api.glowmarkt.com/api/v0-1/resource/${resourceId}/current`, {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
            'token': token,
            'applicationId': APP_ID
          }});
      } catch (err) {
        throw new Error('API request for current resource value did not get a response');
      }
      let resource = await response.json();
      if (!resource.error) {
        return resource.data[0][1];
      } else {
        throw new Error('Get current resource value call returned error');
      }
    }

    // initial poll
    getCurrentResourceValue(elec_cons_res)
        .then(value => {
          try {
            // if device was unavailable, set as available again now we have a polling value
            if (!this.getAvailable()) {
              this.setAvailable().catch(this.error);
            }
            // then set the measure_power capability value
            this.setCapabilityValue('measure_power', value).catch(this.error);
          } catch {
            // if polling error, set device as unavailable
            this.setUnavailable().catch(this.error);
          }
        }).catch(this.error);

    // if pollFrequency not already set, get poll frequency from device settings or default to 10
    if (!pollFrequency) {
      settings = this.getSettings();
      if (settings.pollFrequency) {
        pollFrequency = (settings.pollFrequency * 1000);
        this.log(`Poll frequency read from settings as ${pollFrequency}`);
      } else {
        this.log('Could not get poll frequency from settings; defaulting to 10000');
        pollFrequency = 10000;
      }
    }
    // poll every {pollFrequency} seconds and set measure_power capability to the power value retrieved from API
    this.log(`Initiating power polling with frequency ${pollFrequency}`);
    poll = setInterval(() => {
      getCurrentResourceValue(elec_cons_res)
        .then(value => {
          try {
            // if device was unavailable, set as available again now we have a polling value
            if (!this.getAvailable()) {
              this.setAvailable().catch(this.error);
            }
            // then set the measure_power capability value
            this.setCapabilityValue('measure_power', value).catch(this.error);
          } catch {
            // if polling error, set device as unavailable
            this.setUnavailable().catch(this.error);
          }
        })
        .catch(this.error);
      }, pollFrequency);
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

    // if username or password changed, get new token
    if (changedKeys.includes('username') || changedKeys.includes('password')) {
      // get new token from API and write it to token in device store
      this.log('Credentials changed - getting new token from API');
      const auth = {
        "username": newSettings.username,
        "password": newSettings.password
      };

      let authResponse = await fetch('https://api.glowmarkt.com/api/v0-1/auth', {
        method: 'POST', 
        headers: {
          'Content-Type': 'application/json',
          'applicationId': APP_ID
        },
        body: JSON.stringify(auth)
      });
      let authJSON = await authResponse.json();
      // if authenticated, set token from response otherwise void the token
      let token;
      if (authJSON.valid) {
        token = authJSON.token;
      } else {
        token = 'VOID';
      }
      this.setStoreValue('token',token);
    };

    // if poll frequency changed, update variable
    if (changedKeys.includes('pollFrequency')) {
      pollFrequency = (newSettings.pollFrequency * 1000);
    }

    // for all changes, cancel existing polling and re-initialise device
    this.log('Re-initialising device');
    if (poll) {
      clearInterval(poll);
    };
    this.onInit();
  }

  /**
   * onRenamed is called when the user updates the device's name.
   * This method can be used this to synchronise the name to the device.
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
    if (poll) {
      clearInterval(poll);
    };
  }

}

module.exports = GlowmarktUKSmartMeter_device;
