'use strict';

const crypto = require('crypto');
const net = require('net');

/**
 * Aedes on a plain TCP server. In memory only: nothing persisted, nothing
 * retained.
 *
 * - With authentication off, any client may connect and publish. With it on,
 *   clients must present the configured username and password.
 * - Subscriptions are refused unless authentication is on and the client has
 *   authenticated, so nobody on the LAN can read meter data from an open broker.
 * - Publishes are allowed only under `<prefix>/`.
 *
 * Messages reach the app through Aedes's own publish event, not a loopback client.
 */
class BuiltInBroker {

  constructor({
    port, prefix, auth = {}, onMessage, log = () => {},
  }) {
    this.port = port;
    this.prefix = prefix;
    this.auth = { enabled: Boolean(auth.enabled), username: auth.username || '', password: auth.password || '' };
    this.onMessage = onMessage;
    this.log = log;
    this.aedes = null;
    this.server = null;
  }

  async start() {
    // Aedes 1.x is an ES module; load it only when the broker starts.
    const { Aedes } = await import('aedes');
    const aedes = await Aedes.createBroker();
    aedes.authenticate = this.authenticate.bind(this);
    aedes.authorizeSubscribe = this.authorizeSubscribe.bind(this);
    aedes.authorizePublish = this.authorizePublish.bind(this);
    aedes.on('publish', (packet, client) => {
      if (!client || packet.topic.startsWith('$SYS')) return;
      this.onMessage(packet.topic, packet.payload);
    });
    aedes.on('clientError', (client, error) => this.log(`Client ${client && client.id} error: ${error.message}`));
    this.aedes = aedes;

    const server = net.createServer(aedes.handle);
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(this.port, () => {
          server.removeListener('error', reject);
          resolve();
        });
      });
    } catch (error) {
      await closeAedes(aedes);
      this.aedes = null;
      throw error;
    }
    server.on('error', (error) => this.log(`Server error: ${error.message}`));
    this.server = server;
  }

  async stop() {
    const { aedes, server } = this;
    this.aedes = null;
    this.server = null;
    if (aedes) await closeAedes(aedes);
    if (server) await new Promise((resolve) => server.close(() => resolve()));
  }

  authenticate(client, username, password, callback) {
    if (!this.auth.enabled) return callback(null, true);
    const ok = safeEqual(username, this.auth.username) && safeEqual(password, this.auth.password);
    if (!ok) {
      const error = new Error('Bad username or password');
      error.returnCode = 4;
      return callback(error, false);
    }
    client.glowAuthenticated = true;
    return callback(null, true);
  }

  authorizeSubscribe(client, subscription, callback) {
    // A null subscription is refused with SUBACK 128, without dropping the client.
    const allowed = this.auth.enabled && client && client.glowAuthenticated === true;
    callback(null, allowed ? subscription : null);
  }

  authorizePublish(client, packet, callback) {
    if (!packet.topic.startsWith(`${this.prefix}/`)) {
      return callback(new Error(`Publishing is only allowed under ${this.prefix}/`));
    }
    packet.retain = false;
    return callback(null);
  }

  getStatus() {
    return {
      listening: Boolean(this.server && this.server.listening),
      port: this.port,
      clients: this.aedes ? this.aedes.connectedClients : 0,
    };
  }

}

function closeAedes(aedes) {
  return new Promise((resolve) => aedes.close(() => resolve()));
}

// Compares hashes so neither the length nor the content leaks through timing.
function safeEqual(given, expected) {
  const hash = (value) => crypto.createHash('sha256').update(value === undefined || value === null ? '' : value).digest();
  return crypto.timingSafeEqual(hash(given), hash(expected)) && given !== undefined && given !== null;
}

module.exports = BuiltInBroker;
