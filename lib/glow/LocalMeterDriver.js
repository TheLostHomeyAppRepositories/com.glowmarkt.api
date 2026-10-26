'use strict';

const { Driver } = require('homey');

/**
 * Shared behaviour of the local gas and electricity meter drivers: flow
 * conditions, and pairing through one custom view that waits for the display,
 * lists its units and adds the chosen ones.
 *
 * Subclasses set `kind` ('gasmeter' or 'electricitymeter').
 */
class LocalMeterDriver extends Driver {

  async onInit() {
    this.homey.flow.getConditionCard(`${this.id}_is_reporting`)
      .registerRunListener(({ device }) => device.isReporting());
    this.homey.flow.getConditionCard(`${this.id}_link_connected`)
      .registerRunListener(({ device }) => device.isLinkConnected());
  }

  async onPair(session) {
    const { app } = this.homey;
    // Opening pairing starts the MQTT layer if it isn't running.
    const sessionId = await app.openPairingSession();

    session.setHandler('pairing_state', async () => {
      app.touchPairingSession(sessionId);
      return this.pairingState();
    });
    session.setHandler('disconnect', async () => {
      await app.closePairingSession(sessionId);
    });
  }

  /**
   * What the pairing view shows: the layer's state, what to enter on the
   * display, and the units that have sent this meter kind but have no device
   * of this kind yet.
   */
  async pairingState() {
    const { app } = this.homey;
    const status = await app.getMqttStatus();
    const paired = new Set(this.getDevices().map((device) => device.getData().unitId));
    const seen = app.registry ? app.registry.unitsWithKind(this.kind) : [];

    return {
      kind: this.kind,
      layer: { state: status.state, error: status.error ? status.error.message : null },
      connection: app.getConnectionDetails(status.address),
      seen: seen.length,
      units: seen.filter((unit) => !paired.has(unit.unitId)).map((unit) => this.pairingEntry(unit)),
    };
  }

  pairingEntry(unit) {
    const gas = this.kind === 'gasmeter';
    const meter = unit.meters[this.kind];
    const meterId = gas ? meter.meta.mprn : meter.meta.mpan;
    const latest = gas ? formatGas(meter.latest.gasVolumeM3) : formatPower(meter.latest.powerKw);

    return {
      device: {
        name: this.homey.__(`pair.${this.kind}.deviceName`),
        data: { unitId: unit.unitId, kind: this.kind },
        settings: {
          unit_id: unit.unitId,
          meter_id: meterId || '',
          hardware: unit.info.hardware || '',
          software: unit.info.software || '',
        },
      },
      description: [
        `${this.homey.__(`pair.${this.kind}.meterId`)} ${meterId || this.homey.__('pair.notReported')}`,
        latest,
      ].filter(Boolean).join(' · '),
      warning: gas && meter.hasVolume === false ? this.homey.__('pair.noGasVolume') : null,
    };
  }

}

function formatGas(m3) {
  return typeof m3 === 'number' ? `${m3.toFixed(3)} m³` : null;
}

function formatPower(kw) {
  return typeof kw === 'number' ? `${Math.round(kw * 1000)} W` : null;
}

module.exports = LocalMeterDriver;
