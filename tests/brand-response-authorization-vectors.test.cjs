const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it, before } = require('node:test');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');
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

const SCHEMA_ROOT = path.join(__dirname, '..', 'static', 'schemas', 'source');

function readSchema(uri) {
  assert.match(uri, /^\/schemas\//);
  return JSON.parse(fs.readFileSync(path.join(SCHEMA_ROOT, uri.slice('/schemas/'.length)), 'utf8'));
}

async function compile(uri) {
  const ajv = new Ajv({
    allErrors: true,
    strict: false,
    discriminator: true,
    loadSchema: async (ref) => readSchema(ref),
  });
  addFormats(ajv);
  return ajv.compileAsync(readSchema(uri));
}

describe('brand response authorization cross-check vectors', () => {
  let validateBrandJson;
  let validateResult;

  before(async () => {
    [validateBrandJson, validateResult] = await Promise.all([
      compile('/schemas/brand.json'),
      compile('/schemas/core/brand-response-authorization-result.json'),
    ]);
  });

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

  it('rejects a string key_ops lookalike', () => {
    const trusted = vectors.cases.find((vector) => vector.name === 'canonical-equivalent-agent-url-is-trusted');
    const input = JSON.parse(JSON.stringify(trusted.input));
    const [jwks] = Object.values(input.jwks_by_uri);
    jwks.keys[0].key_ops = 'verify';
    assert.equal(assessBrandResponseAuthorization(input).reason, 'key_purpose_invalid');
  });

  it('uses house agents only when the matched inline brand has no override', () => {
    const trusted = vectors.cases.find((vector) => vector.name === 'inline-brand-agent-is-trusted');
    const input = JSON.parse(JSON.stringify(trusted.input));
    input.brand_json.house.agents = input.brand_json.brands[0].agents;
    delete input.brand_json.brands[0].agents;
    assert.equal(validateBrandJson(input.brand_json), true, JSON.stringify(validateBrandJson.errors));
    assert.deepEqual(assessBrandResponseAuthorization(input), trusted.expected);
  });

  it('rejects ambiguous inline brand-domain matches', () => {
    const trusted = vectors.cases.find((vector) => vector.name === 'inline-brand-agent-is-trusted');
    const input = JSON.parse(JSON.stringify(trusted.input));
    input.brand_json.brands.push({
      id: 'nova_duplicate',
      url: 'https://nova.example',
      names: [{ en: 'Nova Duplicate' }],
    });
    assert.equal(validateBrandJson(input.brand_json), true, JSON.stringify(validateBrandJson.errors));
    assert.equal(
      assessBrandResponseAuthorization(input).reason,
      'agent_authorization_ambiguous',
    );
  });

  for (const vector of vectors.cases) {
    it(vector.name, () => {
      if (vector.input.brand_json !== null) {
        assert.equal(
          validateBrandJson(vector.input.brand_json),
          true,
          JSON.stringify(validateBrandJson.errors),
        );
      }
      const actual = assessBrandResponseAuthorization(vector.input);
      assert.deepEqual(actual, vector.expected);
      assert.equal(validateResult(actual), true, JSON.stringify(validateResult.errors));
    });
  }
});
