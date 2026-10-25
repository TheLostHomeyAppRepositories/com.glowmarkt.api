'use strict';

const { normalisePrefix } = require('../glow/parse');

const DEFAULTS = {
  mode: 'builtin',
  port: 1884,
  authEnabled: false,
  username: '',
  password: '',
  externalHost: '',
  externalPort: 1883,
  externalTls: false,
  externalAllowSelfSigned: false,
  externalUsername: '',
  externalPassword: '',
  prefix: 'glow',
};

/**
 * Fills in defaults and corrects out-of-range values in stored settings.
 */
function normaliseSettings(stored) {
  const settings = { ...DEFAULTS, ...(stored || {}) };
  settings.mode = settings.mode === 'external' ? 'external' : 'builtin';
  settings.port = validPort(settings.port, 1024) ? Number(settings.port) : DEFAULTS.port;
  settings.externalPort = validPort(settings.externalPort, 1) ? Number(settings.externalPort) : DEFAULTS.externalPort;
  settings.externalHost = String(settings.externalHost || '').trim();
  settings.prefix = normalisePrefix(settings.prefix) || DEFAULTS.prefix;
  return settings;
}

function validPort(value, min) {
  const port = Number(value);
  return Number.isInteger(port) && port >= min && port <= 65535;
}

/**
 * Starts, stops and restarts the built-in broker or the external client, and
 * reports status. Messages go to `onMessage(topic, payload)`.
 *
 * States: stopped, starting, running, error. In the error state `error` holds
 * { code, port?, message }, where code is 'port_in_use', 'no_host' or
 * 'start_failed'. Operations run one at a time, in the order called.
 */
class MqttLayer {

  constructor({ onMessage, log = () => {} }) {
    this.onMessage = onMessage;
    this.log = log;
    this.state = 'stopped';
    this.error = null;
    this.settings = null;
    this.transport = null;
    this.queue = Promise.resolve();
  }

  start(settings) {
    return this.enqueue(() => this.doStart(normaliseSettings(settings)));
  }

  stop() {
    return this.enqueue(() => this.doStop());
  }

  restart(settings) {
    return this.enqueue(async () => {
      await this.doStop();
      await this.doStart(normaliseSettings(settings));
    });
  }

  isActive() {
    return this.state === 'starting' || this.state === 'running' || this.state === 'error';
  }

  enqueue(operation) {
    const next = this.queue.then(operation, operation);
    this.queue = next.catch(() => {});
    return next;
  }

  async doStart(settings) {
    if (this.state === 'running') return;
    this.settings = settings;
    this.state = 'starting';
    this.error = null;

    if (settings.mode === 'external' && !settings.externalHost) {
      this.fail({ code: 'no_host', message: 'No external broker host is set' });
      return;
    }

    try {
      this.transport = this.createTransport(settings);
      await this.transport.start();
      this.state = 'running';
      this.log(settings.mode === 'builtin'
        ? `Built-in broker listening on port ${settings.port}`
        : `External client started for ${settings.externalHost}:${settings.externalPort}`);
    } catch (error) {
      this.transport = null;
      if (error.code === 'EADDRINUSE') {
        this.fail({ code: 'port_in_use', port: settings.port, message: `Port ${settings.port} is already in use by another app; choose another port` });
      } else {
        this.fail({ code: 'start_failed', message: error.message });
      }
    }
  }

  fail(error) {
    this.state = 'error';
    this.error = error;
    this.log(`MQTT layer error: ${error.message}`);
  }

  async doStop() {
    const { transport } = this;
    this.transport = null;
    this.state = 'stopped';
    this.error = null;
    if (!transport) return;
    try {
      await transport.stop();
    } catch (error) {
      this.log(`Error while stopping: ${error.message}`);
    }
    this.log('MQTT layer stopped');
  }

  createTransport(settings) {
    const onMessage = (topic, payload) => this.onMessage(topic, payload);
    if (settings.mode === 'builtin') {
      const BuiltInBroker = require('./BuiltInBroker');
      return new BuiltInBroker({
        port: settings.port,
        prefix: settings.prefix,
        auth: { enabled: settings.authEnabled, username: settings.username, password: settings.password },
        onMessage,
        log: (message) => this.log(`Broker: ${message}`),
      });
    }
    const ExternalClient = require('./ExternalClient');
    return new ExternalClient({
      host: settings.externalHost,
      port: settings.externalPort,
      tls: settings.externalTls,
      allowSelfSigned: settings.externalAllowSelfSigned,
      username: settings.externalUsername,
      password: settings.externalPassword,
      prefix: settings.prefix,
      onMessage,
      log: (message) => this.log(`External broker: ${message}`),
    });
  }

  getStatus() {
    return {
      state: this.state,
      error: this.error,
      mode: this.settings ? this.settings.mode : null,
      transport: this.transport ? this.transport.getStatus() : null,
    };
  }

}

MqttLayer.DEFAULTS = DEFAULTS;
MqttLayer.normaliseSettings = normaliseSettings;

module.exports = MqttLayer;
