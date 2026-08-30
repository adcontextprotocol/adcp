const fs = require('fs');
const path = require('path');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');
const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');

const SCHEMA_ROOT = path.join(__dirname, '..', 'static', 'schemas', 'source');

function readSchema(uri) {
  assert.match(uri, /^\/schemas\//);
  return JSON.parse(fs.readFileSync(path.join(SCHEMA_ROOT, uri.slice('/schemas/'.length)), 'utf8'));
}

async function compile(uri) {
  const ajv = new Ajv({
    allErrors: true,
    strict: false,
    loadSchema: async ref => readSchema(ref),
  });
  addFormats(ajv);
  return ajv.compileAsync(readSchema(uri));
}

describe('audience source references', () => {
  let validate;

  before(async () => {
    validate = await compile('/schemas/core/audience-source.json');
  });

  it('accepts a dataset source with optional access expiry', () => {
    assert.equal(validate({
      kind: 'dataset',
      vendor: { domain: 'data-cloud.example' },
      locator: 'ACMECORP.AUDIENCES.HIGH_VALUE_V3',
      access_expires_at: '2026-12-01T00:00:00Z',
    }), true, JSON.stringify(validate.errors));
  });

  it('accepts a Databricks shared-object locator independently of recipient identity', () => {
    assert.equal(validate({
      kind: 'dataset',
      vendor: { domain: 'data-cloud.example' },
      locator: 'share://aws:us-east-1:provider-uuid/acme_audiences/suppression.high_value_v3',
    }), true, JSON.stringify(validate.errors));
  });

  it('accepts a platform segment source', () => {
    assert.equal(validate({
      kind: 'platform_segment',
      vendor: { domain: 'activation-hub.example' },
      segment_ref: 'seg_88213',
    }), true, JSON.stringify(validate.errors));
  });

  it('rejects cross-kind fields', () => {
    assert.equal(validate({
      kind: 'dataset',
      vendor: { domain: 'data-cloud.example' },
      locator: 'ACMECORP.AUDIENCES.HIGH_VALUE_V3',
      segment_ref: 'seg_88213',
    }), false);

    assert.equal(validate({
      kind: 'platform_segment',
      vendor: { domain: 'activation-hub.example' },
      segment_ref: 'seg_88213',
      access_expires_at: '2026-12-01T00:00:00Z',
    }), false);
  });

  it('requires the kind-specific reference', () => {
    assert.equal(validate({
      kind: 'dataset',
      vendor: { domain: 'data-cloud.example' },
    }), false);

    assert.equal(validate({
      kind: 'platform_segment',
      vendor: { domain: 'activation-hub.example' },
    }), false);
  });

  it('rejects unknown kinds', () => {
    assert.equal(validate({
      kind: 'file',
      vendor: { domain: 'data-cloud.example' },
      locator: 's3://bucket/prefix',
    }), false);
  });

  it('validates every schema example against exactly one branch', () => {
    const schema = readSchema('/schemas/core/audience-source.json');
    for (const example of schema.examples) {
      assert.equal(validate(example), true, JSON.stringify(validate.errors));
    }
  });
});

describe('sync_audiences request with sources', () => {
  let validate;

  before(async () => {
    validate = await compile('/schemas/media-buy/sync-audiences-request.json');
  });

  const base = {
    idempotency_key: 'a-sufficiently-long-key-0001',
    account: { account_id: 'acct_12345' },
  };

  it('accepts a sourced audience', () => {
    assert.equal(validate({
      ...base,
      audiences: [{
        audience_id: 'high_value_customers',
        source: {
          kind: 'dataset',
          vendor: { domain: 'data-cloud.example' },
          locator: 'ACMECORP.AUDIENCES.HIGH_VALUE_V3',
        },
      }],
    }), true, JSON.stringify(validate.errors));
  });

  it('rejects source combined with member deltas', () => {
    const source = {
      kind: 'dataset',
      vendor: { domain: 'data-cloud.example' },
      locator: 'ACMECORP.AUDIENCES.HIGH_VALUE_V3',
    };
    const member = { external_id: 'crm_1001', hashed_email: 'a'.repeat(64) };

    assert.equal(validate({
      ...base,
      audiences: [{ audience_id: 'a1', source, add: [member] }],
    }), false);

    assert.equal(validate({
      ...base,
      audiences: [{ audience_id: 'a1', source, remove: [member] }],
    }), false);
  });
});

describe('sync_audiences response with source echo', () => {
  let validate;

  before(async () => {
    validate = await compile('/schemas/media-buy/sync-audiences-response.json');
  });

  it('accepts a ready sourced audience with last_synced_at and source health', () => {
    assert.equal(validate({
      status: 'completed',
      audiences: [{
        audience_id: 'high_value_customers',
        action: 'unchanged',
        status: 'ready',
        matched_count: 18750,
        last_synced_at: '2026-08-25T06:00:00Z',
        source: {
          kind: 'dataset',
          vendor: { domain: 'data-cloud.example' },
          locator: 'ACMECORP.AUDIENCES.HIGH_VALUE_V3',
          columns_read: ['external_id', 'hashed_email'],
          access_status: 'active',
        },
      }],
    }), true, JSON.stringify(validate.errors));
  });

  it('requires last_synced_at once a sourced audience reports counts', () => {
    assert.equal(validate({
      status: 'completed',
      audiences: [{
        audience_id: 'high_value_customers',
        action: 'unchanged',
        status: 'ready',
        matched_count: 18750,
        source: {
          kind: 'dataset',
          vendor: { domain: 'data-cloud.example' },
          locator: 'ACMECORP.AUDIENCES.HIGH_VALUE_V3',
        },
      }],
    }), false);
  });

  it('allows a sourced audience in processing before its first read', () => {
    assert.equal(validate({
      status: 'completed',
      audiences: [{
        audience_id: 'incoming_segment',
        action: 'created',
        status: 'processing',
        source: {
          kind: 'platform_segment',
          vendor: { domain: 'activation-hub.example' },
          segment_ref: 'seg_88213',
        },
      }],
    }), true, JSON.stringify(validate.errors));
  });
});

describe('SOURCE_ACCESS_FAILED error code', () => {
  it('is present on both enum surfaces with retryability metadata', () => {
    const schema = readSchema('/schemas/enums/error-code.json');
    assert.ok(schema.enum.includes('SOURCE_ACCESS_FAILED'));
    assert.ok(schema.enumDescriptions.SOURCE_ACCESS_FAILED.length > 0);
    assert.equal(schema.enumMetadata.SOURCE_ACCESS_FAILED.recovery, 'correctable');
    assert.match(schema.enumMetadata.SOURCE_ACCESS_FAILED.suggestion, /error\.field/);
  });
});
