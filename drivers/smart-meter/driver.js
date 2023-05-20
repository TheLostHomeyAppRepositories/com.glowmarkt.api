'use strict';

const { Driver } = require('homey');
const fetch = require('node-fetch');
const APP_ID = 'b0f1b774-a586-4f72-9edd-27ead8aa7a8d';

class GlowmarktUKSmartMeter_driver extends Driver {

  /**
   * onInit is called when the driver is initialized.
   */
  async onInit() {
    this.log('Glowmarkt UK Smart Meter driver has been initialized');
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
          'applicationId': APP_ID
        },
        body: JSON.stringify(auth)
      });
      let authJSON = await authResponse.json();
      let authValid = authJSON.valid;
      this.log('Auth valid: ' + authValid);

      if (typeof authValid == 'boolean') {
        return authValid;
      } else {
        // should probably throw an error here instead
        return false;
      }
    });

    session.setHandler("list_devices", async () => {
      // replace this at some point with logic to return list of devices available
      return [
        {
          name: 'Smart Meter',
          data: {
            id: 'my-smart-meter',
          },
          settings: {
            username, password
          }
        }
      ];
    });
  }

}

module.exports = GlowmarktUKSmartMeter_driver;
