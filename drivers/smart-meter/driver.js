'use strict';

const { Driver } = require('homey');

class MyDriver extends Driver {

  /**
   * onInit is called when the driver is initialized.
   */
  async onInit() {
    this.log('MyDriver has been initialized');
  }

  /**
   * onPairListDevices is called when a user is adding a device
   * and the 'list_devices' view is called.
   * This should return an array with the data of devices that are available for pairing.
   */
  async onPairListDevices() {
    return [
      {
        name: 'Smart Meter',
        data: {
          id: 'my-smart-meter',
        },
        store: {
          // set blank token to start with - will be grabbed from API when device initialised
          token: 'new',
          // set username and password - these will eventually come from device settings but hard coded here for now to keep things simple
          user: 'recheck_golf_0r@icloud.com',
          pass: 'cidriM3ruzbodohtug'
        },
      },
    ];
  }

}

module.exports = MyDriver;
