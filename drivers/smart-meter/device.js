'use strict';

const { Device } = require('homey');
const fetch = require('node-fetch');
const { json } = require('stream/consumers');
// fixed app ID
const APP_ID = 'b0f1b774-a586-4f72-9edd-27ead8aa7a8d';
let poll;
let token;

class GlowmarktUKSmartMeter_device extends Device {

  /**
   * onInit is called when the device is initialized.
   */
  async onInit() {
    this.log('Smart Meter device initialized');
    const settings = this.getSettings();

    // set username and password from store
    let username = settings.username;
    let password = settings.password;

    // create an auth object for the API call
    const auth = {
      'username': username,
      'password': password
    };

    // get auth token from API
    this.log('Getting auth token from API');

    let tokenResponse = await fetch('https://api.glowmarkt.com/api/v0-1/auth', {
      method: 'POST', 
      headers: {
        'Content-Type': 'application/json',
        'applicationId': APP_ID
      },
      body: JSON.stringify(auth)
    });
    let tokenResponseJSON = await tokenResponse.json();
    token = tokenResponseJSON.token;

    // poll every 10 seconds and set measure_power capability to the power value retrieved from API
    this.log('Initiating polling');
    poll = setInterval(() => {
      let elec_consumption = this.getStoreValue('elec_consumption_id');

      let pollUrl = `https://api.glowmarkt.com/api/v0-1/resource/${elec_consumption}/current`;
      fetch(pollUrl, {
        method: 'GET', 
        headers: {
          'Content-Type': 'application/json',
          'token': token,
          'applicationId': APP_ID
        }})
        .then(res => res.json())
        .then(json => {
          let power = json.data[0][1];
          this.setCapabilityValue('measure_power', power).catch(this.error);
        });
    }, 10000);
  }

  /**
   * onAdded is called when the user adds the device, called just after pairing.
   */
  async onAdded() {
    this.log('Smart meter device added');

        // get elec consumption id
        this.log('Getting electricity consumption ID from API');

        let ecidResponse = await fetch('https://api.glowmarkt.com/api/v0-1/virtualentity', {
          method: 'GET', 
          headers: {
            'Content-Type': 'application/json',
            'token': token,
            'applicationId': APP_ID
        }});
        let ecidResponseJSON = await ecidResponse.json();
        let elec_consumption = ecidResponseJSON[0].resources[0].resourceId;
        this.setStoreValue('elec_consumption_id', elec_consumption);
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
    this.log('MyDevice settings where changed');

    // get new token from API and write it to token in device store
    this.log('Device settings changed - getting new token from API');
    const auth = {
      "username": newSettings.username,
      "password": newSettings.password
    };
    const apiReqUrl = 'https://api.glowmarkt.com/api/v0-1/auth';

    fetch(apiReqUrl, {
      method: 'POST', 
      headers: {
        'Content-Type': 'application/json',
        'applicationId': APP_ID
      },
      body: JSON.stringify(auth)
    })
    .then(res => res.json())
    .then(json => {
      token = json.token;
      this.setStoreValue('token',token);
    });
  }

  /**
   * onRenamed is called when the user updates the device's name.
   * This method can be used this to synchronise the name to the device.
   * @param {string} name The new name
   */
  async onRenamed(name) {
    this.log('Smart meter device was renamed');
  }

  /**
   * onDeleted is called when the user deleted the device.
   */
  async onDeleted() {
    this.log('Smart meter device has been deleted');
    if (poll != null) {
      clearInterval(poll);
    };
  }

}

module.exports = GlowmarktUKSmartMeter_device;
