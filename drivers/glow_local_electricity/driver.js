'use strict';

const LocalMeterDriver = require('../../lib/glow/LocalMeterDriver');

class GlowLocalElectricityDriver extends LocalMeterDriver {

  get kind() {
    return 'electricitymeter';
  }

}

module.exports = GlowLocalElectricityDriver;
