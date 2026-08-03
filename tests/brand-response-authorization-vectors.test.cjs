const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');
const {
  assessBrandResponseAuthorization,
} = require('./helpers/reference-brand-response-authorizer.cjs');

const vectors = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'static', 'compliance', 'source', 'test-vectors', 'brand-response-signing', 'brand-authorization-cross-check.json'),
  'utf8',
));

describe('brand response authorization cross-check vectors', () => {
  it('targets the additive 3.2 trust result', () => {
    assert.equal(vectors.version, '3.2');
    assert.ok(vectors.cases.length >= 6);
  });

  for (const vector of vectors.cases) {
    it(vector.name, () => {
      const actual = assessBrandResponseAuthorization(vector.input);
      assert.deepEqual(actual, vector.expected);
    });
  }
});
