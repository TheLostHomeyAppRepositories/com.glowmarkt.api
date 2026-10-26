'use strict';

// Looks up keys in locales/en.json the way this.homey.__ does, including
// __token__ replacement.

const locale = require('../../locales/en.json');

function translate(key, tokens = {}) {
  const text = key.split('.').reduce((node, part) => (node ? node[part] : undefined), locale);
  if (typeof text !== 'string') return key;
  return text.replace(/__(\w+)__/g, (match, name) => (tokens[name] !== undefined ? tokens[name] : match));
}

module.exports = { translate };
