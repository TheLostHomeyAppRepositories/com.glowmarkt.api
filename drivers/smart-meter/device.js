'use strict';

const { Device } = require('homey');
const { get } = require('https');
const fetch = require('node-fetch');
const { json } = require('stream/consumers');
// fixed app ID
const APP_ID = 'b0f1b774-a586-4f72-9edd-27ead8aa7a8d';
let poll;
let gasPoll;

class GlowmarktUKSmartMeter_device extends Device {

  /**
   * onInit is called when the device is initialized.
   */
  async onInit() {
    this.log('Smart Meter device initialized');

    // get IDs from store
    let token = this.getStoreValue('token');
    let elec_cons_res = this.getStoreValue('elec_cons_res');
    let gas_cons_res = this.getStoreValue('gas_cons_res');

    // define helper function to get current value for a resource
    async function getCurrentResourceValue(resourceId) {
      let response  = await fetch(`https://api.glowmarkt.com/api/v0-1/resource/${resourceId}/current`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'token': token,
          'applicationId': APP_ID
        }});
      let resource = await response.json();
      return resource.data[0][1];
    }

    // // get initial value
    // this.log('Getting initial value');
    // getCurrentResourceValue(elec_cons_res)
    //   .then(currentVal => this.setCapabilityValue('measure_power', currentVal).catch(this.error));

    // poll every 10 seconds and set measure_power capability to the power value retrieved from API
    this.log('Initiating power polling');
    poll = setInterval(() => {
      getCurrentResourceValue(elec_cons_res)
        .then(value => {
          this.setCapabilityValue('measure_power', value).catch(this.error);
        });
    }, 10000);

      // poll every 10 seconds and set measure_gas capability to the gas meter value retrieved from API
      this.log('Initiating gas polling');
      gasPoll = setInterval(() => {
        getCurrentResourceValue(gas_cons_res)
          .then(value => {
            this.setCapabilityValue('measure_gas_kwh', value).catch(this.error);
          });
      }, 10000);
  }

  /**
   * onAdded is called when the user adds the device, called just after pairing.
   */
  async onAdded() {
    this.log('Smart meter device added');
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
    if (gasPoll != null) {
      clearInterval(gasPoll);
    };
  }

}

module.exports = GlowmarktUKSmartMeter_device;
