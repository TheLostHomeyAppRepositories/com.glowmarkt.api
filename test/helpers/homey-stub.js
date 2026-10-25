'use strict';

// Stands in for the 'homey' module, which only exists on a Homey, so app and
// driver code can be loaded in tests. Require this before the code under test.

const Module = require('module');

const stub = {
  App: class App {},
  Driver: class Driver {},
  Device: class Device {},
};

const originalResolve = Module._resolveFilename;
Module._resolveFilename = function resolve(request, ...rest) {
  return request === 'homey' ? 'homey-stub' : originalResolve.call(this, request, ...rest);
};
require.cache['homey-stub'] = {
  id: 'homey-stub', filename: 'homey-stub', loaded: true, exports: stub,
};

module.exports = stub;
