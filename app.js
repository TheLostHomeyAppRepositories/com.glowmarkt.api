'use strict';

const Homey = require('homey');

class GlowmarktApp extends Homey.App {

  /**
   * onInit is called when the app is initialized.
   */
  async onInit() {
    this.log('Glowmarkt app initialised');
  }

}

module.exports = GlowmarktApp;
