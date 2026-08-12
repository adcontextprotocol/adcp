const assert = require('node:assert/strict');
const test = require('node:test');
const {
  missingPublishedVersions,
  packagedComplianceVersions,
  validateManifest,
} = require('../scripts/check-published-compliance-versions.cjs');

test('extracts compliance cache versions from an SDK package listing', () => {
  const versions = packagedComplianceVersions([
    'package/compliance/cache/3.1.11/index.json',
    'package/compliance/cache/3.1.11.previous/index.json',
    'package/compliance/cache/3.1.0-beta.7/index.json',
    'package/compliance/cache/latest/index.json',
  ].join('\n'));

  assert.deepEqual([...versions], ['3.1.11', '3.1.0-beta.7']);
});

test('reports a newly published cache missing from the manifest', () => {
  assert.deepEqual(
    missingPublishedVersions(['3.1.11'], new Set(['3.1.11', '3.1.12'])),
    ['3.1.12'],
  );
});

test('rejects duplicate or malformed publication metadata', () => {
  assert.throws(() => validateManifest({
    schema_version: 1,
    npm_tags: ['rc', 'rc'],
    published_versions: ['3.1.11'],
  }), /npm_tags entries must be unique/);

  assert.throws(() => validateManifest({
    schema_version: 1,
    npm_tags: ['rc'],
    published_versions: ['latest'],
  }), /Invalid compliance versions/);
});
