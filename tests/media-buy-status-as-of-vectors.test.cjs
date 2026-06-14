/**
 * Validates positive wire-level test vectors for media_buys[].status_as_of
 * in static/test-vectors/media-buy/status-as-of.json.
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
  'status-as-of.json'
);
const SCHEMA_BASE_DIR = path.join(__dirname, '..', 'static', 'schemas', 'source');

async function loadExternalSchema(uri) {
  if (!uri.startsWith('/schemas/')) {
    throw new Error(`Cannot load external schema: ${uri}`);
  }
  const schemaPath = path.resolve(SCHEMA_BASE_DIR, uri.replace('/schemas/', ''));
  if (schemaPath !== SCHEMA_BASE_DIR && !schemaPath.startsWith(SCHEMA_BASE_DIR + path.sep)) {
    throw new Error(`Schema ref escapes base directory: ${uri}`);
  }
  return JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
}

function resolvePath(obj, dottedPath) {
  const tokens = [];
  const re = /([^.\[\]]+)|\[(\d+)\]/g;
  let match;
  while ((match = re.exec(dottedPath)) !== null) {
    tokens.push(match[1] !== undefined ? match[1] : Number(match[2]));
  }
  return tokens.reduce((acc, tok) => (acc == null ? acc : acc[tok]), obj);
}

const data = JSON.parse(fs.readFileSync(VECTORS_PATH, 'utf8'));

describe('media_buys[].status_as_of vectors', () => {
  let validate;
  let rootSchema;

  before(async () => {
    const ajv = new Ajv({ allErrors: true, strict: false, discriminator: true, loadSchema: loadExternalSchema });
    addFormats(ajv);
    rootSchema = await loadExternalSchema(data.schema);
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

  it('GetMediaBuysResponseMediaBuy declares status_as_of as nullable date-time', () => {
    const mediaBuySchema = rootSchema.properties.media_buys.items;
    const statusAsOf = mediaBuySchema.properties.status_as_of;
    assert.ok(statusAsOf, 'media_buys.items.properties.status_as_of must be declared');
    assert.deepEqual(statusAsOf.type, ['string', 'null']);
    assert.equal(statusAsOf.format, 'date-time');
    assert.ok(
      !mediaBuySchema.required.includes('status_as_of'),
      'status_as_of must remain optional'
    );
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

      for (const { path: p, value, absent } of vector.assertions || []) {
        it(`${absent ? 'omits' : 'carries'} ${p}`, () => {
          const actual = resolvePath(vector.payload, p);
          if (absent) {
            assert.equal(actual, undefined, `path ${p} should be absent in payload`);
            return;
          }
          assert.notEqual(actual, undefined, `path ${p} did not resolve in payload`);
          assert.deepEqual(actual, value);
        });
      }
    });
  }

  it('covers timestamp, null, and omitted freshness states', () => {
    const ids = new Set(data.vectors.map(v => v.id));
    assert.ok(ids.has('cached-rollup-status'), 'timestamp vector required');
    assert.ok(ids.has('live-status-null-freshness'), 'null vector required');
    assert.ok(ids.has('freshness-omitted'), 'omitted vector required');
  });
});
