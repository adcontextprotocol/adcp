/**
 * Validates static/test-vectors/product/property-coverage-disclosure.json
 * against the legacy Product and compact canonical Product schemas. SDKs load
 * the same vector file to check their validators and codegen output.
 */
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const REPO_ROOT = path.join(__dirname, '..');
const SCHEMA_ROOT = path.join(REPO_ROOT, 'static', 'schemas', 'source');
const vectors = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, 'static', 'test-vectors', 'product', 'property-coverage-disclosure.json'), 'utf8'),
);

function loadSchema(uri) {
  if (!uri.startsWith('/schemas/')) throw new Error(`Unexpected schema URI: ${uri}`);
  return JSON.parse(fs.readFileSync(path.join(SCHEMA_ROOT, uri.slice('/schemas/'.length)), 'utf8'));
}

function mergePatch(target, patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return structuredClone(patch);
  const out = target !== null && typeof target === 'object' && !Array.isArray(target) ? { ...target } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete out[key];
    else out[key] = mergePatch(out[key], value);
  }
  return out;
}

async function compile(uri) {
  const ajv = new Ajv({ allErrors: true, strict: false, discriminator: true, loadSchema: async (u) => loadSchema(u) });
  addFormats(ajv);
  return ajv.compileAsync(loadSchema(uri));
}

test('property coverage vectors are well formed', () => {
  assert.ok(vectors.vectors.length > 0);
  const ids = vectors.vectors.map((v) => v.id);
  assert.equal(new Set(ids).size, ids.length, 'vector ids must be unique');
  for (const v of vectors.vectors) {
    assert.equal(typeof v.valid, 'boolean', `${v.id}: valid must be boolean`);
    for (const uri of v.schemas ?? []) assert.ok(vectors.product_schemas.includes(uri), `${v.id}: unknown schema ${uri}`);
  }
});

test('the base product is valid under both product schemas', async () => {
  for (const uri of vectors.product_schemas) {
    const validate = await compile(uri);
    assert.ok(validate(vectors.base_product), `${uri}: ${JSON.stringify(validate.errors)}`);
  }
});

for (const uri of vectors.product_schemas) {
  test(`vectors validate as ${uri}`, async () => {
    const validate = await compile(uri);
    for (const v of vectors.vectors) {
      if (v.schemas && !v.schemas.includes(uri)) continue;
      const product = mergePatch(vectors.base_product, v.overrides);
      const ok = validate(product);
      assert.equal(
        ok,
        v.valid,
        `${v.id}: expected ${v.valid ? 'valid' : 'invalid'}${ok ? '' : ` — ${JSON.stringify(validate.errors)}`}`,
      );
    }
  });
}
