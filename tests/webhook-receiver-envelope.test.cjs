const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const SCHEMA_BASE_DIR = path.join(__dirname, '..', 'static', 'schemas', 'source');
const vectorsPath = path.join(__dirname, '..', 'static', 'test-vectors', 'webhook-receiver-envelope.json');
const vectors = JSON.parse(fs.readFileSync(vectorsPath, 'utf8'));

async function loadExternalSchema(uri) {
  if (uri.startsWith('/schemas/')) {
    const [schemaUri] = uri.split('#');
    const schemaPath = path.join(SCHEMA_BASE_DIR, schemaUri.replace('/schemas/', ''));
    return JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
  }
  throw new Error(`Cannot load external schema: ${uri}`);
}

async function compileWebhookPayloadSchema() {
  const ajv = new Ajv({
    allErrors: true,
    strict: false,
    discriminator: true,
    loadSchema: loadExternalSchema,
  });
  addFormats(ajv);

  const schemaPath = path.join(SCHEMA_BASE_DIR, 'core', 'mcp-webhook-payload.json');
  return ajv.compileAsync(JSON.parse(fs.readFileSync(schemaPath, 'utf8')));
}

describe('webhook receiver envelope vectors', async () => {
  const validate = await compileWebhookPayloadSchema();

  it('has positive and negative coverage', () => {
    assert.ok(Array.isArray(vectors.positive));
    assert.ok(Array.isArray(vectors.negative));
    assert.ok(vectors.positive.length >= 1);
    assert.ok(vectors.negative.length >= 3);
  });

  for (const vector of vectors.positive) {
    it(`accepts ${vector.id}`, () => {
      assert.equal(
        validate(vector.payload),
        true,
        `expected valid webhook envelope, got ${JSON.stringify(validate.errors)}`,
      );
    });
  }

  for (const vector of vectors.negative) {
    it(`rejects ${vector.id}`, () => {
      assert.equal(validate(vector.payload), false, 'expected invalid webhook envelope');
    });
  }

  it('retry vectors preserve idempotency_key for the same event', () => {
    const byId = new Map(vectors.positive.map((vector) => [vector.id, vector]));
    for (const vector of vectors.positive.filter((item) => item.same_event_as)) {
      const original = byId.get(vector.same_event_as);
      assert.ok(original, `${vector.id} references missing vector ${vector.same_event_as}`);
      assert.equal(
        vector.payload.idempotency_key,
        original.payload.idempotency_key,
        `${vector.id} must reuse the same idempotency_key as ${vector.same_event_as}`,
      );
    }
  });

  it('delivery result vector does not include API-only aggregated_totals', () => {
    for (const vector of vectors.positive) {
      assert.equal(
        Object.hasOwn(vector.payload.result, 'aggregated_totals'),
        false,
        `${vector.id} must not emit aggregated_totals in a webhook result`,
      );
    }
  });
});
