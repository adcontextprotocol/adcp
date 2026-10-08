const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const ROOT = path.join(__dirname, '..');
const SCHEMA_ROOT = path.join(ROOT, 'static/schemas/source');

function readSchema(uri) {
  assert.ok(uri.startsWith('/schemas/'), `Unexpected schema URI: ${uri}`);
  return JSON.parse(fs.readFileSync(path.join(SCHEMA_ROOT, uri.slice('/schemas/'.length)), 'utf8'));
}

async function compile(uri) {
  const ajv = new Ajv({ allErrors: true, strict: false, loadSchema: async (ref) => readSchema(ref) });
  addFormats(ajv);
  return ajv.compileAsync(readSchema(uri));
}

const REQUEST = '/schemas/media-buy/get-audience-overlap-request.json';
const RESPONSE = '/schemas/media-buy/get-audience-overlap-response.json';
const CAPABILITIES = '/schemas/protocol/get-adcp-capabilities-response.json';

const overlap = (extra = {}) => ({
  lower_bound: 2100000,
  upper_bound: 2400000,
  precision: 'approximate',
  as_of: '2026-10-08T12:00:00Z',
  ...extra,
});
const success = (comparisons) => ({ status: 'completed', audience_id: 'crm_customers', comparisons });
const request = (extra = {}) => ({
  account: { account_id: 'acct_12345' },
  audience_id: 'crm_customers',
  compare_to: ['site_visitors_30d'],
  ...extra,
});

test('request requires account, audience_id and compare_to, and rejects bad compare_to', async () => {
  const validate = await compile(REQUEST);
  assert.equal(validate(request()), true, JSON.stringify(validate.errors));
  for (const field of ['account', 'audience_id', 'compare_to']) {
    const { [field]: _omit, ...rest } = request();
    assert.equal(validate(rest), false, `${field} must be required`);
  }
  assert.equal(validate(request({ compare_to: [] })), false);
  assert.equal(validate(request({ compare_to: ['a', 'a'] })), false);
});

test('request is a read: no idempotency key and not marked as mutating', () => {
  const schema = readSchema(REQUEST);
  assert.equal(schema['x-mutates-state'], undefined);
  assert.equal(schema.properties.idempotency_key, undefined);
  assert.equal(schema.properties.compare_to.maxItems, undefined, 'the cap is seller-declared, not in the schema');
});

test('overlap reuses the shared audience-size object and forbids exact precision', async () => {
  const item = readSchema(RESPONSE).oneOf[0].properties.comparisons.items;
  assert.equal(item.properties.overlap.allOf[0].$ref, '/schemas/core/audience-size.json');
  const validate = await compile(RESPONSE);
  const ready = (o) => success([{ audience_id: 'site_visitors_30d', status: 'ready', overlap: o }]);
  assert.equal(validate(ready(overlap())), true, JSON.stringify(validate.errors));
  assert.equal(validate(ready(overlap({ precision: 'bucketed' }))), true);
  assert.equal(validate(ready(overlap({ precision: 'exact', upper_bound: 2100000 }))), false);
  assert.equal(validate(ready({ lower_bound: 1, precision: 'approximate' })), false, 'bounds are required');
});

test('comparison status governs whether overlap is present', async () => {
  const validate = await compile(RESPONSE);
  const one = (c) => success([{ audience_id: 'lapsed_buyers', ...c }]);
  assert.equal(validate(one({ status: 'ready' })), false, 'ready needs overlap');
  assert.equal(validate(one({ status: 'suppressed' })), true, JSON.stringify(validate.errors));
  assert.equal(validate(one({ status: 'not_ready' })), true);
  assert.equal(validate(one({ status: 'suppressed', overlap: overlap() })), false, 'suppressed carries no overlap');
  assert.equal(validate(one({ status: 'not_ready', overlap: overlap() })), false, 'not_ready carries no overlap');
});

