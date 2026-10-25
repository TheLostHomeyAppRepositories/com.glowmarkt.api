'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const LayerSupervisor = require('../../lib/mqtt/LayerSupervisor');

const IDLE = LayerSupervisor.IDLE_STOP_MS;

test('nothing starts with no flag, devices or pairing sessions (an upgrade)', () => {
  const supervisor = new LayerSupervisor();
  assert.equal(supervisor.decide({ now: 0, localDevices: 0, running: false }), 'keep');
});

test('a local device, a pairing session or the Start now flag starts the layer', () => {
  assert.equal(new LayerSupervisor().decide({ now: 0, localDevices: 1, running: false }), 'start');

  const pairing = new LayerSupervisor();
  pairing.openSession(0);
  assert.equal(pairing.decide({ now: 0, localDevices: 0, running: false }), 'start');

  const flagged = new LayerSupervisor();
  flagged.setStartNow(true);
  assert.equal(flagged.decide({ now: 0, localDevices: 0, running: false }), 'start');
});

test('the layer stops 10 minutes after the last pairing session closes', () => {
  const supervisor = new LayerSupervisor();
  const session = supervisor.openSession(0);
  assert.equal(supervisor.decide({ now: 1000, localDevices: 0, running: true }), 'keep');
  supervisor.closeSession(session);
  assert.equal(supervisor.decide({ now: 2000, localDevices: 0, running: true }), 'keep');
  assert.equal(supervisor.decide({ now: 2000 + IDLE - 1, localDevices: 0, running: true }), 'keep');
  assert.equal(supervisor.decide({ now: 2000 + IDLE, localDevices: 0, running: true }), 'stop');
});

test('the layer stops 10 minutes after the last local device is deleted', () => {
  const supervisor = new LayerSupervisor();
  assert.equal(supervisor.decide({ now: 0, localDevices: 1, running: true }), 'keep');
  assert.equal(supervisor.decide({ now: 1000, localDevices: 0, running: true }), 'keep');
  assert.equal(supervisor.decide({ now: 1000 + IDLE, localDevices: 0, running: true }), 'stop');
});

test('becoming wanted again resets the idle countdown', () => {
  const supervisor = new LayerSupervisor();
  supervisor.decide({ now: 0, localDevices: 0, running: true });
  const session = supervisor.openSession(IDLE - 1000);
  assert.equal(supervisor.decide({ now: IDLE - 1000, localDevices: 0, running: true }), 'keep');
  supervisor.closeSession(session);
  assert.equal(supervisor.decide({ now: IDLE, localDevices: 0, running: true }), 'keep');
  assert.equal(supervisor.decide({ now: 2 * IDLE, localDevices: 0, running: true }), 'stop');
});

test('a pairing session with no disconnect and no activity for 10 minutes counts as closed', () => {
  const supervisor = new LayerSupervisor();
  const session = supervisor.openSession(0);
  supervisor.touchSession(session, 5 * 60 * 1000);
  assert.equal(supervisor.openSessions(5 * 60 * 1000 + IDLE - 1), 1);
  assert.equal(supervisor.openSessions(5 * 60 * 1000 + IDLE), 0);
});

test('the Start now flag keeps the layer running with no devices', () => {
  const supervisor = new LayerSupervisor();
  supervisor.setStartNow(true);
  assert.equal(supervisor.decide({ now: 10 * IDLE, localDevices: 0, running: true }), 'keep');
});

test('Stop stops at once when nothing else needs the layer', () => {
  const supervisor = new LayerSupervisor();
  supervisor.setStartNow(false);
  assert.equal(supervisor.decide({
    now: 0, localDevices: 0, running: true, immediate: true,
  }), 'stop');
  assert.equal(supervisor.decide({
    now: 0, localDevices: 1, running: true, immediate: true,
  }), 'keep');
});
