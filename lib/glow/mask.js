'use strict';

// Masks identifiers from the Glow feed (MPAN, MPRN, EUI, supplier) to their last
// four characters for the debug log, the status panel and app logs, and UK
// postcodes in cloud device names.

const MASKED_KEYS = ['mpan', 'mprn', 'eui', 'supplier'];
const UK_POSTCODE = /\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/gi;

// Values the display sends instead of an identifier, such as "---" or
// "not available", carry nothing to hide.
function isPlaceholder(value) {
  return !/[a-z0-9]/i.test(value) || /^not available$/i.test(value);
}

function mask(value) {
  if (value === undefined || value === null) return value;
  const text = String(value);
  if (isPlaceholder(text) || text.length <= 4) return text;
  return `••••${text.slice(-4)}`;
}

/**
 * Masks identifier values in a raw payload string. Works on invalid JSON too,
 * since it matches "key":"value" pairs rather than parsing.
 */
function maskPayload(payload) {
  return String(payload).replace(
    new RegExp(`"(${MASKED_KEYS.join('|')})"\\s*:\\s*"([^"]*)"`, 'g'),
    (match, key, value) => `"${key}":"${mask(value)}"`,
  );
}

/**
 * Masks any UK postcode in a name, such as the default cloud device name
 * "<entity> for <postcode>".
 */
function maskPostcodes(text) {
  return String(text ?? '').replace(UK_POSTCODE, '••••');
}

module.exports = {
  MASKED_KEYS, isPlaceholder, mask, maskPayload, maskPostcodes,
};
