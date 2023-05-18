'use strict';

const { Driver } = require('homey');

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
  async onPairListDevices() {
    return [
      {
        name: 'Smart Meter',
        data: {
          id: 'my-smart-meter',
        }
      },
    ];
  }

}

module.exports = GlowmarktUKSmartMeter_driver;
