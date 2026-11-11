'use strict';

/**
 * Reference `terms_digest` over a commercial_terms object: SHA-256 of the RFC
 * 8785 (JCS) serialization, base64url, prefixed `sha256:`.
 */

const crypto = require('node:crypto');
const { canonicalize } = require('@adcp/sdk');

function jcs(value) {
  return canonicalize(value);
}

function termsDigest(commercialTerms) {
  return `sha256:${crypto.createHash('sha256').update(jcs(commercialTerms), 'utf8').digest('base64url')}`;
}

module.exports = { jcs, termsDigest };
