'use strict';

const { Device } = require('homey');
const fetch = require('node-fetch');
const { json } = require('stream/consumers');
let poll;
let token;

// Temporary fixed tokens and IDs
const ELEC_CONSUMPTION = 'e18c1df8-989a-4423-a5ec-3d60630ddd65';
const APP_ID = 'b0f1b774-a586-4f72-9edd-27ead8aa7a8d';

class GlowmarktUKSmartMeter_device extends Device {

  /**
   * onInit is called when the device is initialized.
   */
  async onInit() {
    this.log('MyDevice has been initialized');
    const settings = this.getSettings();

    // get new auth token from API
    this.log('Trying to log in with provided credentials');
    const auth = {
      "username": settings.username,
      "password": settings.password
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
      this.log('Successfully logged in. Maybe.');
    });

    // poll every 10 seconds and set measure_power capability to the power value retrieved from API
    const reqUrl = `https://api.glowmarkt.com/api/v0-1/resource/${ELEC_CONSUMPTION}/current`;
    poll = setInterval(() => {
    fetch(reqUrl, {
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
    this.log('Smart meter has been added');
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
    });
  }

  /**
   * onRenamed is called when the user updates the device's name.
   * This method can be used this to synchronise the name to the device.
   * @param {string} name The new name
   */
  async onRenamed(name) {
    this.log('MyDevice was renamed');
  }

  /**
   * onDeleted is called when the user deleted the device.
   */
  async onDeleted() {
    this.log('MyDevice has been deleted');
  }

}

module.exports = GlowmarktUKSmartMeter_device;
