/**
 * Validates positive wire-level test vectors for PackageStatus.targeting_overlay
 * echo in static/test-vectors/media-buy/package-status-targeting-overlay-echo.json.
 *
 * Each vector's `payload` MUST validate against the declared schema, and each
 * declared `assertion` MUST resolve to the expected value. Failures here mean:
 *
 *   - PackageStatus shape drifted during schema regeneration (schema layer)
 *   - The vector file fell out of sync with the schema (vector layer)
 *
 * Downstream SDKs (adcp-client, adcp-client-python) load this same vector file
 * to validate their code generators — so changes here propagate out-of-repo.
 */
const fs = require('fs');
const path = require('path');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');
const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');

const VECTORS_PATH = path.join(
  __dirname,
  '..',
  'static',
  'test-vectors',
  'media-buy',
  'package-status-targeting-overlay-echo.json'
);
const SCHEMA_BASE_DIR = path.join(__dirname, '..', 'static', 'schemas', 'source');

async function loadExternalSchema(uri) {
  if (!uri.startsWith('/schemas/')) {
    throw new Error(`Cannot load external schema: ${uri}`);
  }
  const schemaPath = path.join(SCHEMA_BASE_DIR, uri.replace('/schemas/', ''));
  return JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
}

function resolvePath(obj, dottedPath) {
  // Supports dotted keys and [index] array access: "media_buys[0].packages[0].targeting_overlay.property_list.list_id"
  const tokens = [];
  const re = /([^.\[\]]+)|\[(\d+)\]/g;
  let match;
  while ((match = re.exec(dottedPath)) !== null) {
    tokens.push(match[1] !== undefined ? match[1] : Number(match[2]));
  }
  return tokens.reduce((acc, tok) => (acc == null ? acc : acc[tok]), obj);
}

const data = JSON.parse(fs.readFileSync(VECTORS_PATH, 'utf8'));

describe('PackageStatus targeting_overlay echo vectors', () => {
  let validate;

  before(async () => {
    const ajv = new Ajv({ allErrors: true, strict: false, loadSchema: loadExternalSchema });
    addFormats(ajv);
    const rootSchema = await loadExternalSchema(data.schema);
    validate = await ajv.compileAsync(rootSchema);
  });

  it('has a valid file structure', () => {
    assert.equal(typeof data.version, 'number', 'must have a numeric version field');
    assert.equal(data.schema, '/schemas/media-buy/get-media-buys-response.json');
    assert.ok(Array.isArray(data.vectors) && data.vectors.length > 0, 'vectors must be a non-empty array');
  });

  it('every vector has a unique kebab-case id', () => {
    const seen = new Set();
    data.vectors.forEach((v, i) => {
      assert.equal(typeof v.id, 'string', `vector at index ${i} missing id field`);
      assert.match(v.id, /^[a-z0-9]+(-[a-z0-9]+)*$/, `id "${v.id}" at index ${i} must be kebab-case`);
      assert.ok(!seen.has(v.id), `duplicate vector id: ${v.id}`);
      seen.add(v.id);
    });
  });

  for (const vector of data.vectors) {
    describe(`vector: ${vector.id}`, () => {
      it('payload validates against get-media-buys-response.json', () => {
        const ok = validate(vector.payload);
        if (!ok) {
          const errors = (validate.errors || [])
            .map(err => `${err.instancePath || 'root'}: ${err.message}`)
            .join('; ');
          assert.fail(`Schema validation failed: ${errors}`);
        }
      });

      for (const { path: p, value } of vector.assertions || []) {
        it(`echoes ${p}`, () => {
          const actual = resolvePath(vector.payload, p);
          assert.deepEqual(actual, value);
        });
      }
    });
  }

  it('covers both the specialism MUST and the general SHOULD paths', () => {
    const ids = new Set(data.vectors.map(v => v.id));
    assert.ok(ids.has('property-and-collection-list-echo'), 'specialism MUST vector required');
    assert.ok(ids.has('plain-overlay-fields-echo'), 'general SHOULD vector required');
  });
});
