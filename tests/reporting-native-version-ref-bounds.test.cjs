const fs = require('fs');
const path = require('path');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { resolveRefs } = require('../scripts/build-schemas.cjs');

const SCHEMA_ROOT = path.join(__dirname, '..', 'static', 'schemas', 'source');
const NATIVE_VERSION_REF = '/schemas/core/reporting-native-version-ref.json';
const FILE_OBJECT_REF = '/schemas/core/reporting-file-object-ref.json';

function readSchema(uri) {
  assert.match(uri, /^\/schemas\//);
  return JSON.parse(fs.readFileSync(path.join(SCHEMA_ROOT, uri.slice('/schemas/'.length)), 'utf8'));
}

async function compile(uri) {
  const ajv = new Ajv({ allErrors: true, strict: false, loadSchema: async ref => readSchema(ref) });
  addFormats(ajv);
  return ajv.compileAsync(readSchema(uri));
}

function resolveSchema(uri) {
  const schemaPath = path.join(SCHEMA_ROOT, uri.slice('/schemas/'.length));
  return resolveRefs(structuredClone(readSchema(uri)), SCHEMA_ROOT, new Set([schemaPath]));
}

// These fixtures use every character in the +/= cycle. Each one is exactly
// 1,024 UTF-8 bytes and expands to 3,072 characters when URI encoded.
const MAX_S3_KEY = '+/='.repeat(341) + '+';
const MAX_S3_VERSION_ID = '+/='.repeat(341) + '/';

describe('reporting native version and object references', () => {
  it('uses unadorned shared schemas for each repeated reporting reference surface', () => {
    const fileEntry = readSchema('/schemas/core/reporting-file-entry.json');
    const resource = readSchema('/schemas/core/reporting-resource.json');
    const verification = readSchema('/schemas/core/reporting-verification.json');
    const receipt = readSchema('/schemas/core/reporting-receipt.json');

    const nativeVersionReferences = [
      fileEntry.properties.native_version_ref,
      resource.properties.native_version_ref,
      verification.properties.native_commit_evidence.properties.native_version_ref,
      receipt.properties.observed_native_version_ref,
    ];
    for (const reference of nativeVersionReferences) {
      assert.deepEqual(reference, { $ref: NATIVE_VERSION_REF });
    }

    assert.deepEqual(fileEntry.properties.object_ref, { $ref: FILE_OBJECT_REF });
    for (const physicalCheck of verification.properties.physical_checksums.items.oneOf) {
      assert.deepEqual(physicalCheck.properties.object_ref, { $ref: FILE_OBJECT_REF });
    }
  });

  it('keeps canonical shared descriptions and constraints after bundler reference resolution', () => {
    const nativeVersion = readSchema(NATIVE_VERSION_REF);
    const fileObject = readSchema(FILE_OBJECT_REF);
    const resolvedFileEntry = resolveSchema('/schemas/core/reporting-file-entry.json');
    const resolvedResource = resolveSchema('/schemas/core/reporting-resource.json');
    const resolvedVerification = resolveSchema('/schemas/core/reporting-verification.json');
    const resolvedReceipt = resolveSchema('/schemas/core/reporting-receipt.json');

    const resolvedNativeVersions = [
      resolvedFileEntry.properties.native_version_ref,
      resolvedResource.properties.native_version_ref,
      resolvedVerification.properties.native_commit_evidence.properties.native_version_ref,
      resolvedReceipt.properties.observed_native_version_ref,
    ];
    for (const resolved of resolvedNativeVersions) {
      assert.equal(resolved.description, nativeVersion.description);
      assert.equal(resolved.type, nativeVersion.type);
      assert.equal(resolved.minLength, nativeVersion.minLength);
      assert.equal(resolved.maxLength, nativeVersion.maxLength);
    }

    const resolvedObjectReferences = [
      resolvedFileEntry.properties.object_ref,
      ...resolvedVerification.properties.physical_checksums.items.oneOf
        .map(physicalCheck => physicalCheck.properties.object_ref),
    ];
    for (const resolved of resolvedObjectReferences) {
      assert.equal(resolved.description, fileObject.description);
      assert.equal(resolved.type, fileObject.type);
      assert.equal(resolved.minLength, fileObject.minLength);
      assert.equal(resolved.maxLength, fileObject.maxLength);
    }
  });

  it('accepts maximum-length S3 keys and VersionIds without URI concatenation', async () => {
    assert.equal(Buffer.byteLength(MAX_S3_KEY), 1024);
    assert.equal(Buffer.byteLength(MAX_S3_VERSION_ID), 1024);
    assert.equal(MAX_S3_KEY.length, 1024);
    assert.equal(MAX_S3_VERSION_ID.length, 1024);
    assert.equal(encodeURIComponent(MAX_S3_KEY).length, 3072);
    assert.equal(encodeURIComponent(MAX_S3_VERSION_ID).length, 3072);

    const [validateFileEntry, validateResource, validateVerification, validateReceipt] = await Promise.all([
      compile('/schemas/core/reporting-file-entry.json'),
      compile('/schemas/core/reporting-resource.json'),
      compile('/schemas/core/reporting-verification.json'),
      compile('/schemas/core/reporting-receipt.json'),
    ]);

    assert.equal(validateFileEntry({
      object_ref: MAX_S3_KEY,
      native_version_ref: MAX_S3_VERSION_ID,
      size_bytes: 0,
      sha256: 'a'.repeat(64),
      row_count: 0,
    }), true, JSON.stringify(validateFileEntry.errors));
    assert.equal(validateResource({
      resource_ref: 'resource_max_s3_version',
      kind: 'manifest',
      location: 'reports/manifest.json',
      native_version_ref: MAX_S3_VERSION_ID,
      manifest_version: '1.0',
      manifest_sha256: 'a'.repeat(64),
      immutability: 'native_version',
      expires_at: '2026-10-01T00:00:00Z',
    }), true, JSON.stringify(validateResource.errors));
    assert.equal(validateVerification({
      verified_at: '2026-09-04T00:00:00Z',
      verification_path: 'representative_consumer',
      verification_profile: 'native_commit',
      row_count: 0,
      control_totals: [],
      native_commit_evidence: {
        native_version_ref: MAX_S3_VERSION_ID,
        observed_through: 'representative_consumer',
      },
    }), true, JSON.stringify(validateVerification.errors));
    assert.equal(validateReceipt({
      reporting_receipt_id: 'receipt_max_s3_version',
      reporting_obligation_id: 'obligation_max_s3_version',
      reporting_revision_id: 'revision_max_s3_version',
      reporting_materialization_id: 'materialization_max_s3_version',
      status: 'accepted',
      verification_profile: 'native_commit',
      observed_row_count: 0,
      observed_control_totals: [],
      observed_native_version_ref: MAX_S3_VERSION_ID,
      observed_at: '2026-09-04T00:00:00Z',
    }), true, JSON.stringify(validateReceipt.errors));
  });

  it('rejects values beyond the shared 1,024-character bounds', async () => {
    const [validateFileEntry, validateResource] = await Promise.all([
      compile('/schemas/core/reporting-file-entry.json'),
      compile('/schemas/core/reporting-resource.json'),
    ]);

    assert.equal(validateFileEntry({
      object_ref: `${MAX_S3_KEY}+`,
      size_bytes: 0,
      sha256: 'a'.repeat(64),
      row_count: 0,
    }), false);
    assert.equal(validateResource({
      resource_ref: 'resource_oversized_s3_version',
      kind: 'dataset',
      location: 'reports/dataset',
      native_version_ref: `${MAX_S3_VERSION_ID}/`,
      immutability: 'native_version',
      expires_at: '2026-10-01T00:00:00Z',
    }), false);
  });
});
