'use strict';

const LocalMeterDevice = require('../../lib/glow/LocalMeterDevice');

class GlowLocalElectricityDevice extends LocalMeterDevice {

  /**
   * Power is signed: negative while exporting. The totals feed Homey Energy as
   * a cumulative whole-home meter.
   */
  async applyFields(accepted) {
    if (accepted.powerKw !== undefined) await this.setIfChanged('measure_power', Math.round(accepted.powerKw * 1000));
    if (accepted.importKwh !== undefined) await this.setIfChanged('meter_power.imported', accepted.importKwh);
    if (accepted.exportKwh !== undefined) await this.setIfChanged('meter_power.exported', accepted.exportKwh);
  }

}

module.exports = GlowLocalElectricityDevice;
