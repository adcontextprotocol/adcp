const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const SCHEMA_ROOT = path.join(__dirname, '../static/schemas/source');

function readSchema(uri) {
  assert.ok(uri.startsWith('/schemas/'), `Unexpected schema URI: ${uri}`);
  return JSON.parse(fs.readFileSync(path.join(SCHEMA_ROOT, uri.slice('/schemas/'.length)), 'utf8'));
}

async function compile(uri) {
  const ajv = new Ajv({ allErrors: true, strict: false, loadSchema: async (ref) => readSchema(ref) });
  addFormats(ajv);
  return ajv.compileAsync(readSchema(uri));
}

const size = {
  lower_bound: 14000000,
  upper_bound: 16500000,
  precision: 'approximate',
  as_of: '2026-10-08T12:00:00Z',
};

const response = (audience) => ({ status: 'completed', audiences: [{ audience_id: 'crm_customers', action: 'updated', ...audience }] });

function audienceResultSchema() {
  const success = readSchema('/schemas/media-buy/sync-audiences-response.json').oneOf[0];
  return success.properties.audiences.items;
}

test('audience size is one shared core schema referenced by both size fields', () => {
  const item = audienceResultSchema();
  assert.equal(item.properties.audience_size.$ref, '/schemas/core/audience-size.json');
  assert.equal(item.properties.targetable_size.$ref, '/schemas/core/audience-size.json');
  assert.equal(item.properties.match_rate_basis.$ref, '/schemas/enums/audience-match-rate-basis.json');
  const core = readSchema('/schemas/core/audience-size.json');
  assert.deepEqual(core.required, ['lower_bound', 'upper_bound', 'precision']);
  assert.equal(core.properties.precision.$ref, '/schemas/enums/audience-size-precision.json');
  assert.deepEqual(readSchema('/schemas/enums/audience-size-precision.json').enum, ['exact', 'approximate', 'bucketed']);
  assert.deepEqual(readSchema('/schemas/enums/audience-match-rate-basis.json').enum, ['platform_reported', 'derived']);
});

test('new fields are optional and existing field types and requirements are unchanged', () => {
  const item = audienceResultSchema();
  assert.deepEqual(item.required, ['audience_id', 'action']);
  assert.equal(item.properties.matched_count.type, 'integer');
  assert.equal(item.properties.matched_count.minimum, 0);
  assert.equal(item.properties.effective_match_rate.type, 'number');
  assert.equal(item.properties.effective_match_rate.maximum, 1);
});

test('the audience size object is registered in the schema index', () => {
  const index = readSchema('/schemas/index.json');
  assert.equal(index.schemas.core.schemas['audience-size'].$ref, '/schemas/core/audience-size.json');
  assert.equal(
    index.schemas.enums.schemas['audience-size-precision'].$ref,
    '/schemas/enums/audience-size-precision.json'
  );
  assert.equal(
    index.schemas.enums.schemas['audience-match-rate-basis'].$ref,
    '/schemas/enums/audience-match-rate-basis.json'
  );
});

test('sync_audiences results accept the size fields', async () => {
  const validate = await compile('/schemas/media-buy/sync-audiences-response.json');
  const full = response({
    status: 'ready',
    audience_size: size,
    targetable_size: { lower_bound: 9000000, upper_bound: 11000000, precision: 'bucketed', as_of: '2026-10-08T12:00:00Z' },
    effective_match_rate: 0.42,
    match_rate_basis: 'platform_reported',
  });
  assert.equal(validate(full), true, JSON.stringify(validate.errors));
  for (const precision of ['exact', 'approximate', 'bucketed']) {
    const body = response({ status: 'ready', audience_size: { lower_bound: 5, upper_bound: 5, precision } });
    assert.equal(validate(body), true, `${precision}: ${JSON.stringify(validate.errors)}`);
  }
  for (const match_rate_basis of ['platform_reported', 'derived']) {
    const body = response({ status: 'ready', effective_match_rate: 0.5, match_rate_basis });
    assert.equal(validate(body), true, `${match_rate_basis}: ${JSON.stringify(validate.errors)}`);
  }
});

test('a result that reports size without a matched count or match rate is valid', async () => {
  const validate = await compile('/schemas/media-buy/sync-audiences-response.json');
  const body = response({ status: 'ready', audience_size: size });
  assert.equal('matched_count' in body.audiences[0], false);
  assert.equal(validate(body), true, JSON.stringify(validate.errors));
});

test('results with only the pre-3.3 fields stay valid', async () => {
  const validate = await compile('/schemas/media-buy/sync-audiences-response.json');
  const body = response({
    status: 'ready',
    uploaded_count: 25000,
    total_uploaded_count: 25000,
    matched_count: 18750,
    effective_match_rate: 0.75,
  });
  assert.equal(validate(body), true, JSON.stringify(validate.errors));
  assert.equal(validate(response({ action: 'deleted' })), true, JSON.stringify(validate.errors));
});

test('malformed size objects are rejected', async () => {
  const validate = await compile('/schemas/media-buy/sync-audiences-response.json');
  const { lower_bound, ...noLower } = size;
  const { upper_bound, ...noUpper } = size;
  const { precision, ...noPrecision } = size;
  for (const bad of [
    noLower,
    noUpper,
    noPrecision,
    { ...size, lower_bound: -1 },
    { ...size, upper_bound: -1 },
    { ...size, lower_bound: 1.5 },
    { ...size, upper_bound: '16500000' },
    { ...size, precision: 'estimated' },
    { ...size, as_of: 'yesterday' },
    14000000,
    null,
  ]) {
    for (const field of ['audience_size', 'targetable_size']) {
      const body = response({ status: 'ready', [field]: bad });
      assert.equal(validate(body), false, `${field}: ${JSON.stringify(bad)}`);
    }
  }
  assert.equal(validate(response({ status: 'ready', match_rate_basis: 'estimated' })), false);
  assert.equal(validate(response({ status: 'ready', match_rate_basis: null })), false);
});

test('size and match-rate semantics are stated in the field descriptions', () => {
  const item = audienceResultSchema();
  for (const field of ['matched_count', 'effective_match_rate']) {
    const description = item.properties[field].description;
    assert.match(description, /MAY be absent/, field);
    assert.match(description, /MUST NOT read an absent/, field);
  }
  for (const field of ['audience_size', 'targetable_size']) {
    const description = item.properties[field].description;
    assert.match(description, /MUST NOT disclose a size below its minimum/, field);
    assert.match(description, /too_small/, field);
  }
  const core = readSchema('/schemas/core/audience-size.json').description;
  assert.match(core, /MUST equal upper_bound when precision is 'exact'/);
  assert.match(core, /less than or equal to upper_bound/);
});