test('response has no share fields and exactly one of success, error or submitted', async () => {
  const schema = readSchema(RESPONSE);
  const props = schema.oneOf[0].properties.comparisons.items.properties;
  assert.deepEqual(Object.keys(props).sort(), ['audience_id', 'overlap', 'status']);
  const validate = await compile(RESPONSE);
  const err = { errors: [{ code: 'RATE_LIMITED', message: 'Overlap budget spent.' }] };
  assert.equal(validate({ status: 'failed', ...err }), true, JSON.stringify(validate.errors));
  assert.equal(validate({ ...success([{ audience_id: 'a', status: 'suppressed' }]), ...err }), false);
  assert.equal(validate({ status: 'submitted', task_id: 'task_overlap_1' }), true, JSON.stringify(validate.errors));
  assert.equal(validate({ status: 'submitted', task_id: 'task_overlap_1', comparisons: [] }), false);
});

test('status enum mirrors the documented values', () => {
  assert.deepEqual(readSchema('/schemas/enums/audience-overlap-status.json').enum, ['ready', 'suppressed', 'not_ready']);
});

test('privacy MUSTs are stated in the response schema', () => {
  const text = readSchema(RESPONSE).description;
  for (const phrase of [
    'MUST NOT disclose an overlap below its declared minimum_overlap_size',
    'MUST NOT report overlap as exact',
    'seller-held secret',
    'stable for the same pair of memberships',
    'before evaluating any suppression rule',
    'calling principal and not only the account',
    'SHOULD also suppress',
    'treat an unknown comparison status as suppressed',
  ]) {
    assert.ok(text.includes(phrase), `missing: ${phrase}`);
  }
});

test('capability block is experimental and requires the experimental_features entry', async () => {
  const caps = readSchema(CAPABILITIES);
  const block = caps.properties.media_buy.properties.audience_targeting.properties.audience_overlap;
  assert.equal(block['x-status'], 'experimental');
  assert.deepEqual(block.required, ['max_comparisons', 'minimum_overlap_size']);
  assert.equal(block.properties.max_comparisons.maximum, undefined);

  const validate = await compile(CAPABILITIES);
  const base = (media_buy, extra = {}) => ({
    status: 'completed',
    adcp: { major_versions: [3] },
    supported_protocols: ['media_buy'],
    media_buy: media_buy,
    ...extra,
  });
  const targeting = (extra = {}) => ({
    audience_targeting: {
      supported_identifier_types: ['hashed_email'],
      minimum_audience_size: 1000,
      ...extra,
    },
  });
  const overlapCap = { audience_overlap: { max_comparisons: 5, minimum_overlap_size: 1000 } };
  validate(base(targeting(overlapCap), { experimental_features: ['media_buy.audience_overlap'] }));
  const errs = (validate.errors || []).map((e) => `${e.instancePath} ${e.message}`);
  assert.deepEqual(errs.filter((e) => /audience_overlap|experimental_features/.test(e)), [], errs.join('\n'));

  validate(base(targeting(overlapCap)));
  assert.ok(
    (validate.errors || []).some((e) => /experimental_features/.test(`${e.instancePath} ${e.params && e.params.missingProperty}`)),
    'declaring the block without experimental_features must fail'
  );
  validate(base(targeting({ audience_overlap: { max_comparisons: 0, minimum_overlap_size: 1000 } }), { experimental_features: ['media_buy.audience_overlap'] }));
  assert.ok((validate.errors || []).some((e) => /max_comparisons/.test(e.instancePath)), 'max_comparisons must be at least 1');
});

test('schemas are marked experimental and registered, and docs list the feature id', () => {
  for (const uri of [REQUEST, RESPONSE, '/schemas/enums/audience-overlap-status.json']) {
    assert.equal(readSchema(uri)['x-status'], 'experimental', `${uri} must be x-status: experimental`);
  }
  const index = readSchema('/schemas/index.json');
  assert.equal(index.schemas['media-buy'].tasks['get-audience-overlap'].request.$ref, REQUEST);
  assert.equal(index.schemas['media-buy'].tasks['get-audience-overlap'].response.$ref, RESPONSE);
  assert.equal(index.schemas.enums.schemas['audience-overlap-status'].$ref, '/schemas/enums/audience-overlap-status.json');
  const registry = fs.readFileSync(path.join(ROOT, 'docs/reference/experimental-status.mdx'), 'utf8');
  assert.match(registry, /\| `media_buy\.audience_overlap` \|/);
});
