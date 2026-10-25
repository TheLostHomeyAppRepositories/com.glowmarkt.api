'use strict';

const { Driver } = require('homey');
const { authenticate, apiGet } = require('../../lib/cloud/glowmarkt');

class GlowmarktUKSmartMeter_driver extends Driver {

  /**
   * onInit is called when the driver is initialized.
   */
  async onInit() {
    this.log('Glowmarkt UK Smart Meter driver has been initialized');
    this.tariffChangedTrigger = this.homey.flow.getDeviceTriggerCard('tariff_changed');
    this.logins = new Map();
  }

  /**
   * Logs in, sharing one request between every device and poll that asks for
   * the same account at the same time. Returns the new token, or null on failure.
   */
  login(username, password) {
    if (!this.logins.has(username)) {
      const attempt = authenticate(username, password)
        .catch((error) => {
          this.error('Login failed:', error);
          return null;
        })
        .finally(() => this.logins.delete(username));
      this.logins.set(username, attempt);
    }
    return this.logins.get(username);
  }

  async onPair(session) {
    let username;
    let password;
    let token;

    session.setHandler("login", async (data) => {
      username = data.username;
      password = data.password;

      // get new auth token from API
      token = await authenticate(username, password);
      this.log('Login credentials valid: ' + Boolean(token));
      return Boolean(token);
    });

    session.setHandler("list_devices", async () => {
      // get list of resources from API
      const veidResponse = await apiGet('/virtualentity', token);
      if (!veidResponse.ok || !Array.isArray(veidResponse.body)) {
        throw new Error(`Could not list virtual entities (HTTP ${veidResponse.status})`);
      }
      const virtualEntities = veidResponse.body;

      // map the ones whose resources work to an array of devices for pairing
      const devices = [];
      for (const virtualEntity of virtualEntities) {
        try {
          const device = await this.veToDevice(virtualEntity, token, { username, password });
          if (device) devices.push(device);
        } catch (error) {
          this.log(`Skipping virtual entity ${virtualEntity.name}: ${error.message}`);
        }
      }
      this.log(`Virtual Entities: ${virtualEntities.length}, usable: ${devices.length}`);

      // finally, return the array of devices available to pair
      return devices;
    });
  }

  /**
   * Returns a pairing entry for a virtual entity, or null if its resources fail,
   * are empty, or can't be read (a stale entity lists its resources normally
   * but returns HTTP 401 on /current).
   */
  async veToDevice(virtualEntity, token, settings) {
    const resourcesResponse = await apiGet(`/virtualentity/${virtualEntity.veId}/resources`, token);
    const resources = resourcesResponse.ok ? resourcesResponse.body.resources : null;
    if (!Array.isArray(resources) || resources.length === 0) {
      this.log(`Skipping virtual entity ${virtualEntity.name}: resources failed or empty (HTTP ${resourcesResponse.status})`);
      return null;
    }

    // find a resource object in the resources array whose name property is 'electricity consumption'
    // if no such resource found, just use the first resource and hope that's right
    const elec_cons_res = resources.find((resource) => resource.name === 'electricity consumption') || resources[0];

    // check the resource can actually be read
    const current = await apiGet(`/resource/${elec_cons_res.resourceId}/current`, token);
    if (!current.ok) {
      this.log(`Skipping virtual entity ${virtualEntity.name}: its resource returned HTTP ${current.status}`);
      return null;
    }

    // create store object
    const deviceStore = { elec_cons_res: elec_cons_res.resourceId, token: token };

    // return a homey device object
    return {
      name: `${virtualEntity.name} for ${virtualEntity.postalCode}`,
      data: { id: virtualEntity.veId },
      settings,
      store: deviceStore
    };
  }

}

module.exports = GlowmarktUKSmartMeter_driver;
