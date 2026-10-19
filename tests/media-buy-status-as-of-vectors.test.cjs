/**
 * Validates positive wire-level test vectors for media_buys[].status_as_of
 * and creative state freshness (creative_assignments_as_of,
 * approval_status_as_of, status_as_of on list_creatives) in
 * static/test-vectors/media-buy/status-as-of.json.
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

describe('get_media_buys status_as_of and creative state freshness vectors', () => {
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

  it('creative state freshness fields are optional, non-nullable date-time', async () => {
    const listCreatives = await loadExternalSchema('/schemas/creative/list-creatives-response.json');
    const packageSchema = rootSchema.properties.media_buys.items.properties.packages.items;
    const approvalSchema = packageSchema.properties.creative_approvals.items;
    const creativeSchema = listCreatives.properties.creatives.items;
    const assignmentSchema = creativeSchema.properties.assignments.properties.assigned_packages.items;
    const fields = [
      ['packages[].creative_assignments_as_of', packageSchema, 'creative_assignments_as_of'],
      ['creative_approvals[].approval_status_as_of', approvalSchema, 'approval_status_as_of'],
      ['list_creatives creatives[].status_as_of', creativeSchema, 'status_as_of'],
      ['list_creatives assigned_packages[].approval_status_as_of', assignmentSchema, 'approval_status_as_of'],
    ];
    for (const [label, schema, name] of fields) {
      const field = schema.properties[name];
      assert.ok(field, `${label} must be declared`);
      assert.equal(field.type, 'string', `${label} must not be nullable`);
      assert.equal(field.format, 'date-time');
      assert.equal(field['x-added-in'], '3.3.0');
      assert.ok(!(schema.required || []).includes(name), `${label} must remain optional`);
    }
  });

  it('rejects null creative state freshness values', () => {
    const base = data.vectors.find(v => v.id === 'creative-state-freshness');
    const nullAssignments = structuredClone(base.payload);
    nullAssignments.media_buys[0].packages[0].creative_assignments_as_of = null;
    assert.equal(validate(nullAssignments), false, 'null creative_assignments_as_of must be rejected');
    const nullApproval = structuredClone(base.payload);
    nullApproval.media_buys[0].packages[0].creative_approvals[0].approval_status_as_of = null;
    assert.equal(validate(nullApproval), false, 'null approval_status_as_of must be rejected');
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
    assert.ok(ids.has('creative-state-freshness'), 'creative state freshness vector required');
  });
});
