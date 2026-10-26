'use strict';

const LocalMeterDriver = require('../../lib/glow/LocalMeterDriver');

class GlowLocalGasDriver extends LocalMeterDriver {

  get kind() {
    return 'gasmeter';
  }

}

module.exports = GlowLocalGasDriver;
