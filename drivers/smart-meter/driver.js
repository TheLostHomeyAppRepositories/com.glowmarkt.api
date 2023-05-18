'use strict';

const { Driver } = require('homey');
const fetch = require('node-fetch');
const APP_ID = 'b0f1b774-a586-4f72-9edd-27ead8aa7a8d';
let token;

class GlowmarktUKSmartMeter_driver extends Driver {

  /**
   * onInit is called when the driver is initialized.
   */
  async onInit() {
    this.log('Glowmarkt UK Smart Meter has been initialized');
  }

  /**
   * onPairListDevices is called when a user is adding a device
   * and the 'list_devices' view is called.
   * This should return an array with the data of devices that are available for pairing.
   */
  async onPair(session) {
    let username = "";
    let password = "";

    session.setHandler("login", async (data) => {
      username = data.username;
      password = data.password;

      // create an auth object for the API call
      const auth = {
        "username": username,
        "password": password
      };
      this.log('Auth:' + JSON.stringify(auth));

      // get new auth token from API
      this.log('Trying to log in with provided credentials');
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
      
      const credentialsAreValid = true;

      // return true to continue adding the device if the login succeeded
      // return false to indicate to the user the login attempt failed
      // thrown errors will also be shown to the user
      return credentialsAreValid;
    });

    session.setHandler("list_devices", async () => {
      return [
        {
          name: 'Smart Meter',
          data: {
            id: 'my-smart-meter',
          },
          "settings": {
            username, password
          }
        }
      ];
      
      // const api = await DeviceAPI.login({ username, password });
      // const myDevices = await api.getDevices();

      // const devices = myDevices.map((myDevice) => {
      //   return {
      //     name: myDevice.name,
      //     data: {
      //       id: myDevice.id,
      //     },
      //     settings: {
      //       // Store username & password in settings
      //       // so the user can change them later
      //       username,
      //       password,
      //     },
      //   };
      // });

      // return devices;
    });
  }

}

module.exports = GlowmarktUKSmartMeter_driver;
