'use strict';

// Runs the real Aedes broker and mqtt.js client on spare local ports.

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const mqtt = require('mqtt');

const MqttLayer = require('../../lib/mqtt/MqttLayer');

function freePort() {
  return new Promise((resolve) => {
    const server = net.createServer().listen(0, () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function connect(port, options = {}) {
  return new Promise((resolve, reject) => {
    const client = mqtt.connect({ host: '127.0.0.1', port, reconnectPeriod: 0, ...options });
    client.once('connect', () => resolve(client));
    client.once('error', (error) => {
      client.end(true);
      reject(error);
    });
  });
}

function waitFor(check, timeout = 3000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      const value = check();
      if (value) return resolve(value);
      if (Date.now() - start > timeout) return reject(new Error('Timed out waiting'));
      return setTimeout(poll, 20);
    };
    poll();
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function layerWithInbox() {
  const inbox = [];
  const layer = new MqttLayer({ onMessage: (topic, payload) => inbox.push({ topic, payload: payload.toString() }) });
  return { layer, inbox };
}

test('settings are normalised with defaults', () => {
  const settings = MqttLayer.normaliseSettings({ port: 80, prefix: ' home/glow/# ', mode: 'nonsense' });
  assert.equal(settings.mode, 'builtin');
  assert.equal(settings.port, 1884);
  assert.equal(settings.prefix, 'home/glow');
  assert.equal(MqttLayer.normaliseSettings(undefined).prefix, 'glow');
  assert.equal(MqttLayer.normaliseSettings({ port: '2000' }).port, 2000);
});

test('built-in broker passes publishes under the prefix to the app', async () => {
  const port = await freePort();
  const { layer, inbox } = layerWithInbox();
  await layer.start({ port });
  assert.equal(layer.getStatus().state, 'running');
  assert.equal(layer.getStatus().transport.listening, true);

  const client = await connect(port);
  await client.publishAsync('glow/TEST/STATE', '{"hello":1}');
  await waitFor(() => inbox.length === 1);
  assert.deepEqual(inbox[0], { topic: 'glow/TEST/STATE', payload: '{"hello":1}' });
  assert.equal(layer.getStatus().transport.clients, 1);

  await client.endAsync();
  await layer.stop();
  assert.equal(layer.getStatus().state, 'stopped');
});

test('built-in broker refuses publishes outside the prefix', async () => {
  const port = await freePort();
  const { layer, inbox } = layerWithInbox();
  await layer.start({ port });
  const client = await connect(port);
  client.on('error', () => {});
  client.publish('other/TEST/STATE', 'x');
  await sleep(200);
  assert.equal(inbox.length, 0);
  client.end(true);
  await layer.stop();
});

test('with authentication off, anyone may connect but subscriptions are refused', async () => {
  const port = await freePort();
  const { layer } = layerWithInbox();
  await layer.start({ port });
  const client = await connect(port, { username: 'anyone', password: 'anything' });
  // mqtt.js turns SUBACK 128 into an error.
  await assert.rejects(client.subscribeAsync('glow/#'), (error) => error.packet && error.packet.granted[0] === 128);
  await client.endAsync();
  await layer.stop();
});

test('with authentication on, bad credentials are refused and good ones may subscribe', async () => {
  const port = await freePort();
  const { layer, inbox } = layerWithInbox();
  await layer.start({
    port, authEnabled: true, username: 'glow', password: 's3cret',
  });

  await assert.rejects(connect(port), /Not authorized|Bad username or password/);
  await assert.rejects(connect(port, { username: 'glow', password: 'wrong' }), /Not authorized|Bad username or password/);

  const subscriber = await connect(port, { username: 'glow', password: 's3cret' });
  const granted = await subscriber.subscribeAsync('glow/#');
  assert.equal(granted[0].qos, 0);
  const received = [];
  subscriber.on('message', (topic) => received.push(topic));

  const publisher = await connect(port, { username: 'glow', password: 's3cret' });
  await publisher.publishAsync('glow/TEST/SENSOR/gasmeter', '{}');
  await waitFor(() => received.length === 1 && inbox.length === 1);

  await Promise.all([subscriber.endAsync(), publisher.endAsync()]);
  await layer.stop();
});

test('retained messages are not kept', async () => {
  const port = await freePort();
  const { layer } = layerWithInbox();
  await layer.start({
    port, authEnabled: true, username: 'u', password: 'p',
  });
  const publisher = await connect(port, { username: 'u', password: 'p' });
  await publisher.publishAsync('glow/TEST/STATE', 'kept?', { retain: true });
  await publisher.endAsync();

  const subscriber = await connect(port, { username: 'u', password: 'p' });
  const received = [];
  subscriber.on('message', (topic) => received.push(topic));
  await subscriber.subscribeAsync('glow/#');
  await sleep(200);
  assert.equal(received.length, 0);
  await subscriber.endAsync();
  await layer.stop();
});

test('a port in use becomes an error state, not an exception, and a restart recovers', async () => {
  const port = await freePort();
  const blocker = net.createServer().listen(port);
  await new Promise((resolve) => blocker.once('listening', resolve));

  const { layer } = layerWithInbox();
  await layer.start({ port });
  const status = layer.getStatus();
  assert.equal(status.state, 'error');
  assert.equal(status.error.code, 'port_in_use');
  assert.match(status.error.message, new RegExp(`Port ${port} is already in use`));

  const otherPort = await freePort();
  await layer.restart({ port: otherPort });
  assert.equal(layer.getStatus().state, 'running');
  assert.equal(layer.getStatus().transport.port, otherPort);

  await layer.stop();
  await new Promise((resolve) => blocker.close(resolve));
});

test('stopping closes the port', async () => {
  const port = await freePort();
  const { layer } = layerWithInbox();
  await layer.start({ port });
  await layer.stop();
  await assert.rejects(connect(port), /ECONNREFUSED/);
});

test('external mode subscribes to <prefix>/# on another broker', async () => {
  const port = await freePort();
  const broker = new MqttLayer({ onMessage: () => {} });
  await broker.start({
    port, authEnabled: true, username: 'u', password: 'p',
  });

  const { layer, inbox } = layerWithInbox();
  await layer.start({
    mode: 'external', externalHost: '127.0.0.1', externalPort: port, externalUsername: 'u', externalPassword: 'p', prefix: 'glow',
  });
  await waitFor(() => layer.getStatus().transport.connected);
  await sleep(100);

  const publisher = await connect(port, { username: 'u', password: 'p' });
  await publisher.publishAsync('glow/TEST/STATE', '{}');
  await publisher.publishAsync('elsewhere/TEST/STATE', '{}').catch(() => {});
  await waitFor(() => inbox.length === 1);
  assert.equal(inbox[0].topic, 'glow/TEST/STATE');

  publisher.end(true);
  await layer.stop();
  await broker.stop();
});

test('external mode reports a refused subscription and connection errors', async () => {
  const port = await freePort();
  const broker = new MqttLayer({ onMessage: () => {} });
  await broker.start({ port });

  const { layer } = layerWithInbox();
  await layer.start({ mode: 'external', externalHost: '127.0.0.1', externalPort: port });
  await waitFor(() => layer.getStatus().transport.lastError);
  assert.match(layer.getStatus().transport.lastError, /refused the subscription/);
  await layer.stop();
  await broker.stop();

  const closedPort = await freePort();
  await layer.start({ mode: 'external', externalHost: '127.0.0.1', externalPort: closedPort });
  await waitFor(() => layer.getStatus().transport.lastError);
  assert.equal(layer.getStatus().transport.connected, false);
  await layer.stop();
});

test('external mode with no host is an error state', async () => {
  const { layer } = layerWithInbox();
  await layer.start({ mode: 'external' });
  assert.equal(layer.getStatus().state, 'error');
  assert.equal(layer.getStatus().error.code, 'no_host');
});
