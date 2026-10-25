'use strict';

// Web API for the app settings page.

module.exports = {

  async getStatus({ homey }) {
    return homey.app.getMqttStatus();
  },

  async start({ homey }) {
    return homey.app.startMqttNow();
  },

  async stop({ homey }) {
    return homey.app.stopMqttNow();
  },

  async getDebugLog({ homey }) {
    return homey.app.getMqttDebugLog();
  },

};
