'use strict';

const LocalMeterDevice = require('../../lib/glow/LocalMeterDevice');

class GlowLocalGasDevice extends LocalMeterDevice {

  /**
   * meter_gas (m³) feeds Homey Energy. The gas energy total (kWh) is a custom
   * capability, never meter_power, or Energy would count gas as electricity.
   * With no cumulativevol in the payload, meter_gas is left unset and the
   * device shows a warning instead (see LocalMeterDevice.updateWarning).
   */
  async applyFields(accepted) {
    if (accepted.gasVolumeM3 !== undefined) await this.setIfChanged('meter_gas', accepted.gasVolumeM3);
    if (accepted.gasEnergyKwh !== undefined) await this.setIfChanged('gas_energy', accepted.gasEnergyKwh);
  }

}

module.exports = GlowLocalGasDevice;
