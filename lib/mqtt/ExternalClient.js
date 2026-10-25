'use strict';

const crypto = require('crypto');

const RECONNECT_MS = 10 * 1000;

/**
 * mqtt.js client to an external broker. Subscribes to `<prefix>/#` at QoS 0 and
 * reconnects every 10 s.
 */
class ExternalClient {

  constructor({
    host, port, tls = false, allowSelfSigned = false, username, password, prefix, onMessage, log = () => {},
  }) {
    this.options = {
      host, port, tls, allowSelfSigned, username, password,
    };
    this.prefix = prefix;
    this.onMessage = onMessage;
    this.log = log;
    this.client = null;
    this.connected = false;
    this.lastError = null;
  }

  async start() {
    // Load mqtt.js only when the client starts.
    const mqtt = require('mqtt');
    const {
      host, port, tls, allowSelfSigned, username, password,
    } = this.options;

    const client = mqtt.connect({
      protocol: tls ? 'mqtts' : 'mqtt',
      host,
      port,
      username: username || undefined,
      password: password || undefined,
      clientId: `homey-glowmarkt-${crypto.randomBytes(3).toString('hex')}`,
      rejectUnauthorized: !(tls && allowSelfSigned),
      reconnectPeriod: RECONNECT_MS,
      connectTimeout: RECONNECT_MS,
    });

    client.on('connect', () => {
      this.connected = true;
      this.lastError = null;
      this.log(`Connected to ${host}:${port}`);
      // mqtt.js reports a refused subscription (SUBACK 128) as an error.
      client.subscribe(`${this.prefix}/#`, { qos: 0 }, (error, granted) => {
        if (error || (granted && granted.some((g) => g.qos === 128))) {
          this.lastError = `The broker refused the subscription to ${this.prefix}/#`;
          this.log(this.lastError);
        }
      });
    });
    client.on('message', (topic, payload) => this.onMessage(topic, payload));
    client.on('error', (error) => {
      const message = error.message || error.code || String(error);
      if (/subscribe/i.test(message) && this.lastError) return;
      this.lastError = message;
      this.log(`Error: ${message}`);
    });
    client.on('close', () => {
      this.connected = false;
    });
    this.client = client;
  }

  async stop() {
    const { client } = this;
    this.client = null;
    this.connected = false;
    if (client) await client.endAsync(true);
  }

  getStatus() {
    return {
      host: this.options.host,
      port: this.options.port,
      connected: this.connected,
      lastError: this.lastError,
    };
  }

}

module.exports = ExternalClient;
