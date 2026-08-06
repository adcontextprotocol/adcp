const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');
const {
  assessBrandResponseAuthorization,
  canonicalizeFixtureUrl,
} = require('./helpers/reference-brand-response-authorizer.cjs');

const vectors = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'static', 'compliance', 'source', 'test-vectors', 'brand-response-signing', 'brand-authorization-cross-check.json'),
  'utf8',
));

const canonicalizationVectors = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'static', 'compliance', 'source', 'test-vectors', 'request-signing', 'canonicalization.json'),
  'utf8',
));

describe('brand response authorization cross-check vectors', () => {
  it('targets the additive 3.2 trust result', () => {
    assert.equal(vectors.version, '3.2');
    assert.ok(vectors.cases.length >= 10);
  });

  it('uses the shared AdCP URL canonicalization contract', () => {
    for (const vector of canonicalizationVectors.cases) {
      assert.equal(
        canonicalizeFixtureUrl(vector.input_url),
        vector.expected_target_uri ?? null,
        vector.name,
      );
    }
  });

  for (const vector of vectors.cases) {
    it(vector.name, () => {
      const actual = assessBrandResponseAuthorization(vector.input);
      assert.deepEqual(actual, vector.expected);
    });
  }
});
