'use strict';

const { Driver } = require('homey');
const fetch = require('node-fetch');
  // app ID for Bright app - used in API calls to Glowmarkt API
  const BRIGHT_APP_ID = 'b0f1b774-a586-4f72-9edd-27ead8aa7a8d';

class GlowmarktUKSmartMeter_driver extends Driver {

  /**
   * onInit is called when the driver is initialized.
   */
  async onInit() {
    this.log('Glowmarkt UK Smart Meter driver has been initialized');

    // get flow cards
    this._tarrif_becomes_gt = this.homey.getDeviceTriggerCard("tariff_becomes_gt");

    // trigger functions
    function trigger_tariff_becomes_gt(device, tokens, state) {
      this._tariff_becomes_gt
        .trigger(device, tokens, state)
        .then(this.log('Triggered tariff becomes greater than'))
        .catch(this.error);
    }
  }

  async onPair(session) {
    let username;
    let password;

    session.setHandler("login", async (data) => {
      username = data.username;
      password = data.password;

      // create an auth object for the API call
      const auth = {
        'username': username,
        'password': password
      };

      // get new auth token from API and store in device store
      let authResponse = await fetch('https://api.glowmarkt.com/api/v0-1/auth',{
        method: 'POST', 
        headers: {
          'Content-Type': 'application/json',
          'applicationId': BRIGHT_APP_ID
        },
        body: JSON.stringify(auth)
      });
      let authJSON = await authResponse.json();
      let authValid = authJSON.valid;
      this.log('Login credentials valid: ' + authValid);

      if (typeof authValid == 'boolean') {
        if (authValid) { 
          this.token = authJSON.token; 
        }
        return authValid;
      } else {
        this.log('Login credentials response from API did not contain a boolean in the property "valid"');
        return false;
      }
    });

    session.setHandler("list_devices", async () => {
      // get list of resources from API
      let veidResponse = await fetch('https://api.glowmarkt.com/api/v0-1/virtualentity', {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'applicationId': BRIGHT_APP_ID,
          'token': this.token
        }
      });
      let virtualEntities = await veidResponse.json();

      // map these to an array of devices for pairing
      let devices = virtualEntities.map(veToDevice);

      function veToDevice(virtualEntity) {
        // find a resource object in the resources array whose name property is 'electricity consumption'
        let resources = virtualEntity.resources;
        function isElecCons(resource) {
          return resource.name === 'electricity consumption';
        }
        let elec_cons_res = resources.find(isElecCons);
        // if no such resource found, just return the first resource and hope that's right
        let elec_cons_res_id = virtualEntity.resources[0].resourceId;
        if (elec_cons_res) {
          elec_cons_res_id = elec_cons_res.resourceId;
        } 
        // create store object
        let deviceStore = {elec_cons_res: elec_cons_res_id, token: this.token};

        // return a homey device object
        return {name:`${virtualEntity.name} for ${virtualEntity.postalCode}`, data: {id:virtualEntity.veId}, settings: {username, password}, store: deviceStore};
      }

      // finally, return the array of devices available to pair
      return devices;
    });
  }

}

module.exports = GlowmarktUKSmartMeter_driver;
